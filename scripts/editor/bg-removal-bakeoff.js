/**
 * Background removal bake-off: the same clips through fal.ai veed (edge refinement on and off) and Bria,
 * so the owner can judge hair, hands and a moving background before launch.
 *
 *   FAL_KEY=... node scripts/editor/bg-removal-bakeoff.js clip1.mp4 clip2.mp4 ... [--out ./bakeoff-out] [--models veed-refine,veed-plain,bria]
 *   (clips are local files, or S3 keys such as editor/sources/<user>/<project>/master.mp4 when AWS_* and
 *    AWS_S3_BUCKET_NAME are set; 1 to 5 clips)
 *
 * Each clip is cut to a 720p proxy (like the real pipeline) and sent as a data URI (local) or a presigned
 * URL (S3). Writes into --out: <clip>-<variant>.webm (open them over a coloured background to judge the
 * edges), results.json and summary.md (seconds waited, clip seconds, estimated cost). Nothing is stored in
 * our S3 and the database is not touched. Prices are estimates from the vendor pages.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probe } from '../../src/lib/ffmpeg.js';
import { storage } from '../../src/lib/storage.js';
import { MODELS, buildFalInput, estimateCostUsd, extractVideoUrl, makeMatteProxy, runFalQueue } from '../../src/service/editor/bg-removal.service.js';

const VARIANTS = {
    'veed-refine': { model: 'veed', refine: true },
    'veed-plain': { model: 'veed', refine: false },
    bria: { model: 'bria', refine: true },
};

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : fallback;
};
const valueFlags = new Set(['--out', '--models']);
const clips = argv.filter((a, i) => !a.startsWith('--') && !valueFlags.has(argv[i - 1]));
const outDir = path.resolve(flag('--out', './bakeoff-out'));
const names = String(flag('--models', 'veed-refine,veed-plain,bria')).split(',').map((s) => s.trim()).filter(Boolean);

const die = (msg) => {
    console.error(msg);
    process.exit(1);
};
if (!process.env.FAL_KEY) die('Set FAL_KEY first, e.g. FAL_KEY=... node scripts/editor/bg-removal-bakeoff.js a.mp4 b.mp4');
if (!clips.length || clips.length > 5) die('Give 1 to 5 clips (local files or S3 keys).');
for (const n of names) if (!VARIANTS[n]) die(`Unknown model "${n}". Choose from: ${Object.keys(VARIANTS).join(', ')}`);

const slug = (s) => path.basename(s).replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_');

/** Local path for a clip: the file itself, or a download of the S3 key. */
async function localCopy(clip, dir) {
    if (fs.existsSync(clip)) return clip;
    // A Windows drive path, an absolute/relative path or a backslash means a local file was meant: say so plainly
    // instead of falling through to S3 (where a missing key surfaces as a confusing ListBucket permission error).
    if (/^[a-zA-Z]:[\\/]/.test(clip) || /^[.~/]/.test(clip) || clip.includes('\\')) {
        throw new Error(`Clip not found on this computer: ${clip}`);
    }
    const p = path.join(dir, `download-${slug(clip)}${path.extname(clip) || '.mp4'}`);
    await storage.downloadToFile(clip, p);
    return p;
}

async function main() {
    await fs.promises.mkdir(outDir, { recursive: true });
    const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bg-bakeoff-'));
    const rows = [];
    try {
        for (const clip of clips) {
            const src = await localCopy(clip, work);
            const info = await probe(src);
            const proxy = path.join(work, `${slug(clip)}-720p.mp4`);
            await makeMatteProxy(src, proxy);
            const videoUrl = `data:video/mp4;base64,${(await fs.promises.readFile(proxy)).toString('base64')}`;
            for (const name of names) {
                const { model, refine } = VARIANTS[name];
                const row = { clip, variant: name, clipSeconds: Math.round(info.durationSec * 10) / 10, estCostUsd: estimateCostUsd(model, info.durationSec, { refine }) };
                const started = Date.now();
                try {
                    const { requestId, result, inferenceSec } = await runFalQueue({ endpoint: MODELS[model].endpoint, input: buildFalInput(model, videoUrl, { refine }), apiKey: process.env.FAL_KEY });
                    const url = extractVideoUrl(result);
                    if (!url) throw new Error('no video in result');
                    const res = await fetch(url);
                    if (!res.ok) throw new Error(`download failed (${res.status})`);
                    const file = path.join(outDir, `${slug(clip)}-${name}.webm`);
                    await fs.promises.writeFile(file, Buffer.from(await res.arrayBuffer()));
                    Object.assign(row, { ok: true, requestId, file, inferenceSec, waitedSec: Math.round((Date.now() - started) / 100) / 10 });
                } catch (err) {
                    Object.assign(row, { ok: false, error: err.message, waitedSec: Math.round((Date.now() - started) / 100) / 10 });
                }
                rows.push(row);
                console.log(`${slug(clip)} ${name}: ${row.ok ? `ok in ${row.waitedSec}s` : `FAILED ${row.error}`}`);
            }
        }
    } finally {
        await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
    }
    const total = rows.reduce((n, r) => n + r.estCostUsd, 0);
    await fs.promises.writeFile(path.join(outDir, 'results.json'), JSON.stringify({ ranAt: new Date().toISOString(), totalEstCostUsd: Math.round(total * 100) / 100, rows }, null, 2));
    const md = [
        '# Background removal bake-off',
        '',
        '| Clip | Variant | Clip s | Waited s | Est. cost | Result |',
        '|---|---|---|---|---|---|',
        ...rows.map((r) => `| ${slug(r.clip)} | ${r.variant} | ${r.clipSeconds} | ${r.waitedSec} | $${r.estCostUsd.toFixed(3)} | ${r.ok ? path.basename(r.file) : `failed: ${r.error}`} |`),
        '',
        `Estimated total: $${total.toFixed(2)} (vendor list prices, not the invoice).`,
        '',
        'Judge: hair (curly or loose), hands in front of the body, a moving background, and flicker at the edges.',
    ].join('\n');
    await fs.promises.writeFile(path.join(outDir, 'summary.md'), md);
    console.log(`\nWrote ${path.join(outDir, 'summary.md')} and results.json. Estimated total $${total.toFixed(2)}.`);
}

main().catch((err) => die(err.message));
