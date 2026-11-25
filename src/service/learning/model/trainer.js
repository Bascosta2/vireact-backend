/**
 * Trains the matrix engine on everything labelled so far (docs/learning-engine/PLAN.md, section 16).
 *
 * Rows (one per video with a settled result):
 *   label  y = ln((views + 1) / (baseline + 1)), capped at ±ln 50 (OUTLIER_LOG). The baseline is the creator's
 *          median of their OTHER settled videos (leave-one-out, at least 3), so a video never sets its own bar.
 *          Users' videos fall back to the follower-based estimate when they have too few results.
 *   weight source (provider / verified 1.0, user-typed 0.6) x recency (half-life LEARNING_HALF_LIFE_DAYS, 120)
 *          then capped per creator (CREATOR_WEIGHT_CAP) so one prolific account cannot dominate.
 *   group  the creator: the engine compares videos within the same creator.
 *   x      VideoFeatures.features + niche / format / hook / language + how trendy the sound was when posted.
 * Comment intents are never inputs (they happen after posting).
 *
 * The engine runs in a worker thread; results are stored as a LearningModel (status 'candidate'). Nothing is
 * served to users from here: serving needs the promotion gates on users' own results (section 16.6).
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { LearningModel, OutcomeSnapshot, SocialVideo, VideoFeatures } from '../../../model/learning.model.js';
import { baselineFor, median, outcomeAtHorizon } from '../labels.js';
import { OUTLIER_LOG } from '../deep-features.js';
import { buildSoundIndex, usesBefore } from '../trends.js';
import { runEngine } from './engine.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const CREATOR_WEIGHT_CAP = 8;
const SOURCE_WEIGHT = { provider: 1, api_verified: 1, dataset: 0.5, user_reported: 0.6 };
const KEEP_MODELS = 30;
export const MODEL_KIND = 'matrix_engine';

const cap = (y) => Math.max(-OUTLIER_LOG, Math.min(OUTLIER_LOG, y));
const label = (views, baseline) => cap(Math.log((views + 1) / (baseline + 1)));
export const recencyWeight = (postedAt, now, halfLifeDays) => {
    const t = new Date(postedAt).getTime();
    if (!Number.isFinite(t) || !(halfLifeDays > 0)) return 1;
    return Math.max(0.05, 0.5 ** (Math.max(0, now - t) / DAY_MS / halfLifeDays));
};

/** Scales each creator's weights so their total is at most `limit`. */
export const capCreatorWeights = (rows, limit = CREATOR_WEIGHT_CAP) => {
    const totals = new Map();
    for (const r of rows) totals.set(r.group, (totals.get(r.group) ?? 0) + r.w);
    return rows.map((r) => {
        const t = totals.get(r.group);
        return t > limit ? { ...r, w: (r.w * limit) / t } : r;
    });
};

const extraFeatures = (vf) => ({
    ...(vf.features ?? {}),
    ...(vf.niche ? { niche: vf.niche } : {}),
    ...(vf.format ? { format: vf.format } : {}),
    ...(vf.hookPattern ? { hookPattern: vf.hookPattern } : {}),
});

/** Public videos: settled readings, leave-one-out creator medians. */
export const socialRows = async ({ now = Date.now(), halfLifeDays = 120 } = {}) => {
    // Instagram Reels are collected but not trained on yet: the model has no platform feature, and Reels
    // views (a different counter, a different feed) must not shift the TikTok-calibrated baselines.
    const videos = await SocialVideo.find({ platform: { $ne: 'instagram' }, 'latest.views': { $ne: null }, postedAt: { $ne: null }, creatorId: { $ne: null } })
        .select('_id creatorId latest postedAt soundId soundTitle language').lean();
    const soundIndex = buildSoundIndex(videos);
    const settled = videos.filter((v) => new Date(v.latest.at ?? now).getTime() - new Date(v.postedAt).getTime() >= 7 * DAY_MS);
    const byCreator = new Map();
    for (const v of settled) {
        const k = String(v.creatorId);
        if (!byCreator.has(k)) byCreator.set(k, []);
        byCreator.get(k).push(v);
    }
    const feats = new Map();
    const ids = settled.map((v) => v._id);
    for (let i = 0; i < ids.length; i += 5000) {
        const chunk = await VideoFeatures.find({ subjectType: 'social', subjectId: { $in: ids.slice(i, i + 5000) } }).select('subjectId features niche format hookPattern').lean();
        for (const f of chunk) feats.set(String(f.subjectId), f);
    }
    const rows = [];
    for (const [creator, list] of byCreator) {
        if (list.length < 4) continue;
        for (const v of list) {
            const others = list.filter((o) => o !== v).map((o) => o.latest.views);
            const base = median(others);
            const vf = feats.get(String(v._id));
            if (!vf || base == null) continue;
            rows.push({
                y: label(v.latest.views, base),
                w: SOURCE_WEIGHT.provider * recencyWeight(v.postedAt, now, halfLifeDays),
                group: `social:${creator}`,
                features: {
                    ...extraFeatures(vf),
                    ...(v.language ? { language: v.language } : {}),
                    soundUsesPrior14d: v.soundId ? usesBefore(soundIndex, v.soundId, new Date(v.postedAt).getTime()) : 0,
                },
                source: 'social',
            });
        }
    }
    return rows;
};

/** Users' own uploads with a settled real result. */
export const userRows = async ({ now = Date.now(), halfLifeDays = 120 } = {}) => {
    const vfs = await VideoFeatures.find({ subjectType: 'video' }).select('subjectId creatorKey features niche format hookPattern followers postedAt').lean();
    if (!vfs.length) return [];
    const snaps = await OutcomeSnapshot.find({ subjectType: 'video', subjectId: { $in: vfs.map((v) => v.subjectId) } }).lean();
    const bySubject = new Map();
    for (const s of snaps) { const k = String(s.subjectId); if (!bySubject.has(k)) bySubject.set(k, []); bySubject.get(k).push(s); }
    const results = vfs.map((vf) => ({ vf, out: outcomeAtHorizon(bySubject.get(String(vf.subjectId)) ?? []) })).filter((r) => r.out && r.vf.creatorKey);
    const byCreator = new Map();
    for (const r of results) { if (!byCreator.has(r.vf.creatorKey)) byCreator.set(r.vf.creatorKey, []); byCreator.get(r.vf.creatorKey).push(r); }
    const rows = [];
    for (const [creator, list] of byCreator) {
        for (const r of list) {
            const base = baselineFor({ otherViews: list.filter((o) => o !== r).map((o) => o.out.views), followers: r.vf.followers });
            if (!base) continue;
            rows.push({
                y: label(r.out.views, base.views),
                w: (SOURCE_WEIGHT[r.out.source] ?? 0.6) * recencyWeight(r.vf.postedAt, now, halfLifeDays),
                group: creator,
                features: extraFeatures(r.vf),
                source: 'video',
            });
        }
    }
    return rows;
};

/** Runs the engine in a worker thread (10 minute limit). */
export const runEngineInWorker = (rows, opts = {}, { timeoutMs = 10 * 60_000 } = {}) => new Promise((resolve, reject) => {
    const worker = new Worker(fileURLToPath(new URL('./engine-worker.js', import.meta.url)), { workerData: { rows, opts } });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('matrix engine timed out')); }, timeoutMs);
    worker.once('message', (msg) => { clearTimeout(timer); worker.terminate(); msg.ok ? resolve(msg.result) : reject(new Error(msg.error)); });
    worker.once('error', (error) => { clearTimeout(timer); reject(error); });
});

/**
 * Loads rows, trains, stores a LearningModel. Returns a summary for the run log.
 * deps.inline = true runs in this thread (tests).
 */
export const trainMatrixEngine = async ({ now = Date.now(), halfLifeDays = 120, minRows = 200, deps = {}, log = () => {} } = {}) => {
    const rows = capCreatorWeights([...(await socialRows({ now, halfLifeDays })), ...(await userRows({ now, halfLifeDays }))]);
    const bySource = rows.reduce((m, r) => ({ ...m, [r.source]: (m[r.source] ?? 0) + 1 }), {});
    if (rows.length < minRows) return { skipped: `needs ${minRows} labelled videos, has ${rows.length}`, rows: rows.length, bySource };
    const plain = rows.map(({ y, w, group, features }) => ({ y, w, group, features }));
    const result = deps.inline ? runEngine(plain) : await runEngineInWorker(plain);
    if (result.skipped) return { skipped: result.skipped, rows: rows.length, bySource };
    const last = await LearningModel.findOne({ kind: MODEL_KIND }).sort({ version: -1 }).select('version').lean();
    const m = result.ridge.metrics;
    const beatsBaseline = (m.skill ?? 0) > 0.02 && (m.pairAccuracy ?? 0) > 0.55 && (m.pairs ?? 0) >= 200;
    const doc = await LearningModel.create({
        kind: MODEL_KIND,
        version: (last?.version ?? 0) + 1,
        status: 'candidate',
        trainedAt: new Date(now),
        n: result.n,
        p: result.p,
        creators: result.creators,
        columns: result.columns,
        standardization: result.spec,
        lambda: result.lambda,
        coefficients: { top: result.ridge.coefficients.slice(0, 60), beta: result.ridge.beta },
        metrics: { ridge: result.ridge.metrics, cv: result.ridge.cv, neural: result.neural ? { ...result.neural, weights: undefined } : null, rows: rows.length, bySource },
        network: result.network,
        components: result.components,
        weights: result.neural?.weights ?? null,
        promotion: {
            beatsCreatorUsual: beatsBaseline,
            neuralBeatsRidge: result.neural?.beatsRidge ?? null,
            serving: false,
            reason: 'Learns what beats a creator\'s own usual. Serving to users waits for the gates in PLAN.md 16.6 (users\' real results, owner cases, 7-day shadow).',
        },
    });
    const old = await LearningModel.find({ kind: MODEL_KIND }).sort({ version: -1 }).skip(KEEP_MODELS).select('_id').lean();
    if (old.length) await LearningModel.deleteMany({ _id: { $in: old.map((o) => o._id) } });
    log(`matrix engine v${doc.version}: n=${result.n} p=${result.p} skill=${m.skill} pairAccuracy=${m.pairAccuracy}`);
    return { version: doc.version, n: result.n, p: result.p, creators: result.creators, lambda: result.lambda, skill: m.skill, pairAccuracy: m.pairAccuracy, beatsCreatorUsual: beatsBaseline, neuralBeatsRidge: result.neural?.beatsRidge ?? null, bySource };
};
