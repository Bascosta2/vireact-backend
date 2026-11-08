/**
 * Autonomous research ingest.
 *
 *   approved/<date>/*.jsonl (GitHub, read-only token)
 *     -> hard gates (schema, review score, sources, confidence, freshness, sanitizer)
 *     -> dedupe (id, url+title, embedding cosine >= 0.92 against the knowledge base and the batch)
 *     -> caps (RESEARCH_DAILY_CAP per UTC day, RESEARCH_MAX_SHARE of all knowledge-base docs)
 *     -> insert into knowledgebases with metadata.origin "research"
 *     -> retrieval health check (before/after), automatic rollback of the whole batch on failure
 *   retire/<date>.jsonl -> remove those research docs (origin "research" only)
 *
 * Never modifies or deletes a knowledge-base doc without metadata.origin === "research".
 * Dry run by default: nothing is written unless `apply` is true.
 * Every external dependency is injectable for tests.
 */
import crypto from 'node:crypto';
import { KnowledgeBase } from '../../model/knowledge-base.model.js';
import { ResearchCandidate, RESEARCH_STATUS } from '../../model/research-candidate.model.js';
import { ResearchEvalRun } from '../../model/research-eval-run.model.js';
import { withAiContext } from '../../lib/ai-tracking.js';
import { researchConfig, checkCandidate, buildResearchContent, knowledgeDocFor, remainingShare } from './gates.js';
import { createGithubReader, parseJsonl } from './github.js';
import { embedEvalQueries, takeSnapshot, evaluateSnapshots, defaultVectorSearch } from './retrieval-eval.js';

export const RESEARCH_ORIGIN = 'research';
/** Filter every delete goes through: research docs only. */
export const researchOnly = (extra = {}) => ({ ...extra, 'metadata.origin': RESEARCH_ORIGIN });

const cosine = (a, b) => {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

/** Atlas cosine vectorSearchScore is (1 + cos) / 2. */
const atlasScoreToCosine = (score) => 2 * Number(score) - 1;

const startOfUtcDay = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

const defaultDeps = async () => {
    const { embedTexts, nearestKnowledge } = await import('../kb-research/research.service.js');
    const { captureServerEvent } = await import('../../lib/analytics.js');
    return {
        reader: null,
        embed: embedTexts,
        nearest: nearestKnowledge,
        vectorSearch: defaultVectorSearch,
        capture: captureServerEvent,
    };
};

let running = false;
export const isIngestRunning = () => running;

/**
 * @param {object} [options]
 * @param {boolean} [options.apply] write changes (default false: dry run)
 * @param {string} [options.trigger] 'script' | 'qstash' | 'test'
 * @param {(line: string) => void} [options.log]
 * @param {Date} [options.now]
 * @param {object} [options.env]
 * @param {object} [deps] reader, embed, nearest, vectorSearch, capture
 */
export const runResearchIngest = async (options = {}, deps = {}) => {
    const runId = options.runId || `rsi_${new Date().toISOString().slice(0, 10)}_${crypto.randomBytes(3).toString('hex')}`;
    return withAiContext(
        { feature: 'research_ingest', distinctId: 'system:research-ingest', traceId: runId },
        () => runImpl({ ...options, runId }, deps)
    );
};

const runImpl = async (options, injected) => {
    const { apply = false, trigger = 'script', log = () => {}, now = new Date(), env = process.env, runId } = options;
    const config = researchConfig(env);
    if (apply && !config.enabled) {
        log('RESEARCH_INGEST_ENABLED is not "true": refusing to write.');
        return { runId, skipped: 'disabled' };
    }
    if (apply && running) {
        log('Another research ingest is already running.');
        return { runId, skipped: 'already_running' };
    }

    const d = { ...(await defaultDeps()), ...injected };
    const reader = d.reader || createGithubReader({ repo: config.repo, branch: config.branch, token: env.RESEARCH_REPO_TOKEN });

    const summary = {
        runId,
        dryRun: !apply,
        batches: [],
        pulled: 0,
        alreadySeen: 0,
        ingested: 0,
        waiting: 0,
        rejected: 0,
        invalid: 0,
        duplicates: 0,
        rejectedByReason: {},
        rolledBack: 0,
        retired: 0,
        evalResult: null,
        totalResearchDocs: null,
        researchShare: null,
    };
    const bump = (reason) => {
        const key = reason.replace(/\d+(\.\d+)?/g, 'N').slice(0, 80);
        summary.rejectedByReason[key] = (summary.rejectedByReason[key] || 0) + 1;
    };

    let run = null;
    if (apply) {
        running = true;
        run = await ResearchEvalRun.create({ runId, trigger, dryRun: false, status: 'running', startedAt: now });
    }

    try {
        // ---- 1. Which batches to read: the last processed one again (idempotent) and anything newer.
        const lastRun = await ResearchEvalRun.findOne({ dryRun: false, status: { $in: ['completed', 'rolled_back'] }, runId: { $ne: runId } })
            .sort({ startedAt: -1 })
            .lean();
        const lastBatch = [...(lastRun?.batches || [])].sort().pop() || '';
        const lastRetire = [...(lastRun?.retireFiles || [])].sort().pop() || '';
        const batches = (await reader.listApprovedBatches()).filter((b) => b >= lastBatch);
        summary.batches = batches;
        log(`Batches to read: ${batches.length ? batches.join(', ') : 'none'}${lastBatch ? ` (last processed ${lastBatch})` : ''}`);

        // ---- 2. Parse + gates.
        const records = []; // new ResearchCandidate docs to save
        const passing = []; // { candidate, batch, sourceFile, record }
        const seenThisRun = new Set();
        for (const batch of batches) {
            for (const file of await reader.readBatch(batch)) {
                // Lines without a usable id get a stable synthetic one (file + line) so reruns skip them too.
                const lines = parseJsonl(file.text).map((line) => {
                    const rawId = typeof line.value?.id === 'string' ? line.value.id.slice(0, 128) : '';
                    return { ...line, id: rawId || `invalid:${crypto.createHash('sha256').update(`${file.path}:${line.line}`).digest('hex')}` };
                });
                const existing = new Set((await ResearchCandidate.find({ id: { $in: lines.map((l) => l.id) } }, { id: 1 }).lean()).map((c) => c.id));
                for (const line of lines) {
                    summary.pulled++;
                    const { id } = line;
                    if (existing.has(id) || seenThisRun.has(id)) {
                        summary.alreadySeen++;
                        continue;
                    }
                    seenThisRun.add(id);
                    const base = { id, batch, sourceFile: file.path, runId, importedAt: now };
                    if (line.error) {
                        summary.invalid++;
                        bump(line.error);
                        records.push({ ...base, status: RESEARCH_STATUS.INVALID, rejectReason: line.error });
                        continue;
                    }
                    const result = checkCandidate(line.value, { now, config });
                    if (!result.ok) {
                        summary[result.status === 'invalid' ? 'invalid' : 'rejected']++;
                        bump(result.reason);
                        records.push({ ...base, ...pickFields(line.value), status: result.status, rejectReason: result.reason });
                        continue;
                    }
                    const c = result.candidate;
                    const record = { ...base, ...pickFields(c), reviewScore: Number(c.review.score), status: RESEARCH_STATUS.IMPORTED };
                    records.push(record);
                    passing.push({ candidate: c, batch, record });
                }
            }
        }

        // ---- 3. Exact duplicates: same first evidence URL + title as something already ingested.
        if (passing.length) {
            const urls = passing.map((p) => p.candidate.evidence[0].url);
            const prior = await ResearchCandidate.find(
                { status: { $in: [RESEARCH_STATUS.INGESTED, RESEARCH_STATUS.IMPORTED] }, 'evidence.0.url': { $in: urls } },
                { id: 1, title: 1, 'evidence.url': 1 }
            ).lean();
            const key = (url, title) => `${String(url).toLowerCase()}|${String(title).toLowerCase().trim()}`;
            const priorKeys = new Map(prior.map((p) => [key(p.evidence?.[0]?.url, p.title), p.id]));
            const batchKeys = new Map();
            for (const p of [...passing]) {
                const k = key(p.candidate.evidence[0].url, p.candidate.title);
                const match = priorKeys.get(k) || batchKeys.get(k);
                if (match) {
                    markDuplicate(p, `url_title:${match}`, summary);
                    passing.splice(passing.indexOf(p), 1);
                } else batchKeys.set(k, p.candidate.id);
            }
        }

        // ---- 4. Backlog: items that passed earlier but waited on a cap.
        const backlog = await ResearchCandidate.find({ status: RESEARCH_STATUS.IMPORTED, id: { $nin: [...seenThisRun] } }).lean();
        const pool = [
            ...passing.map((p) => ({ ...p, fromBacklog: false })),
            ...backlog.map((b) => ({ candidate: { ...b, review: b.review || { score: b.reviewScore } }, batch: b.batch, record: null, fromBacklog: true })),
        ].sort((a, b) => Number(b.candidate.review?.score || 0) - Number(a.candidate.review?.score || 0));

        // ---- 5. Embedding dedupe against the batch and the knowledge base.
        const contents = pool.map((p) => buildResearchContent(p.candidate));
        const embeddings = pool.length ? await d.embed(contents) : [];
        const unique = [];
        for (let i = 0; i < pool.length; i++) {
            const p = pool[i];
            p.content = contents[i];
            p.embedding = embeddings[i];
            if (!Array.isArray(p.embedding) || !p.embedding.length) {
                setOutcome(p, RESEARCH_STATUS.REJECTED, 'embedding failed', summary, bump);
                continue;
            }
            const twin = unique.find((u) => cosine(u.embedding, p.embedding) >= config.duplicateCosine);
            if (twin) {
                markDuplicate(p, `batch:${twin.candidate.id}`, summary);
                continue;
            }
            const nearest = await d.nearest(p.embedding);
            if (nearest && atlasScoreToCosine(nearest.score) >= config.duplicateCosine) {
                markDuplicate(p, `kb:${nearest.id}@${atlasScoreToCosine(nearest.score).toFixed(3)}`, summary);
                continue;
            }
            unique.push(p);
        }

        // ---- 6. Caps.
        const ingestedToday = await ResearchCandidate.countDocuments({ status: RESEARCH_STATUS.INGESTED, ingestedAt: { $gte: startOfUtcDay(now) } });
        const totalDocs = await KnowledgeBase.countDocuments({});
        const researchDocs = await KnowledgeBase.countDocuments(researchOnly());
        const dailyRemaining = Math.max(0, config.dailyCap - ingestedToday);
        const shareRemaining = remainingShare({ totalDocs, researchDocs, maxShare: config.maxShare });
        const allowed = Math.min(dailyRemaining, shareRemaining);
        const toIngest = unique.slice(0, allowed);
        const waiting = unique.slice(allowed);
        for (const p of waiting) {
            const why = dailyRemaining <= shareRemaining ? 'waiting: daily cap' : 'waiting: max research share';
            if (p.record) p.record.rejectReason = why;
            p.waitReason = why;
        }
        summary.waiting = waiting.length;
        if (waiting.length) log(`${waiting.length} item(s) wait for the next run (${waiting[0].waitReason}; daily left ${dailyRemaining}, share left ${shareRemaining}).`);

        if (!apply) {
            summary.ingested = toIngest.length;
            summary.totalResearchDocs = researchDocs;
            summary.researchShare = totalDocs ? researchDocs / totalDocs : 0;
            summary.wouldIngest = toIngest.map((p) => ({ id: p.candidate.id, title: p.candidate.title, score: p.candidate.review?.score }));
            log(`Dry run: would ingest ${toIngest.length}, wait ${waiting.length}, reject ${summary.rejected}, invalid ${summary.invalid}, duplicates ${summary.duplicates}.`);
            return { runId, summary };
        }

        // ---- 7. Save candidate records (new ones), then backlog status changes.
        if (records.length) await ResearchCandidate.insertMany(records, { ordered: false }).catch((error) => {
            if (error?.code !== 11000 && !error?.writeErrors) throw error;
        });
        for (const p of pool.filter((x) => x.fromBacklog && x.outcome)) {
            await ResearchCandidate.updateOne({ id: p.candidate.id, status: RESEARCH_STATUS.IMPORTED }, { $set: { status: p.outcome, rejectReason: p.reason || '', duplicateOf: p.duplicateOf || '' } });
        }
        for (const p of waiting.filter((x) => x.fromBacklog)) {
            await ResearchCandidate.updateOne({ id: p.candidate.id }, { $set: { rejectReason: p.waitReason } });
        }

        // ---- 8. Ingest + health check.
        let evalResult = null;
        if (toIngest.length) {
            const vectors = await embedEvalQueries(d.embed);
            const before = await takeSnapshot({ vectors, vectorSearch: d.vectorSearch });
            if (!before.ok) {
                evalResult = { passed: false, reasons: [`retrieval unhealthy before ingest: ${before.error}`] };
                log(`Skipping ingest: ${before.error}. Items stay queued.`);
                await ResearchCandidate.updateMany({ id: { $in: toIngest.map((p) => p.candidate.id) } }, { $set: { rejectReason: 'waiting: retrieval unhealthy' } });
                summary.waiting += toIngest.length;
            } else {
                const docs = toIngest.map((p) => knowledgeDocFor(p.candidate, { batch: p.batch, embedding: p.embedding, now }));
                const inserted = await KnowledgeBase.insertMany(docs);
                const kbIdsByResearchId = new Map(inserted.map((doc) => [doc.metadata.researchId, doc._id]));
                for (const p of toIngest) {
                    await ResearchCandidate.updateOne(
                        { id: p.candidate.id },
                        { $set: { status: RESEARCH_STATUS.INGESTED, kbIds: [kbIdsByResearchId.get(p.candidate.id)], ingestedAt: now, rejectReason: '', runId } }
                    );
                }
                summary.ingested = inserted.length;
                log(`Ingested ${inserted.length} research doc(s). Running retrieval health check.`);

                const after = await takeSnapshot({ vectors, vectorSearch: d.vectorSearch });
                evalResult = evaluateSnapshots(before, after);
                run.before = before;
                run.after = after;
                if (!evalResult.passed) {
                    const kbIds = inserted.map((doc) => doc._id);
                    await KnowledgeBase.deleteMany(researchOnly({ _id: { $in: kbIds } }));
                    await ResearchCandidate.updateMany(
                        { id: { $in: toIngest.map((p) => p.candidate.id) } },
                        { $set: { status: RESEARCH_STATUS.ROLLED_BACK, kbIds: [], rejectReason: `rolled back: ${evalResult.reasons.join('; ')}`.slice(0, 500) } }
                    );
                    summary.rolledBack = inserted.length;
                    summary.ingested = 0;
                    log(`Rolled back the batch: ${evalResult.reasons.join('; ')}`);
                }
            }
        }
        summary.evalResult = evalResult;

        // ---- 9. Retire.
        const retireFiles = (await reader.listRetireFiles()).filter((f) => f.date >= lastRetire);
        summary.retireFiles = retireFiles.map((f) => f.date);
        for (const file of retireFiles) {
            for (const line of parseJsonl(await reader.readText(file.path))) {
                const id = typeof line.value?.id === 'string' ? line.value.id : '';
                if (!id) continue;
                const candidate = await ResearchCandidate.findOne({ id, status: { $in: [RESEARCH_STATUS.INGESTED, RESEARCH_STATUS.IMPORTED] } });
                if (!candidate) continue;
                await KnowledgeBase.deleteMany(researchOnly({ 'metadata.researchId': id }));
                candidate.status = RESEARCH_STATUS.RETIRED;
                candidate.kbIds = [];
                candidate.retiredAt = now;
                candidate.retireReason = String(line.value.reason || '').slice(0, 500);
                await candidate.save();
                summary.retired++;
            }
        }

        // ---- 10. Report.
        const totalAfter = await KnowledgeBase.countDocuments({});
        summary.totalResearchDocs = await KnowledgeBase.countDocuments(researchOnly());
        summary.researchShare = totalAfter ? Math.round((summary.totalResearchDocs / totalAfter) * 10000) / 10000 : 0;
        Object.assign(run, {
            status: summary.rolledBack ? 'rolled_back' : 'completed',
            batches,
            retireFiles: summary.retireFiles,
            summary,
            evalResult: evalResult || { passed: null, reasons: [] },
            finishedAt: new Date(),
        });
        await run.save();
        log(`Done: ${JSON.stringify(summary)}`);
        try {
            d.capture?.('system:research-ingest', 'research_batch_processed', { ...summary, rejectedByReason: JSON.stringify(summary.rejectedByReason), $process_person_profile: false });
        } catch {
            /* analytics must never fail the run */
        }
        return { runId, summary };
    } catch (error) {
        if (run) {
            run.status = 'failed';
            run.error = String(error?.message || error).slice(0, 1000);
            run.summary = summary;
            run.finishedAt = new Date();
            await run.save().catch(() => {});
        }
        throw error;
    } finally {
        if (apply) running = false;
    }
};

const FIELDS = ['run_date', 'type', 'title', 'insight', 'actionable_rule', 'example', 'topics', 'platforms', 'niches', 'metrics', 'evidence', 'source_tier', 'confidence', 'freshness', 'agent_notes', 'review'];

/** Only known fields, each type-checked loosely, so a malformed line can still be recorded. */
const pickFields = (value) => {
    const out = {};
    if (!value || typeof value !== 'object') return out;
    for (const key of FIELDS) {
        const v = value[key];
        if (v === undefined || v === null) continue;
        if (['topics', 'platforms', 'niches'].includes(key)) out[key] = Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 20) : undefined;
        else if (key === 'evidence') out[key] = Array.isArray(v) ? v.filter((e) => e && typeof e === 'object').slice(0, 10) : undefined;
        else if (key === 'metrics') out[key] = Array.isArray(v) ? v.slice(0, 20) : undefined;
        else if (['source_tier', 'confidence'].includes(key)) out[key] = Number.isFinite(Number(v)) ? Number(v) : undefined;
        else if (key === 'review') out[key] = typeof v === 'object' ? v : undefined;
        else out[key] = String(v).slice(0, 2000);
    }
    return out;
};

const setOutcome = (p, status, reason, summary, bump) => {
    p.outcome = status;
    p.reason = reason;
    if (p.record) Object.assign(p.record, { status, rejectReason: reason });
    if (status === RESEARCH_STATUS.REJECTED) {
        summary.rejected++;
        bump?.(reason);
    }
};

const markDuplicate = (p, duplicateOf, summary) => {
    p.outcome = RESEARCH_STATUS.DUPLICATE;
    p.duplicateOf = duplicateOf;
    if (p.record) Object.assign(p.record, { status: RESEARCH_STATUS.DUPLICATE, duplicateOf, rejectReason: 'duplicate' });
    summary.duplicates++;
};

// ---------------------------------------------------------------------------------------------
// Removal (scripts/research/remove-batch.js)
// ---------------------------------------------------------------------------------------------

/**
 * Remove research docs from the knowledge base: one batch, or all of them.
 * Refuses anything without metadata.origin "research" by construction (the filter always includes it).
 */
export const removeResearch = async ({ batch, all = false, apply = false }) => {
    if (!all && !/^\d{4}-\d{2}-\d{2}$/.test(batch || '')) throw new Error('pass --batch YYYY-MM-DD or --all-research');
    const filter = researchOnly(all ? {} : { 'metadata.researchBatch': batch });
    const count = await KnowledgeBase.countDocuments(filter);
    if (!apply) return { dryRun: true, wouldRemove: count };
    const ids = (await KnowledgeBase.find(filter, { 'metadata.researchId': 1 }).lean()).map((d) => d.metadata?.researchId).filter(Boolean);
    const { deletedCount } = await KnowledgeBase.deleteMany(filter);
    await ResearchCandidate.updateMany(
        { id: { $in: ids }, status: RESEARCH_STATUS.INGESTED },
        { $set: { status: RESEARCH_STATUS.ROLLED_BACK, kbIds: [], rejectReason: all ? 'removed: all research' : `removed: batch ${batch}` } }
    );
    return { dryRun: false, removed: deletedCount };
};

// ---------------------------------------------------------------------------------------------
// Stats (admin)
// ---------------------------------------------------------------------------------------------

export const getResearchStats = async () => {
    const [byStatus, totalDocs, researchDocs, runs] = await Promise.all([
        ResearchCandidate.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
        KnowledgeBase.estimatedDocumentCount(),
        KnowledgeBase.countDocuments(researchOnly()),
        ResearchEvalRun.find({ dryRun: false }, { before: 0, after: 0 }).sort({ startedAt: -1 }).limit(10).lean(),
    ]);
    const config = researchConfig();
    return {
        enabled: config.enabled,
        limits: { minScore: config.minScore, dailyCap: config.dailyCap, maxShare: config.maxShare, retrievalCap: Number(process.env.RESEARCH_RETRIEVAL_CAP || 4) },
        candidates: Object.fromEntries(byStatus.map((s) => [s._id, s.n])),
        knowledgeBase: { totalDocs, researchDocs, researchShare: totalDocs ? researchDocs / totalDocs : 0 },
        recentRuns: runs.map((r) => ({
            runId: r.runId,
            status: r.status,
            trigger: r.trigger,
            startedAt: r.startedAt,
            finishedAt: r.finishedAt,
            batches: r.batches,
            summary: r.summary,
            evalResult: r.evalResult,
            error: r.error || undefined,
        })),
    };
};
