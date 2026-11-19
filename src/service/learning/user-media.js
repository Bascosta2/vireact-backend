/**
 * Measures users' own uploads the same way public videos are measured (docs/learning-engine/PLAN.md, 15.1
 * item 1), so exact-cut, picture, rhythm and hook features exist for both and the model compares like with
 * like. Twelve Labs does not give files back, so this must happen at upload, while the file is on our disk.
 *
 *   keepForMeasure(source)  fast, awaited by the upload: hard-links (or copies) the temp file, or writes a
 *                           downloaded buffer, into a private folder that survives the request's cleanup
 *   measureLater(videoId, handle)  background, one at a time: measure, describe the hook, save
 *                           Video.mediaMeasure, refresh the learning features if the analysis is done,
 *                           delete the folder
 * Never fails or slows an upload: every error is logged and dropped. LEARNING_MEASURE_UPLOADS=false turns it off.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Video } from '../../model/video.model.js';
import { measureMedia } from './media-measure.js';
import { describeHook } from './hook-vision.js';

export const measureUploadsEnabled = (env = process.env) => String(env.LEARNING_MEASURE_UPLOADS ?? 'true').trim().toLowerCase() !== 'false';
const MAX_SECONDS = 15 * 60;

let chain = Promise.resolve();
let pending = 0;
const MAX_PENDING = 20;

/** Returns a handle { dir, file } or null. */
export const keepForMeasure = async (source) => {
    if (!measureUploadsEnabled() || pending >= MAX_PENDING) return null;
    let dir = null;
    try {
        dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vx-upload-measure-'));
        const file = path.join(dir, 'upload.bin');
        if (source?.path) {
            await fsp.link(source.path, file).catch(() => fsp.copyFile(source.path, file));
        } else if (Buffer.isBuffer(source?.buffer)) {
            await fsp.writeFile(file, source.buffer);
        } else {
            await fsp.rm(dir, { recursive: true, force: true });
            return null;
        }
        return { dir, file };
    } catch (error) {
        console.warn(`[learning] upload not kept for measuring: ${error.message}`);
        if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
        return null;
    }
};

/** The stored measurement (small: times and numbers only). */
export const toMediaMeasure = (m, hook) => ({
    version: m.version,
    at: new Date(),
    durationSec: m.info?.durationSec ?? null,
    width: m.info?.width ?? null,
    height: m.info?.height ?? null,
    fps: m.info?.fps ?? null,
    hasAudio: m.info?.hasAudio ?? null,
    cuts: (m.cuts ?? []).slice(0, 2000),
    hardCuts: m.cutsHardOnly?.length ?? null,
    silences: (m.silences ?? []).slice(0, 2000),
    loudnessLufs: m.loudnessLufs ?? null,
    picture: m.picture ?? {},
    rhythm: m.rhythm ?? {},
    hook: hook?.features ?? {},
    hookVision: hook?.answer ?? null,
});

/** Queues the measurement; resolves when it is done (callers do not wait). */
export const measureLater = (videoId, handle, { deps = {} } = {}) => {
    if (!handle) return Promise.resolve(null);
    pending += 1;
    const job = chain.then(async () => {
        try {
            const measure = deps.measure ?? measureMedia;
            const m = await measure(handle.file, { hookFrames: true, workDir: handle.dir });
            if (!(m?.info?.durationSec > 0) || m.info.durationSec > MAX_SECONDS) return null;
            const hook = m.hookImage ? await (deps.describeHook ?? describeHook)(m.hookImage) : null;
            const mediaMeasure = toMediaMeasure(m, hook);
            const video = await Video.findByIdAndUpdate(videoId, { $set: { mediaMeasure } }, { new: true }).lean();
            if (video?.analysisStatus === 'completed') {
                const { upsertVideoFeatures } = await import('./learning.service.js');
                await upsertVideoFeatures(video);
            }
            return mediaMeasure;
        } catch (error) {
            console.warn(`[learning] measuring upload ${videoId} failed: ${error.message}`);
            return null;
        } finally {
            pending -= 1;
            await fsp.rm(handle.dir, { recursive: true, force: true }).catch(() => {});
        }
    });
    chain = job.catch(() => null);
    return job;
};
