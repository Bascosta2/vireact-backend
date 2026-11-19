/**
 * Deep analysis of public videos (docs/learning-engine/PLAN.md, section 6: sampler and deep analyzer).
 *
 * Each day it picks hit-and-miss pairs from the same creators (deep-features.js pickPairs), then for each:
 *   1. fresh file link + captions + comments from the provider's full Posts dataset (1 record each);
 *      that call is also a new reading of the video's numbers, stored like a re-check
 *   2. downloads the file to a temp folder and measures it with ffmpeg: exact cut times, pauses, loudness
 *   3. uploads it to Twelve Labs and runs Pegasus: scene-by-scene breakdown (what is on screen, on-screen
 *      text, audio, action, purpose) and a timed transcript, the same calls user uploads get
 *   4. lines everything up shot by shot (timeline) and computes features
 *   5. deletes the file locally and the asset at Twelve Labs; keeps only descriptions and numbers
 * If the server cannot download the file, Twelve Labs fetches the link itself (no exact cuts then).
 *
 * Settings: LEARNING_DEEP_DAILY (videos per day, 0 = off), LEARNING_DEEP_CONCURRENCY, LEARNING_DEEP_MAX_SEC.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SocialCreator, SocialVideo, SocialVideoAnalysis, VideoFeatures } from '../../model/learning.model.js';
import { buildTimeline, deepFeatures, pickPairs, shotsFromCuts, shotsFromScenes } from './deep-features.js';
import { isMediaUrl, mediaHeaders } from './social/brightdata.js';
import { cleanStats, usedOf } from './social/providers.js';
import { extrasUpdate, writeOutcome } from './social/collector.js';
import { withAiContext, newTraceId } from '../../lib/ai-tracking.js';
import { measureMedia } from './media-measure.js';
import { describeHook } from './hook-vision.js';
import { detectLanguage } from './media-signals.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_BYTES = 250 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MEDIA_BATCH = 20;
/** Pegasus needs a few seconds of video. */
const MIN_DURATION_SEC = 4;

// ---- real implementations (tests pass fakes through `deps`)

/** Downloads a provider video link to `dest`, capped at MAX_BYTES. Returns dest. */
export const downloadVideo = async (url, chainToken, dest, { fetchImpl = globalThis.fetch } = {}) => {
    if (!isMediaUrl(url)) throw new Error('video link is not a TikTok media host');
    const res = await fetchImpl(url, { headers: mediaHeaders(chainToken), redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
    if (res.url && !isMediaUrl(res.url)) throw new Error('download redirected off TikTok');
    const type = String(res.headers.get('content-type') ?? '');
    if (type && !/video|octet-stream|mp4/i.test(type)) throw new Error(`download returned ${type.slice(0, 40)}`);
    if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('video file too large');
    let seen = 0;
    const cap = new Transform({
        transform(chunk, _enc, cb) {
            seen += chunk.length;
            cb(seen > MAX_BYTES ? new Error('video file too large') : null, chunk);
        },
    });
    await pipeline(Readable.fromWeb(res.body), cap, fs.createWriteStream(dest));
    if (seen < 10_000) throw new Error(`download too small (${seen} bytes)`);
    return { path: dest, bytes: seen };
};

/** Probe, adaptive cuts, pauses, loudness, picture and rhythm of a local file (media-measure.js). */
export const measureVideo = (file, opts) => measureMedia(file, opts);

const realTwelveLabs = async () => {
    const [{ default: client }, ingest, analyze] = await Promise.all([
        import('../../lib/twelve-labs.js'),
        import('../../lib/twelve-labs-ingest.helper.js'),
        import('../../lib/twelve-labs-analyze.js'),
    ]);
    const idOf = (a) => ({ id: a?.id ?? a?._id, status: a?.status ?? null });
    return {
        model: analyze.pegasusModel(),
        createFromFile: async (file) => idOf(await ingest.twelveLabsCreateDirectAsset(fs.createReadStream(file))),
        createFromUrl: async (url) => idOf(await ingest.twelveLabsCreateUrlAsset(url)),
        waitReady: async (id, status, { maxWaitMs = 8 * 60_000, pollMs = 4000 } = {}) => {
            const deadline = Date.now() + maxWaitMs;
            let s = status;
            while (s !== 'ready') {
                if (s === 'failed') throw new Error('Twelve Labs could not process the video');
                if (Date.now() > deadline) throw new Error(`Twelve Labs asset not ready after ${Math.round(maxWaitMs / 60000)} min (${s})`);
                await new Promise((r) => setTimeout(r, pollMs));
                try {
                    s = (await client.assets.retrieve(id))?.status;
                } catch {
                    // transient: poll again
                }
            }
        },
        scenes: (id) => analyze.analyzeVideoScenesStructured({ assetId: id }),
        transcript: (id) => analyze.transcribeVideoWithPegasus({ assetId: id }),
        deleteAsset: (id) => client.assets.delete(id),
    };
};

// ---- picking

/**
 * Today's videos: hit-and-miss pairs from creators with a reliable baseline, settled videos only
 * (7+ days old), skipping anything already analyzed or tried.
 */
export const pickDeepSample = async ({ limit, maxDurationSec = 180, maxAgeDays = 365, languages = ['en'], now = Date.now(), platform = 'tiktok' } = {}) => {
    if (!(limit > 0)) return [];
    const creators = await SocialCreator.find({ platform, baselineViews: { $ne: null }, baselineN: { $gte: 5 } })
        .select('_id niche baselineViews').lean();
    if (!creators.length) return [];
    const [doneRows, nicheRows] = await Promise.all([
        SocialVideoAnalysis.aggregate([{ $group: { _id: '$creatorId', n: { $sum: 1 } } }]),
        SocialVideoAnalysis.aggregate([{ $match: { role: { $in: ['hit', 'miss'] } } }, { $group: { _id: '$niche', n: { $sum: 1 } } }]),
    ]);
    const done = new Map(doneRows.map((r) => [String(r._id), r.n]));
    const nicheDone = Object.fromEntries(nicheRows.map((r) => [r._id ?? 'unknown', r.n / 2]));
    // Least-analyzed creators first; look at a generous slice so niches can take turns.
    const ordered = creators.sort((a, b) => (done.get(String(a._id)) ?? 0) - (done.get(String(b._id)) ?? 0)).slice(0, Math.max(80, limit * 5));
    const videos = await SocialVideo.find({
        creatorId: { $in: ordered.map((c) => c._id) },
        deep: null,
        url: { $ne: null },
        'latest.views': { $ne: null },
        // Settled (7+ days) but recent: older videos were ranked by a different TikTok.
        postedAt: { $lte: new Date(now - 7 * DAY_MS), ...(maxAgeDays > 0 ? { $gte: new Date(now - maxAgeDays * DAY_MS) } : {}) },
        $or: [{ durationSec: null }, { durationSec: { $gte: MIN_DURATION_SEC, $lte: maxDurationSec } }],
    }).select('_id creatorId latest.views durationSec caption language').lean();
    const wanted = new Set((languages ?? []).map((l) => String(l).toLowerCase()).filter(Boolean));
    const byCreator = new Map();
    for (const v of videos) {
        // Speech speed and on-screen text differ by language, so pairs stay within the chosen languages.
        // Captions too short to tell (null) are allowed; a clearly different language is not.
        const lang = v.language ?? detectLanguage(v.caption);
        if (wanted.size && lang && !wanted.has(lang)) continue;
        const k = String(v.creatorId);
        if (!byCreator.has(k)) byCreator.set(k, []);
        byCreator.get(k).push({ id: v._id, views: v.latest.views, durationSec: v.durationSec ?? null });
    }
    const groups = ordered.map((c) => ({
        creatorId: c._id, niche: c.niche ?? null, baseline: c.baselineViews, analyzed: done.get(String(c._id)) ?? 0, videos: byCreator.get(String(c._id)) ?? [],
    }));
    return pickPairs(groups, { limit, maxDurationSec, nicheDone });
};

// ---- one video

/**
 * Analyze one video. `extra` is the provider's extras for it (file link, captions, token).
 * Returns the saved SocialVideoAnalysis (lean). Throws on failure; the caller records it.
 */
export const analyzeOne = async ({ video, pick, creator, extra, deps = {}, maxDurationSec = 180, log = () => {} }) => {
    const started = Date.now();
    const tl = deps.twelveLabs ?? await realTwelveLabs();
    const download = deps.download ?? downloadVideo;
    const measure = deps.measure ?? measureVideo;
    const hookVision = deps.describeHook ?? describeHook;
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vx-deep-'));
    let assetId = null;
    try {
        let via = 'url';
        let measured = null;
        let bytes = null;
        let asset;
        try {
            const file = await download(extra.videoUrl, extra.chainToken, path.join(dir, 'video.mp4'));
            bytes = file.bytes ?? null;
            measured = await measure(file.path, { hookFrames: true, workDir: dir });
            if (measured.info?.durationSec > maxDurationSec + 1) throw Object.assign(new Error(`video is ${Math.round(measured.info.durationSec)}s, over the ${maxDurationSec}s limit`), { final: true });
            if (measured.info?.durationSec < MIN_DURATION_SEC) throw Object.assign(new Error('video too short to analyze'), { final: true });
            asset = await tl.createFromFile(file.path);
            via = 'download';
        } catch (error) {
            if (error.final) throw error;
            log(`deep ${video.externalId}: download/measure failed (${error.message}); Twelve Labs will fetch the link`);
            measured = null;
            asset = await tl.createFromUrl(extra.videoUrl);
        }
        assetId = asset.id;
        if (!assetId) throw new Error('Twelve Labs returned no asset id');
        await tl.waitReady(assetId, asset.status);
        const [scenes, transcript, hook] = await Promise.all([
            tl.scenes(assetId),
            tl.transcript(assetId),
            measured?.hookImage ? hookVision(measured.hookImage) : Promise.resolve(null),
        ]);
        if (!scenes.length && !transcript.length) throw new Error('Twelve Labs returned no scenes and no transcript');

        const durationSec = measured?.info?.durationSec ?? video.durationSec ?? scenes.at(-1)?.endTime ?? null;
        const cutsSource = measured ? 'ffmpeg' : 'pegasus';
        const shots = measured ? shotsFromCuts(measured.cuts, durationSec) : shotsFromScenes(scenes);
        const timeline = buildTimeline({ shots, scenes, transcript });
        const language = detectLanguage(transcript.map((s) => s.text).join(' ')) ?? video.language ?? detectLanguage(video.caption);
        const features = deepFeatures({
            durationSec, cutsSource, shots, scenes, transcript, timeline,
            silences: measured?.silences ?? [], loudnessLufs: measured?.loudnessLufs ?? null, hasAudio: measured?.info?.hasAudio ?? null,
            picture: measured?.picture ?? {}, rhythm: measured?.rhythm ?? {}, hook: hook?.features ?? {},
        });
        if (measured && Array.isArray(measured.cutsHardOnly)) features.softCutCount = Math.max(0, (measured.cuts?.length ?? 0) - measured.cutsHardOnly.length);
        const doc = {
            socialVideoId: video._id, platform: video.platform ?? 'tiktok', externalId: video.externalId, creatorId: video.creatorId ?? null,
            niche: pick?.niche ?? creator?.niche ?? null, role: pick?.role ?? 'other',
            views: video.latest?.views ?? null, baselineViews: creator?.baselineViews ?? null, outperformance: pick?.outperformance ?? null,
            via, cutsSource, model: tl.model ?? null,
            media: measured ? {
                durationSec: measured.info.durationSec, width: measured.info.width, height: measured.info.height, fps: measured.info.fps,
                hasAudio: measured.info.hasAudio, loudnessLufs: measured.loudnessLufs, bytes,
                picture: measured.picture ?? null, rhythm: measured.rhythm ?? null, measureVersion: measured.version ?? null,
            } : { durationSec },
            hookVision: hook?.answer ?? null,
            language: language ?? null,
            cuts: measured ? shots.slice(1).map((s) => s.start) : [],
            silences: measured?.silences ?? [],
            scenes, transcript, timeline, features, ms: Date.now() - started, analyzedAt: new Date(),
        };
        const saved = await SocialVideoAnalysis.findOneAndUpdate({ socialVideoId: video._id }, { $set: doc }, { upsert: true, new: true }).lean();
        if (language && !video.language) await SocialVideo.updateOne({ _id: video._id }, { $set: { language } });
        await VideoFeatures.updateOne(
            { subjectType: 'social', subjectId: video._id },
            { $set: { ...Object.fromEntries(Object.entries(features).map(([k, v]) => [`features.${k}`, v])), 'features.speechFromCaptions': false, deepAt: new Date() } },
        );
        return saved;
    } finally {
        if (assetId) await Promise.resolve(tl.deleteAsset(assetId)).catch((error) => log(`deep: Twelve Labs asset ${assetId} not deleted: ${error.message}`));
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
};

// ---- a run

let deepRunning = false;
export const isDeepRunning = () => deepRunning;

/**
 * Picks today's sample and analyzes it. Never throws for one video: failures are counted and recorded
 * on the SocialVideo (deep.status 'failed') so they are not retried every day.
 */
export const runDeepAnalysis = async ({
    provider, limit = 60, concurrency = 3, maxDurationSec = 180, maxAgeDays = 365, languages = ['en'], now = Date.now(), deps = {}, log = () => {},
} = {}) => {
    const out = { picked: 0, withLink: 0, analyzed: 0, exactCuts: 0, viaUrl: 0, failed: 0, used: 0, videoMinutes: 0, errors: [] };
    if (!provider?.videoStats) return { ...out, skipped: 'no provider configured' };
    if (!deps.twelveLabs && !process.env.TWELVE_LABS_API_KEY) return { ...out, skipped: 'TWELVE_LABS_API_KEY not set' };
    if (deepRunning) return { ...out, skipped: 'already running' };
    deepRunning = true;
    try {
        const picks = await pickDeepSample({ limit, maxDurationSec, maxAgeDays, languages, now });
        out.picked = picks.length;
        if (!picks.length) return out;
        const videos = await SocialVideo.find({ _id: { $in: picks.map((p) => p.id) } }).lean();
        const videoById = new Map(videos.map((v) => [String(v._id), v]));
        const creators = await SocialCreator.find({ _id: { $in: [...new Set(picks.map((p) => String(p.creatorId)))] } }).select('niche baselineViews followers').lean();
        const creatorById = new Map(creators.map((c) => [String(c._id), c]));
        const note = (msg) => {
            if (out.errors.length < 10) out.errors.push(String(msg).slice(0, 200));
            log(msg);
        };
        const markFailed = (v, pick, message) => SocialVideo.updateOne({ _id: v._id }, { $set: { deep: { status: 'failed', at: new Date(), error: String(message).slice(0, 300), role: pick?.role ?? null } } });

        // 1. fresh links (+ a new reading of the numbers), in batches
        const extras = new Map();
        const batches = [];
        for (let i = 0; i < picks.length; i += MEDIA_BATCH) batches.push(picks.slice(i, i + MEDIA_BATCH).map((p) => videoById.get(String(p.id))).filter(Boolean));
        await Promise.all(batches.map(async (batch) => {
            try {
                const result = await provider.videoStats({ ids: batch.map((v) => v.externalId), videos: batch.map((v) => ({ externalId: v.externalId, url: v.url })) });
                out.used += usedOf(result);
                const stats = new Map((result?.stats ?? []).map(cleanStats).filter(Boolean).map((s) => [s.externalId, s]));
                for (const e of result?.extras ?? []) extras.set(String(e.externalId), e);
                for (const v of batch) {
                    const s = stats.get(v.externalId);
                    const e = extras.get(v.externalId);
                    const set = e ? extrasUpdate(e, v) : {};
                    if (s) {
                        Object.assign(set, { latest: { ...s, at: new Date(now) }, lastCheckedAt: new Date(now) });
                        await writeOutcome({ video: v, stats: s, platform: v.platform, providerName: provider.name, now });
                    }
                    if (Object.keys(set).length) await SocialVideo.updateOne({ _id: v._id }, { $set: set, ...(s ? { $inc: { checks: 1 } } : {}) });
                }
            } catch (error) {
                note(`deep: provider links failed: ${error.message}`);
            }
        }));

        // 2. analyze, a few at a time
        const queue = picks.map((p) => ({ pick: p, video: videoById.get(String(p.id)) })).filter((x) => x.video);
        const worker = async () => {
            for (let item = queue.shift(); item; item = queue.shift()) {
                const { pick, video } = item;
                const extra = extras.get(video.externalId);
                if (!extra?.videoUrl) {
                    await markFailed(video, pick, 'provider returned no video link');
                    out.failed += 1;
                    continue;
                }
                out.withLink += 1;
                try {
                    const saved = await withAiContext(
                        { feature: 'learning_deep', distinctId: 'learning-engine', traceId: newTraceId(`deep-${video.externalId}`) },
                        () => analyzeOne({ video, pick, creator: creatorById.get(String(pick.creatorId)), extra, deps, maxDurationSec, log }),
                    );
                    await SocialVideo.updateOne({ _id: video._id }, { $set: { deep: { status: 'done', at: new Date(), role: pick.role } } });
                    out.analyzed += 1;
                    if (saved.cutsSource === 'ffmpeg') out.exactCuts += 1; else out.viaUrl += 1;
                    out.videoMinutes += (Number(saved.media?.durationSec) || 0) / 60;
                } catch (error) {
                    out.failed += 1;
                    note(`deep ${video.externalId}: ${error.message}`);
                    await markFailed(video, pick, error.message);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(6, concurrency)) }, worker));
        out.videoMinutes = Math.round(out.videoMinutes * 10) / 10;
        log(`deep: ${JSON.stringify({ ...out, errors: out.errors.length })}`);
        return out;
    } finally {
        deepRunning = false;
    }
};
