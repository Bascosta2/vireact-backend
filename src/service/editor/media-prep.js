import fs from 'node:fs';
import path from 'node:path';
import { ffmpeg, probe, parseLoudness, parseSceneCuts, parseSilences } from '../../lib/ffmpeg.js';

/**
 * Local media preparation for one edit (no network, no database): probe, a 720p proxy for the
 * browser preview, a small mono audio file for transcription, pauses, loudness, scene cuts, frame
 * contact sheets for Claude, and a thumbnail. Tested against a real generated clip.
 */

export const LIMITS = Object.freeze({ maxDurationSec: 180, minDurationSec: 3 });
const SHEET_COLS = 3;
const SHEET_ROWS = 3;
const MAX_SHEET_FRAMES = 108; // 12 sheets of 9 frames
const PROXY_LONG_EDGE = 1280;
const MASTER_LONG_EDGE = 1920;
const CELL_LONG_EDGE = 426;

const longEdge = (n) => `scale='if(gt(iw,ih),min(${n},iw),-2)':'if(gt(iw,ih),-2,min(${n},ih))'`;

/** One frame every `interval` seconds, so a clip never needs more than MAX_SHEET_FRAMES frames. */
export const sheetInterval = (durationSec) => Math.max(1, Math.ceil((Number(durationSec) || 0) / MAX_SHEET_FRAMES));

export class MediaError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MediaError';
        this.userFacing = true;
    }
}

export async function prepareMedia(srcPath, workDir, { onStage = () => {} } = {}) {
    await fs.promises.mkdir(path.join(workDir, 'frames'), { recursive: true });

    onStage('checking', 8);
    const info = await probe(srcPath);
    if (!info.durationSec || info.durationSec < LIMITS.minDurationSec) throw new MediaError('This video is too short to edit. Upload at least 3 seconds.');
    if (info.durationSec > LIMITS.maxDurationSec + 1) throw new MediaError('Videos can be up to 3 minutes long. Trim it and try again.');

    onStage('preparing preview', 15);
    const proxyPath = path.join(workDir, 'proxy.mp4');
    const fpsOut = Math.min(30, Math.round(info.fps || 30));
    await ffmpeg([
        '-i', srcPath,
        '-vf', longEdge(PROXY_LONG_EDGE),
        '-r', String(fpsOut),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-g', String(fpsOut),
        ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
        '-movflags', '+faststart',
        proxyPath,
    ]);

    // Render master: what the export renders from. Constant 30 fps, a keyframe every second, rotation
    // applied, H.264 at most 1080p. Phone uploads (variable frame rate, HEVC, rotation flags) otherwise
    // make the renderer's frame lookups fail.
    onStage('preparing preview', 22);
    const masterPath = path.join(workDir, 'master.mp4');
    await ffmpeg([
        '-i', srcPath,
        '-vf', `${longEdge(MASTER_LONG_EDGE)},fps=30`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
        '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-bf', '0',
        ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'] : ['-an']),
        '-movflags', '+faststart',
        masterPath,
    ]);

    let audioPath = null;
    let silences = [];
    let loudnessLufs = null;
    if (info.hasAudio) {
        onStage('reading audio', 30);
        audioPath = path.join(workDir, 'audio.mp3');
        await ffmpeg(['-i', srcPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '48k', audioPath]);
        const { stderr } = await ffmpeg(['-i', audioPath, '-af', 'silencedetect=noise=-35dB:d=0.3,ebur128=framelog=quiet', '-f', 'null', '-']);
        silences = parseSilences(stderr, info.durationSec);
        loudnessLufs = parseLoudness(stderr);
    }

    onStage('finding scene changes', 40);
    const { stderr: sceneLog } = await ffmpeg(['-i', proxyPath, '-an', '-vf', "select='gt(scene,0.3)',showinfo", '-f', 'null', '-']);
    const sceneCuts = parseSceneCuts(sceneLog);

    onStage('sampling frames', 50);
    const interval = sheetInterval(info.durationSec);
    await ffmpeg([
        '-i', proxyPath,
        '-vf', `fps=1/${interval},${longEdge(CELL_LONG_EDGE)},tile=${SHEET_COLS}x${SHEET_ROWS}`,
        '-q:v', '4',
        path.join(workDir, 'frames', 'sheet_%03d.jpg'),
    ]);
    const perSheet = SHEET_COLS * SHEET_ROWS * interval;
    const sheets = (await fs.promises.readdir(path.join(workDir, 'frames')))
        .filter((f) => f.endsWith('.jpg'))
        .sort()
        .map((f, k) => ({
            path: path.join(workDir, 'frames', f),
            name: f,
            from: k * perSheet,
            to: Math.min(info.durationSec, (k + 1) * perSheet),
            cols: SHEET_COLS,
            rows: SHEET_ROWS,
            intervalSec: interval,
        }));

    const thumbPath = path.join(workDir, 'thumb.jpg');
    await ffmpeg(['-ss', String(Math.min(1, info.durationSec / 2)), '-i', proxyPath, '-frames:v', '1', '-vf', longEdge(640), '-q:v', '4', thumbPath]);

    return { info, proxyPath, masterPath, audioPath, thumbPath, silences, loudnessLufs, sceneCuts, sheets };
}
