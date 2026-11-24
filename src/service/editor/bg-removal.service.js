import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg } from '../../lib/ffmpeg.js';
import { storage } from '../../lib/storage.js';
import { captureServerEvent } from '../../lib/analytics.js';

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

async function falFetch(fetchFn, url, init, what) {
    const res = await fetchFn(url, init);
    if (!res.ok) {
        const detail = String(await res.text().catch(() => '')).slice(0, 200);
        throw new Error(`fal ${what} failed (${res.status})${detail ? `: ${detail}` : ''}`);
    }
    return res.json();
}

/**
 * Submit, poll until COMPLETED (or time out), fetch the result. Uses the status_url / response_url that
 * submit returns (building them from the model id returns 405 on fal).
 * @returns {Promise<{ requestId: string, result: object, inferenceSec: number|null }>}
 */
export async function runFalQueue({ endpoint, input, apiKey, fetchFn = fetch, sleepFn = sleep, now = Date.now, pollMs = POLL_INTERVAL_MS, timeoutMs = POLL_TIMEOUT_MS }) {
    if (!apiKey) throw new Error('FAL_KEY is not set');
    const submitted = await falFetch(fetchFn, `${FAL_QUEUE_BASE}/${endpoint}`, { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(input) }, 'submit');
    const { request_id: requestId, status_url: statusUrl, response_url: responseUrl, cancel_url: cancelUrl } = submitted ?? {};
    if (!requestId || !statusUrl || !responseUrl) throw new Error('fal submit returned no request id');
    const deadline = now() + timeoutMs;
    for (;;) {
        const status = await falFetch(fetchFn, statusUrl, { headers: authHeaders(apiKey) }, 'status');
        if (status?.status === 'COMPLETED') {
            if (status.error) throw new Error(`fal could not process the video: ${String(status.error).slice(0, 200)}`);
            const result = await falFetch(fetchFn, responseUrl, { headers: authHeaders(apiKey) }, 'result');
            return { requestId, result, inferenceSec: status.metrics?.inference_time ?? null };
        }
        if (now() + pollMs > deadline) {
            // Best effort: stop the work (and the bill) for a request we are giving up on.
            if (cancelUrl) await fetchFn(cancelUrl, { method: 'PUT', headers: authHeaders(apiKey) }).catch(() => {});
            throw new Error('fal timed out');
        }
        await sleepFn(pollMs);
    }
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

/** Short, plain reason a creator-facing log or the project record can hold. */
const plainReason = (err) => (/timed out/.test(err?.message ?? '') ? 'timeout' : 'provider_error');

/**
 * The matte step of an edit. Returns { status: 'ok'|'failed'|'skipped', ... } and never throws.
 * ok: { key, model, cached, seconds }  failed/skipped: { reason }
 * @param {object} p { userId, projectId, srcPath, workDir, durationSec }
 * @param {object} [deps] injectable for tests: fetchFn, sleepFn, now, makeProxy, hash, env, track, pollMs, timeoutMs
 */
export async function runMatteStep({ userId, projectId, srcPath, workDir, durationSec }, deps = {}) {
    const env = deps.env ?? process.env;
    const apiKey = env.FAL_KEY;
    const model = modelFromEnv(env);
    const refine = true;
    const track = deps.track ?? captureServerEvent;
    if (!apiKey) return { status: 'skipped', reason: 'not_configured' };
    if (!(durationSec > 0) || durationSec > MATTE_MAX_SEC) return { status: 'skipped', reason: 'too_long' };

    let inputKey = null;
    try {
        const sourceHash = await (deps.hash ?? hashFile)(srcPath);
        const key = matteKey(userId, sourceHash, model, { refine });
        // Cache hit: the same source and model was already matted. No call, no charge.
        if (await storage.head(key)) return { status: 'ok', key, model, cached: true, seconds: 0 };

        const proxyPath = path.join(workDir, 'matte-input.mp4');
        await (deps.makeProxy ?? makeMatteProxy)(srcPath, proxyPath);
        inputKey = `editor/mattes/${userId}/${sourceHash}/input-720p.mp4`;
        await storage.uploadFile(proxyPath, inputKey, 'video/mp4');
        const videoUrl = await storage.presignDownload(inputKey, { expiresIn: 60 * 60 });

        const { requestId, result } = await runFalQueue({
            endpoint: MODELS[model].endpoint,
            input: buildFalInput(model, videoUrl, { refine }),
            apiKey,
            fetchFn: deps.fetchFn,
            sleepFn: deps.sleepFn,
            now: deps.now,
            pollMs: deps.pollMs,
            timeoutMs: deps.timeoutMs,
        });
        const outUrl = extractVideoUrl(result);
        if (!outUrl) throw new Error('fal returned no video');
        const download = await (deps.fetchFn ?? fetch)(outUrl);
        if (!download.ok) throw new Error(`matte download failed (${download.status})`);
        await storage.uploadBuffer(Buffer.from(await download.arrayBuffer()), key, 'video/webm');

        // Billing visibility: seconds processed per user, with the estimate.
        const costUsd = estimateCostUsd(model, durationSec, { refine });
        console.log(`[Editor] matte ok user=${userId} project=${projectId} model=${model} seconds=${Math.round(durationSec)} estUsd=${costUsd} request=${requestId}`);
        track(userId, 'edit_matte', { project_id: String(projectId), model, seconds: Math.round(durationSec), est_cost_usd: costUsd });
        return { status: 'ok', key, model, cached: false, seconds: Math.round(durationSec) };
    } catch (err) {
        console.error(`[Editor] matte failed for project ${projectId}: ${err.message}`);
        return { status: 'failed', reason: plainReason(err) };
    } finally {
        if (inputKey) await storage.deletePrefix(inputKey).catch(() => {});
    }
}
