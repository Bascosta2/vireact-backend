import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg } from '../../lib/ffmpeg.js';
import { storage } from '../../lib/storage.js';
import { captureServerEvent } from '../../lib/analytics.js';
import { captureError } from '../ops-monitoring.service.js';
import { MatteJob, matteJobId } from '../../model/matte-job.model.js';
import { getOrCreateSubscription } from '../subscription.service.js';

/**
 * Background removal for "graphics behind you". A 720p proxy goes to fal.ai's queue API, the matte
 * (a video with alpha) is copied into our own S3 next to the source and cached by source hash + model,
 * and the render gets its URL. Never throws into the edit: any problem returns { status: 'failed', reason }
 * and the edit renders with graphics in front. Request/response shapes follow fal's docs
 * (fal.ai/docs/documentation/model-apis/inference/queue, and each model's API page).
 */

export const FAL_QUEUE_BASE = 'https://queue.fal.run';
/** Videos longer than this are not sent (cost guard). */
export const MATTE_MAX_SEC = 180;
export const POLL_INTERVAL_MS = 4000;
export const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const PROXY_SHORT_EDGE = 720;

/** Supported models. `endpoint` is the fal model id; price is read from the vendor pages (2026-11-23) and can change. */
export const MODELS = Object.freeze({
    veed: {
        id: 'veed',
        endpoint: 'veed/video-background-removal',
        // Per 30 frames of video, with and without edge refinement.
        priceUsdPer30Frames: { refine: 0.0225, plain: 0.015 },
    },
    bria: {
        id: 'bria',
        endpoint: 'bria/video/background-removal/v3',
        priceUsdPerSecond: 0.05,
    },
});

export const modelFromEnv = (env = process.env) => (MODELS[String(env.BG_REMOVAL_MODEL ?? '').trim().toLowerCase()] ? String(env.BG_REMOVAL_MODEL).trim().toLowerCase() : 'veed');

/** Input body for one request. A single VP9 WebM with alpha for both models. */
export function buildFalInput(model, videoUrl, { refine = true } = {}) {
    if (!MODELS[model]) throw new Error(`Unknown background removal model: ${model}`);
    if (model === 'bria') return { video_url: videoUrl, output_container_and_codec: 'webm_vp9', background_color: 'Transparent', preserve_audio: false };
    return { video_url: videoUrl, output_codec: 'vp9', refine_foreground_edges: refine, subject_is_person: true };
}

/** The matte's identity: the same source with the same model and settings never needs a second call. */
export const matteVariant = (model, { refine = true } = {}) => (model === 'veed' ? `veed-${refine ? 'refine' : 'plain'}` : model);
export const matteKey = (userId, sourceHash, model, opts) => `editor/mattes/${userId}/${sourceHash}/${matteVariant(model, opts)}.webm`;

/** First (or only) video URL from a fal result, or null. */
export function extractVideoUrl(result) {
    const v = result?.video;
    const first = Array.isArray(v) ? v[0] : v;
    return typeof first?.url === 'string' && first.url ? first.url : null;
}

/** Estimated fal cost for `seconds` of video. */
export function estimateCostUsd(model, seconds, { fps = 30, refine = true } = {}) {
    const m = MODELS[model];
    if (!m || !(seconds > 0)) return 0;
    const usd = model === 'bria' ? seconds * m.priceUsdPerSecond : (seconds * fps / 30) * (refine ? m.priceUsdPer30Frames.refine : m.priceUsdPer30Frames.plain);
    return Math.round(usd * 10000) / 10000;
}

const authHeaders = (key) => ({ Authorization: `Key ${key}`, 'Content-Type': 'application/json' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The API key only ever goes to fal over https. Anything else (a tampered or stored URL) is refused before a request is made. */
export function assertFalUrl(url) {
    let u;
    try {
        u = new URL(String(url));
    } catch {
        u = null;
    }
    const ok = u && u.protocol === 'https:' && (u.hostname === 'queue.fal.run' || u.hostname.endsWith('.fal.run') || u.hostname.endsWith('.fal.ai'));
    if (!ok) throw Object.assign(new Error('untrusted fal url'), { reason: 'provider_error' });
    return String(url);
}

async function falFetch(fetchFn, url, init, what) {
    const res = await fetchFn(url, init);
    if (!res.ok) {
        const detail = String(await res.text().catch(() => '')).slice(0, 200);
        throw Object.assign(new Error(`fal ${what} failed (${res.status})${detail ? `: ${detail}` : ''}`), { status: res.status });
    }
    return res.json();
}

/** Submit one request. Returns the ids and the (validated) urls fal gave us; keep them to resume after a crash. */
export async function submitFal({ endpoint, input, apiKey, fetchFn = fetch }) {
    if (!apiKey) throw new Error('FAL_KEY is not set');
    const submitted = await falFetch(fetchFn, `${FAL_QUEUE_BASE}/${endpoint}`, { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(input) }, 'submit');
    const { request_id: requestId, status_url: statusUrl, response_url: responseUrl, cancel_url: cancelUrl } = submitted ?? {};
    if (!requestId || !statusUrl || !responseUrl) throw new Error('fal submit returned no request id');
    assertFalUrl(statusUrl);
    assertFalUrl(responseUrl);
    if (cancelUrl) assertFalUrl(cancelUrl);
    return { requestId, statusUrl, responseUrl, cancelUrl: cancelUrl ?? null };
}

/** Best effort: stop the work (and the bill) for a request we are giving up on. */
export async function cancelFal({ cancelUrl, apiKey, fetchFn = fetch }) {
    try {
        if (cancelUrl) await fetchFn(assertFalUrl(cancelUrl), { method: 'PUT', headers: authHeaders(apiKey) });
    } catch { /* nothing more to do */ }
}

/** Fetch the result of a COMPLETED request again (a failed download is retried from here, never re-submitted). */
export async function fetchFalResult({ responseUrl, apiKey, fetchFn = fetch }) {
    try {
        return await falFetch(fetchFn, assertFalUrl(responseUrl), { headers: authHeaders(apiKey) }, 'result');
    } catch (err) {
        throw Object.assign(err, { stage: 'result' });
    }
}

/**
 * Poll an already-submitted request until COMPLETED (or time out), then fetch the result. A poll error or
 * timeout cancels the request before throwing; a result-fetch error does not (the work is done and paid).
 */
export async function pollFalResult({ statusUrl, responseUrl, cancelUrl, apiKey, fetchFn = fetch, sleepFn = sleep, now = Date.now, pollMs = POLL_INTERVAL_MS, timeoutMs = POLL_TIMEOUT_MS }) {
    const deadline = now() + timeoutMs;
    let status;
    for (;;) {
        try {
            status = await falFetch(fetchFn, assertFalUrl(statusUrl), { headers: authHeaders(apiKey) }, 'status');
            if (status?.status === 'COMPLETED') break;
            if (now() + pollMs > deadline) throw new Error('fal timed out');
        } catch (err) {
            await cancelFal({ cancelUrl, apiKey, fetchFn });
            throw err;
        }
        await sleepFn(pollMs);
    }
    if (status.error) throw new Error(`fal could not process the video: ${String(status.error).slice(0, 200)}`);
    const result = await fetchFalResult({ responseUrl, apiKey, fetchFn });
    return { result, inferenceSec: status.metrics?.inference_time ?? null };
}

/** Submit, poll, fetch (the bake-off uses this; the edit job uses the pieces so it can resume). */
export async function runFalQueue({ endpoint, input, apiKey, fetchFn = fetch, ...pollOpts }) {
    const sub = await submitFal({ endpoint, input, apiKey, fetchFn });
    const { result, inferenceSec } = await pollFalResult({ ...sub, apiKey, fetchFn, ...pollOpts });
    return { requestId: sub.requestId, result, inferenceSec };
}

/** 720p, 30 fps, no audio copy of the source: all fal needs, and far smaller than the original. */
export async function makeMatteProxy(srcPath, outPath) {
    await ffmpeg([
        '-i', srcPath,
        '-vf', `scale='if(gt(iw,ih),-2,min(${PROXY_SHORT_EDGE},iw))':'if(gt(iw,ih),min(${PROXY_SHORT_EDGE},ih),-2)'`,
        '-r', '30', '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        outPath,
    ]);
}

export const hashFile = (filePath) => new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(filePath).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex').slice(0, 32)));
});

/** Plain reason kept on the project (never a raw error message). */
export const plainReason = (err) => {
    if (err?.reason) return err.reason;
    if (err?.status === 403) return 'billing';
    if (err?.stage === 'result' || err?.stage === 'download') return 'download_failed';
    return /timed out/.test(err?.message ?? '') ? 'timeout' : 'provider_error';
};

// ---- spend guards -------------------------------------------------------------------------------

const FAILED_RETRY_MS = 24 * 60 * 60 * 1000;
const CLAIM_STALE_MS = 2 * 60 * 1000;
const BILLING_LOCK_MS = 60 * 60 * 1000;
let billingLockedUntil = 0;
export const resetBillingLockForTests = () => {
    billingLockedUntil = 0;
};

const numEnv = (v, fallback) => (v != null && String(v).trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fallback);
const allowedPlans = (env) => String(env.BG_REMOVAL_PLANS || 'pro').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
const startOfMonth = (t) => new Date(Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), 1));
const startOfDay = (t) => new Date(Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate()));

/** Sum of `field` over the ledger entries (MatteJob.usage) since `since`; voided runs never reached fal. */
export const sumLedger = (docs, since, field) => (docs ?? [])
    .flatMap((d) => d.usage ?? [])
    .filter((u) => !u.voided && new Date(u.at).getTime() >= since.getTime())
    .reduce((total, u) => total + (Number(u[field]) || 0), 0);

/** Every claimed run counts, including earlier runs of a matte that was later retried. */
export const ledgerTotal = async (match, since, field, { Model = MatteJob } = {}) =>
    sumLedger(await Model.find({ ...match, 'usage.at': { $gte: since } }).select('usage').lean(), since, field);

const defaults = {
    planOf: async (userId) => (await getOrCreateSubscription(userId))?.plan ?? 'free',
    secondsThisMonth: (userId, t) => ledgerTotal({ userId: String(userId) }, startOfMonth(t), 'seconds'),
    usdToday: (t) => ledgerTotal({}, startOfDay(t), 'estCostUsd'),
};

/** Why this user's video may not be sent to fal ('plan' or 'cap'), or null. */
export async function spendGuard({ userId, durationSec, estCostUsd }, deps = {}, env = process.env) {
    const t = (deps.now ?? Date.now)();
    const plan = await (deps.planOf ?? defaults.planOf)(userId);
    if (!allowedPlans(env).includes(String(plan).toLowerCase())) return 'plan';
    const monthly = numEnv(env.BG_REMOVAL_MONTHLY_SEC_PER_USER, 600);
    if ((await (deps.secondsThisMonth ?? defaults.secondsThisMonth)(userId, t)) + durationSec > monthly) return 'cap';
    const daily = numEnv(env.BG_REMOVAL_DAILY_USD_CAP, 10);
    if ((await (deps.usdToday ?? defaults.usdToday)(t)) + estCostUsd > daily) return 'cap';
    return null;
}

const RECORD_FIELDS = ['status', 'key', 'model', 'variant', 'sourceHash', 'reason', 'seconds', 'estCostUsd', 'cached', 'requestId', 'statusUrl', 'responseUrl', 'cancelUrl', 'submittedAt', 'updatedAt', 'claimId'];
const recordFields = (rec) => Object.fromEntries(RECORD_FIELDS.filter((k) => rec[k] !== undefined).map((k) => [k, rec[k]]));

/**
 * Matte state per user + source + variant (MatteJob; the same source on any of the user's projects shares it).
 * `claim` is atomic: inserting the document (its _id is the key, so a second insert fails) or swapping it on the
 * `rev` that was read. Exactly one of several simultaneous jobs wins and may submit. The claim also appends the
 * run to the usage ledger in the same write.
 */
export const matteJobStore = (userId, { Model = MatteJob } = {}) => {
    const idOf = (sourceHash, variant) => matteJobId(userId, sourceHash, variant);
    return {
        find: (sourceHash, variant) => Model.findOne({ _id: idOf(sourceHash, variant) }).lean(),
        /** True when this run got the work; false when another run claimed it first. */
        async claim(existing, rec, usage) {
            const _id = idOf(rec.sourceHash, rec.variant);
            if (!existing) {
                try {
                    await Model.create({ _id, userId, sourceHash: rec.sourceHash, variant: rec.variant, rev: 1, ...recordFields(rec), usage: [usage] });
                    return true;
                } catch (err) {
                    if (err?.code === 11000) return false;
                    throw err;
                }
            }
            const won = await Model.findOneAndUpdate({ _id, rev: existing.rev ?? 1 }, { $set: recordFields(rec), $inc: { rev: 1 }, $push: { usage } }, { new: true, lean: true });
            return Boolean(won);
        },
        /** Only the run holding the claim can write the record, so a run that lost it never overwrites the winner. */
        save: (rec) => Model.updateOne({ _id: idOf(rec.sourceHash, rec.variant), claimId: rec.claimId ?? null }, { $set: recordFields(rec), $inc: { rev: 1 } }),
        /** The run stopped before anything was sent to fal: its ledger entry is not billed. */
        release: (rec) => Model.updateOne({ _id: idOf(rec.sourceHash, rec.variant), 'usage.claimId': rec.claimId ?? null }, { $set: { 'usage.$.voided': true } }),
    };
};

const ageMs = (rec, t) => t - new Date(rec?.updatedAt ?? rec?.submittedAt ?? 0).getTime();
const publicRecord = (rec) => ({ status: rec.status, reason: rec.reason ?? null, model: rec.model, variant: rec.variant, sourceHash: rec.sourceHash, updatedAt: rec.updatedAt });

/**
 * The matte step of an edit. Returns the matte record ({ status: 'ok'|'failed'|'skipped'|'pending', ... }) and
 * never throws. It also never submits a second request for work already pending or done: the request id is
 * saved right after submit, a re-run resumes polling it, a failed download is retried from fal's response url,
 * and a failed matte is not tried again within 24 hours.
 * @param {object} p { userId, projectId, srcPath, workDir, durationSec }
 * @param {object} [deps] injectable for tests: fetchFn, sleepFn, now, makeProxy, hash, env, track, pollMs, timeoutMs, store (find/claim/save/release, see matteJobStore), planOf, secondsThisMonth, usdToday, report
 */
export async function runMatteStep({ userId, projectId, srcPath, workDir, durationSec }, deps = {}) {
    const env = deps.env ?? process.env;
    const apiKey = env.FAL_KEY;
    const model = modelFromEnv(env);
    const refine = true;
    const variant = matteVariant(model, { refine });
    const nowMs = deps.now ?? Date.now;
    const track = deps.track ?? captureServerEvent;
    const report = deps.report ?? captureError;
    if (!apiKey) return { status: 'skipped', reason: 'not_configured' };
    if (!(durationSec > 0) || durationSec > MATTE_MAX_SEC) return { status: 'skipped', reason: 'too_long' };
    if (nowMs() < billingLockedUntil) return { status: 'skipped', reason: 'billing' };

    const store = deps.store ?? matteJobStore(userId);
    const save = (rec) => store.save({ ...rec, updatedAt: new Date(nowMs()) });
    let inputKey = null;
    let rec = null;
    let claimed = false;
    let sent = false;
    try {
        const sourceHash = await (deps.hash ?? hashFile)(srcPath);
        const key = matteKey(userId, sourceHash, model, { refine });
        // Cache hit: the same source and model was already matted. No call, no charge.
        if (await storage.head(key)) return { status: 'ok', key, model, variant, sourceHash, cached: true, seconds: 0, estCostUsd: 0 };

        const existing = await store.find(sourceHash, variant);
        const t = nowMs();
        const resumable = existing && ((existing.status === 'pending' && existing.requestId) || (existing.status === 'failed' && existing.reason === 'download_failed' && existing.responseUrl));
        if (existing?.status === 'failed' && !resumable && ageMs(existing, t) < FAILED_RETRY_MS) return publicRecord(existing);
        if (existing?.status === 'pending' && !existing.requestId && ageMs(existing, t) < CLAIM_STALE_MS) return { status: 'skipped', reason: 'in_progress' };

        if (resumable) {
            rec = { ...recordFields(existing), status: 'pending' };
        } else {
            const estCostUsd = estimateCostUsd(model, durationSec, { refine });
            const blocked = await spendGuard({ userId, durationSec, estCostUsd }, deps, env);
            if (blocked) return { status: 'skipped', reason: blocked };
            // Claim first (no request id yet), atomically: of several simultaneous jobs exactly one goes on, and its
            // run is in the usage ledger before anything is sent, so the caps already count it.
            const claimId = crypto.randomUUID();
            const seconds = Math.round(durationSec);
            const claim = { status: 'pending', model, variant, sourceHash, requestId: null, statusUrl: null, responseUrl: null, cancelUrl: null, reason: null, key: null, cached: false, submittedAt: new Date(t), seconds, estCostUsd, claimId, updatedAt: new Date(t) };
            if (!(await store.claim(existing, claim, { claimId, at: new Date(t), seconds, estCostUsd }))) return { status: 'skipped', reason: 'in_progress' };
            rec = claim;
            claimed = true;
            const proxyPath = path.join(workDir, 'matte-input.mp4');
            await (deps.makeProxy ?? makeMatteProxy)(srcPath, proxyPath);
            inputKey = `editor/mattes/${userId}/${sourceHash}/input-720p.mp4`;
            await storage.uploadFile(proxyPath, inputKey, 'video/mp4');
            const videoUrl = await storage.presignDownload(inputKey, { expiresIn: 60 * 60 });
            sent = true; // from here fal may bill this run, so its ledger entry stays
            const sub = await submitFal({ endpoint: MODELS[model].endpoint, input: buildFalInput(model, videoUrl, { refine }), apiKey, fetchFn: deps.fetchFn });
            rec = { ...rec, ...sub };
            await save(rec); // right after submit: a crash from here on resumes this request
        }

        let result = null;
        if (existing?.status === 'failed' && resumable) {
            result = await fetchFalResult({ responseUrl: rec.responseUrl, apiKey, fetchFn: deps.fetchFn });
        } else {
            const remaining = Math.max(0, (deps.timeoutMs ?? POLL_TIMEOUT_MS) - (nowMs() - new Date(rec.submittedAt).getTime()));
            ({ result } = await pollFalResult({ ...rec, apiKey, fetchFn: deps.fetchFn, sleepFn: deps.sleepFn, now: deps.now, pollMs: deps.pollMs, timeoutMs: remaining }));
        }
        const outUrl = extractVideoUrl(result);
        if (!outUrl) throw Object.assign(new Error('fal returned no video'), { stage: 'download' });
        if (!/^https:\/\//i.test(outUrl)) throw Object.assign(new Error('untrusted matte url'), { reason: 'provider_error' });
        let buf;
        try {
            const download = await (deps.fetchFn ?? fetch)(outUrl);
            if (!download.ok) throw new Error(`matte download failed (${download.status})`);
            buf = Buffer.from(await download.arrayBuffer());
        } catch (err) {
            throw Object.assign(err, { stage: 'download' });
        }
        await storage.uploadBuffer(buf, key, 'video/webm');

        // Billing visibility: seconds processed per user, with the estimate.
        console.log(`[Editor] matte ok user=${userId} project=${projectId} model=${model} seconds=${rec.seconds ?? Math.round(durationSec)} estUsd=${rec.estCostUsd} request=${rec.requestId}`);
        track(userId, 'edit_matte', { project_id: String(projectId), model, seconds: rec.seconds, est_cost_usd: rec.estCostUsd });
        const done = { ...rec, status: 'ok', key, cached: false, reason: null };
        await save(done);
        return done;
    } catch (err) {
        const reason = plainReason(err);
        console.error(`[Editor] matte failed for project ${projectId}: ${err.message}`);
        if (reason === 'billing') {
            // Credits exhausted or the account is locked: stop sending anything for a while and tell the owner.
            billingLockedUntil = nowMs() + BILLING_LOCK_MS;
            report(err, { stage: 'bg_removal_billing', userId: String(userId), projectId: String(projectId) });
        }
        const failed = { ...(rec ?? {}), status: 'failed', reason };
        if (rec?.sourceHash) await save(failed).catch(() => {});
        if (claimed && !sent) await store.release(rec).catch(() => {});
        return rec?.sourceHash ? failed : { status: 'failed', reason };
    } finally {
        // Exact-key delete: the backend's IAM user has no s3:ListBucket, so deletePrefix would fail silently and
        // leave the user's video copy behind (the privacy policy promises it is deleted).
        if (inputKey) await storage.deleteObject(inputKey).catch((err) => report(err, { source: 'bg-removal', step: 'delete-input' }));
    }
}
