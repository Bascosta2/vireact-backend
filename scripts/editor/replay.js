/**
 * Replay the editor on a local video, end to end, without uploading anything to storage:
 *   prepare (proxy, master, silences, scene changes, frame sheets) -> transcribe -> cut candidates ->
 *   Claude plans the edit -> render props -> a report of what plays and anything heard twice.
 *
 *   node scripts/editor/replay.js <video> [--out dir] [--skill remotion-reel] [--plan plan.json]
 *
 * Writes into --out: media.json, plan.json, props.json (videoUrl points at master.mp4 in that folder),
 * report.txt. --plan reuses a saved plan (no Claude call), so a code change can be re-checked for free.
 * Render the result with scripts/editor/render-local.sh (Remotion, local).
 *
 * Uses the dev database (same guard as the app) for the knowledge base, viral examples and sound
 * library; any of them failing falls back to empty, like a new install.
 */
import '../../src/config/load-env.js';
import fs from 'node:fs';
import path from 'node:path';
import { connectDb, disconnectDb, args, value } from '../research/_db.js';
import { prepareMedia } from '../../src/service/editor/media-prep.js';
import { transcribeWords } from '../../src/service/editor/transcribe.js';
import { buildCutCandidates, norm, repairWordTimings } from '../../src/service/editor/cut-candidates.js';
import { planEdit } from '../../src/service/editor/edit-planner.service.js';
import { buildRenderProps } from '../../src/service/editor/compose.js';

const src = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--out' && args[args.indexOf(a) - 1] !== '--skill' && args[args.indexOf(a) - 1] !== '--plan');
if (!src || !fs.existsSync(src)) {
    console.error('Usage: node scripts/editor/replay.js <video> [--out dir] [--skill id] [--plan plan.json]');
    process.exit(1);
}
const out = path.resolve(value('--out') ?? path.join(path.dirname(src), `replay-${path.parse(src).name}`));
const skill = value('--skill') ?? null;
const savedPlan = value('--plan');
fs.mkdirSync(out, { recursive: true });
const log = (...m) => console.log('[replay]', ...m);

let db = false;
try {
    await connectDb();
    db = true;
} catch (e) {
    log(`no database (${e.message}); knowledge, examples and sounds will be empty`);
}

try {
    const mediaFile = path.join(out, 'media.json');
    let media;
    let info;
    if (fs.existsSync(mediaFile) && fs.existsSync(path.join(out, 'master.mp4'))) {
        ({ media, info } = JSON.parse(fs.readFileSync(mediaFile, 'utf8')));
        log('reusing prepared media and transcript');
        if (!savedPlan) {
            // A fresh plan gets this code's timing repair and cut suggestions (a saved plan keeps the ids it chose).
            media.words = repairWordTimings(media.words, media.silences);
            media.cutCandidates = buildCutCandidates({ words: media.words, silences: media.silences, durationSec: info.durationSec });
            fs.writeFileSync(mediaFile, JSON.stringify({ media, info }, null, 2));
        }
    } else {
        log('preparing media');
        const prepared = await prepareMedia(path.resolve(src), out, { onStage: (s) => log(s) });
        info = prepared.info;
        log('transcribing');
        const raw = prepared.audioPath ? await transcribeWords(prepared.audioPath) : { words: [], language: null };
        const words = repairWordTimings(raw.words, prepared.silences);
        const { language } = raw;
        media = {
            words,
            silences: prepared.silences,
            sceneCuts: prepared.sceneCuts,
            loudnessLufs: prepared.loudnessLufs,
            frameSheets: prepared.sheets.map((s) => ({ key: s.path, from: s.from, to: s.to, cols: s.cols, rows: s.rows, intervalSec: s.intervalSec })),
            cutCandidates: buildCutCandidates({ words, silences: prepared.silences, durationSec: info.durationSec }),
            transcriptLanguage: language,
        };
        fs.writeFileSync(mediaFile, JSON.stringify({ media, info }, null, 2));
    }

    const project = { _id: 'replay', skill, source: { durationSec: info.durationSec, width: info.width, height: info.height, fps: info.fps, hasAudio: info.hasAudio }, media };
    let plan;
    if (savedPlan) {
        plan = JSON.parse(fs.readFileSync(savedPlan, 'utf8'));
        log('reusing plan', savedPlan);
    } else {
        log('planning with Claude');
        const safe = (fn, empty) => async (...a) => {
            if (!db) return empty;
            try { return await fn(...a); } catch (e) { log(`fallback: ${e.message}`); return empty; }
        };
        const { retrieveKnowledge } = await import('../../src/service/analyzer/retrieve-knowledge.js');
        const { selectExemplars } = await import('../../src/service/editor/exemplars.js');
        const { SoundAsset } = await import('../../src/model/sound-asset.model.js');
        const result = await planEdit({ project, profile: { niche: 'education', platforms: ['tiktok'], goal: 'grow' } }, {
            loadSheets: async (sheets) => (sheets ?? []).map((s) => ({ ...s, base64: fs.readFileSync(s.key).toString('base64') })),
            retrieve: safe(retrieveKnowledge, []),
            selectExemplars: safe(selectExemplars, { exemplars: [], benchmarks: null }),
            loadTracks: safe(() => SoundAsset.find({ active: true }).select('kind slug title mood energy bpm genre sfxType').lean(), []),
        });
        plan = result.plan;
        fs.writeFileSync(path.join(out, 'plan.json'), JSON.stringify(plan, null, 2));
    }

    const props = buildRenderProps(plan, {}, { words: media.words, silences: media.silences, cutCandidates: media.cutCandidates, durationSec: info.durationSec, skill });
    const sfxBase = process.env.PUBLIC_ASSETS_URL || 'https://www.vireact.io';
    const sfxUrls = Object.fromEntries([...new Set(props.sfx.map((s) => s.type))].map((t) => [t, `${sfxBase}/sfx/${t}.mp3`]));
    fs.writeFileSync(path.join(out, 'props.json'), JSON.stringify({ ...props, videoUrl: 'http://127.0.0.1:8765/master.mp4', musicUrl: null, sfxUrls }, null, 2));

    // What the viewer hears, in order, and any 4-word run heard twice.
    const heard = props.timeline.flatMap((p) => media.words.filter((w) => (w.start + w.end) / 2 >= p.srcStart && (w.start + w.end) / 2 < p.srcEnd));
    const seq = heard.map((w) => norm(w.w));
    const seen = new Map();
    const repeats = [];
    for (let i = 0; i + 4 <= seq.length; i += 1) {
        const k = seq.slice(i, i + 4).join(' ');
        if (seen.has(k)) repeats.push(k);
        else seen.set(k, i);
    }
    const lines = [
        `source ${info.durationSec.toFixed(1)}s -> edit ${(props.durationInFrames / 30).toFixed(1)}s, ${props.timeline.length} pieces, skill ${skill ?? 'none'}`,
        `segments: ${plan.segments.map((s) => `${s.id}[${s.role}] ${s.start}-${s.end}`).join(' | ')}`,
        `accepted cuts: ${plan.acceptedCandidateIds.length} of ${media.cutCandidates.length} candidates`,
        `pieces: ${props.timeline.map((p) => `${p.srcStart.toFixed(2)}-${p.srcEnd.toFixed(2)}${p.baseScale > 1 ? '*' : ''}`).join(' ')}`,
        `transitions: ${props.transitions.length}, zoom moves: ${props.zooms.length}, graphics: ${(props.graphics ?? []).map((g) => g.type).join(', ') || 'none'}`,
        `sounds: ${props.sfx.length} (${props.sfx.map((s) => `${s.type}@${(s.frame / 30).toFixed(1)}`).join(', ')})`,
        `hook: ${props.hook ? JSON.stringify(props.hook.text) : 'none'}`,
        '',
        'HEARD:',
        heard.map((w) => w.w).join(' '),
        '',
        repeats.length ? `REPEATED (4-word runs heard twice): ${[...new Set(repeats)].join(' | ')}` : 'No 4-word run is heard twice.',
    ];
    fs.writeFileSync(path.join(out, 'report.txt'), lines.join('\n'));
    console.log(lines.join('\n'));
    log('wrote', out);
} finally {
    if (db) await disconnectDb().catch(() => {});
}
