/**
 * Sample PNG frames from a finished storyboard render for visual QA (Step 4).
 * Uses the same ffmpeg wrapper as media-prep. Returns empty arrays when the file
 * cannot be read so QA stays advisory and never blocks the export path.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ffmpeg } from '../../lib/ffmpeg.js';
import { storage } from '../../lib/storage.js';

/**
 * Build an extractFrames(deps) function bound to one finished render's S3 key and
 * the project's storyboard timing. Downloads the MP4 once into a temp file.
 */
export function makeFrameExtractor({ renderKey, timing = [], fps = 30, store = storage } = {}) {
    let localPath = null;
    let preparing = null;

    const ensureLocal = async () => {
        if (localPath) return localPath;
        if (preparing) return preparing;
        preparing = (async () => {
            const tmp = path.join(os.tmpdir(), `vireact-vqa-${Date.now()}.mp4`);
            if (typeof store.downloadToFile === 'function') {
                await store.downloadToFile(renderKey, tmp);
            } else {
                const buf = await store.readBuffer(renderKey);
                await fs.writeFile(tmp, buf);
            }
            localPath = tmp;
            return localPath;
        })().finally(() => { preparing = null; });
        return preparing;
    };

    return async function extractFrames({ sceneIdx, framesPerScene = 3 } = {}) {
        const scene = timing[sceneIdx];
        if (!scene) return [];
        const start = Number(scene.start) || 0;
        const end = Number(scene.end) || start + 3;
        const dur = Math.max(0.5, end - start);
        const src = await ensureLocal();
        const out = [];
        for (let k = 0; k < framesPerScene; k += 1) {
            const t = start + (dur * (k + 0.5)) / framesPerScene;
            const pngPath = path.join(os.tmpdir(), `vireact-vqa-f-${sceneIdx}-${k}-${Date.now()}.png`);
            try {
                await ffmpeg(['-ss', String(t.toFixed(3)), '-i', src, '-frames:v', '1', '-vf', 'scale=512:-2', '-y', pngPath]);
                out.push(await fs.readFile(pngPath));
            } catch (_err) {
                // Skip this frame; aggregateScene treats missing frames as inconclusive.
            } finally {
                await fs.unlink(pngPath).catch(() => {});
            }
        }
        return out;
    };
}
