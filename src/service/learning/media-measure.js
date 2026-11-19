/**
 * Measures a local video file with the bundled ffmpeg (no AI, no network). Used for public videos in the
 * deep analyzer and for users' own uploads, so both are measured the same way.
 *
 * Two passes over the file:
 *   video  scaled to 360 px: per-frame scene-change score, brightness, saturation, motion
 *          -> adaptive cuts (media-signals.js detectCuts), picture stats
 *   audio  pauses (silencedetect), loudness (ebur128), RMS envelope every ~46 ms -> onsets, tempo
 * plus, optionally, one image with 3 frames from the first 3 seconds for the hook description.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { audioRhythm, detectCuts, envelopeFrom, frameStats, parseMetadataPrint } from './media-signals.js';

/** Bump when a measurement's meaning changes. */
export const MEASURE_VERSION = 2;

/** ffmpeg filter option values cannot hold a drive colon; Windows paths keep working without it. */
const filterPath = (p) => p.split('\\').join('/').replace(/^[A-Za-z]:/, '');

/**
 * @returns {Promise<{ info, cuts, cutsHardOnly, silences, loudnessLufs, picture, rhythm, hookImage: string|null }>}
 *   hookImage is a path inside `workDir` (caller deletes the folder).
 */
export const measureMedia = async (file, { hookFrames = false, workDir = null } = {}) => {
    const { ffmpeg, probe, parseSilences, parseLoudness } = await import('../../lib/ffmpeg.js');
    const dir = workDir ?? await fsp.mkdtemp(path.join(os.tmpdir(), 'vx-measure-'));
    const own = !workDir;
    try {
        const info = await probe(file);
        const vMeta = path.join(dir, 'video-meta.txt');
        await ffmpeg(['-i', file, '-an', '-vf', `scale=360:-2,signalstats,select='gte(scene\\,0)',metadata=mode=print:file=${filterPath(vMeta)}`, '-f', 'null', '-'], { timeoutMs: 6 * 60_000 });
        const frames = parseMetadataPrint(await fsp.readFile(vMeta, 'utf8').catch(() => ''));
        const cuts = detectCuts(frames);
        const cutsHardOnly = detectCuts(frames, { soft: 1.01 });

        let silences = [];
        let loudnessLufs = null;
        let rhythm = {};
        if (info.hasAudio) {
            const aMeta = path.join(dir, 'audio-meta.txt');
            const { stderr } = await ffmpeg(['-i', file, '-vn', '-af',
                `silencedetect=noise=-35dB:d=0.3,ebur128=framelog=quiet,aresample=22050,asetnsamples=n=1024:p=0,astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=${filterPath(aMeta)}`,
                '-f', 'null', '-'], { timeoutMs: 6 * 60_000 });
            silences = parseSilences(stderr, info.durationSec);
            loudnessLufs = parseLoudness(stderr);
            const env = envelopeFrom(parseMetadataPrint(await fsp.readFile(aMeta, 'utf8').catch(() => '')));
            rhythm = audioRhythm(env, cuts, info.durationSec);
        }

        let hookImage = null;
        // Only with a caller-owned workDir: the image must outlive this function.
        if (hookFrames && !own && info.durationSec >= 1) {
            const fps = info.fps > 0 ? info.fps : 30;
            const at = [0.5, 1.5, 2.5].filter((t) => t < info.durationSec).map((t) => Math.round(t * fps));
            const pick = at.map((n) => `eq(n\\,${n})`).join('+');
            hookImage = path.join(dir, 'hook.jpg');
            try {
                await ffmpeg(['-i', file, '-vf', `select='${pick}',scale=-2:480,tile=${at.length}x1`, '-frames:v', '1', '-fps_mode', 'vfr', '-update', '1', '-q:v', '5', hookImage], { timeoutMs: 60_000 });
            } catch {
                hookImage = null;
            }
        }
        return { info, cuts, cutsHardOnly, silences, loudnessLufs, picture: frameStats(frames), rhythm, hookImage, version: MEASURE_VERSION };
    } finally {
        if (own) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
};
