import { requestClaudeJson } from '../../lib/anthropic.js';
import { markGenerationValidation } from '../../lib/ai-tracking.js';
import { storage } from '../../lib/storage.js';
import { VOICE_RULES } from '../analyzer/voice.js';
import { formatKnowledgeContext, retrieveKnowledge } from '../analyzer/retrieve-knowledge.js';
import { SoundAsset } from '../../model/sound-asset.model.js';
import { CAPTION_PRESETS, EDL_SCHEMA, SFX_TYPES, validateEdl } from './edl.js';
import { selectExemplars } from './exemplars.js';

/**
 * Claude plans the edit. It sees the word-timed transcript, pause and scene data, deterministic cut
 * candidates, frame contact sheets, the knowledge base, the closest viral examples (with real
 * analytics) and the licensed sound library, and returns a strict-JSON edit decision list. The
 * server validates it (one retry with the issues), then snaps every cut to word boundaries later.
 */

const KNOWLEDGE_TOPICS = ['hook', 'pacing', 'caption', 'audio', 'editing', 'general'];

/** Stable across users and requests, so it is served from the prompt cache. */
export const SYSTEM_PROMPT = [
    'You are the senior short-form video editor at Vireact. You plan edits for TikTok, Instagram Reels and YouTube Shorts that give a creator\'s own footage its best chance to hold viewers and get shared.',
    '',
    'HARD RULES',
    '- Use only the creator\'s footage. Never add, invent or request clips, b-roll, stock footage, images or generated visuals. You may cut, reorder, caption, zoom, frame, add text, add music and add sound effects from the provided library.',
    '- All times are in SOURCE seconds (the uploaded video). The server snaps your cut points to word boundaries, so you do not need frame accuracy.',
    '- `segments` is the ordered list of source ranges to keep, in the order they should play. Everything not covered is removed. Each moment can be used at most once (no overlapping ranges). Ids are short and unique (s1, s2, ...).',
    '- You may move the strongest moment to the start as the hook, but the edit must still make sense to a first-time viewer. Do not reorder in ways that break cause and effect.',
    '- Accept cut candidates (ids like c3) to remove pauses, filler words, retakes and dead air inside the parts you keep. Leave a candidate out when the pause is a deliberate beat or the word carries meaning.',
    '- The finished edit must be at least 3 seconds long.',
    '',
    'CRAFT',
    '- First 2 seconds: show the payoff, the stakes or a question the video answers. Cut every lead-in, greeting and setup that does not earn its place.',
    '- Pacing: aim for the shot length and cut rate of the strongest viral examples in this niche when they are provided. Remove dead air, keep breaths short.',
    `- Captions: pick a preset (${CAPTION_PRESETS.join(', ')}). Bold_pop for high-energy talking, clean for calm or informational, karaoke for fast speech or music-driven videos. Choose emphasis words by index: numbers, key nouns and the payoff words, roughly one in six words at most.`,
    '- Hook overlay: at most 7 words, concrete to this video, matches what the footage actually shows. Enable it only when it adds something the first spoken line does not.',
    '- Zooms: punch-ins of 1.08 to 1.25 on emphasis moments, never more than one every 3 seconds. Use the frames to place focusX/focusY (0-1) on the face or subject.',
    '- Framing: output is 9:16. Use fill (crop) when the subject stays near one horizontal position, with focusX on the subject. Use fit_blur for landscape footage where cropping would lose the action.',
    '- Text overlays: only for steps, numbers or labels that help the viewer follow. Short.',
    `- Music: pick a track id from the library that fits the mood and energy, or "" when the video already has music, the audio is loud and continuous, or nothing fits. Volume 0.08 to 0.2 so speech stays clear. Sound effects (${SFX_TYPES.join(', ')}): sparing, on reveals and transitions, at most one every 4 seconds.`,
    '- Ground decisions in the reference notes and viral examples when they apply. In `changes`, set evidence to knowledge, viral_example or footage for the main reason behind each change.',
    '- Never promise results. `expectedEffect` says what the viewer will experience differently, not view counts.',
    '',
    'WRITING (summary, hookStrategy, changes, expectedEffect, reasons)',
    VOICE_RULES,
    '',
    'Return only the JSON object that matches the schema.',
].join('\n');

const t = (s) => (Number.isFinite(s) ? s.toFixed(2) : '?');

export function formatTranscript(words) {
    if (!words?.length) return 'No speech was detected. Plan the edit from the frames, scene changes and audio.';
    return words.map((w, i) => `[${i}] ${t(w.start)}-${t(w.end)} ${w.w}`).join('\n');
}

export function formatCandidates(candidates) {
    if (!candidates?.length) return 'None.';
    return candidates.map((c) => `${c.id} ${c.kind} ${t(c.start)}-${t(c.end)}${c.text ? ` "${c.text}"` : ''}`).join('\n');
}

export function formatExemplars(exemplars, benchmarks) {
    if (!exemplars?.length) return 'No viral examples are available yet. Rely on the reference notes.';
    const lines = exemplars.map((e, k) => {
        const p = e.editProfile ?? {};
        const metrics = [
            `${(e.actualViews ?? 0).toLocaleString('en-US')} views`,
            e.retentionRate != null ? `retention ${e.retentionRate}` : null,
            e.shares != null ? `${e.shares.toLocaleString('en-US')} shares` : null,
            e.followers != null ? `${e.followers.toLocaleString('en-US')} followers` : null,
        ].filter(Boolean).join(', ');
        return [
            `Example ${k + 1} (${e.platform}${e.niche ? `, ${e.niche}` : ''}): ${metrics}`,
            `  edit: ${p.durationSec ?? '?'}s, avg shot ${p.avgShotSec ?? '?'}s, ${p.cutsPerMin ?? '?'} cuts/min, ${p.zoomsPerMin ?? '?'} zooms/min, speech ${p.speechWpm ?? '?'} wpm`,
            `  hook: ${p.hookPattern ?? '?'}; first 2s: ${p.hookFirst2s ?? '?'}`,
            `  captions: ${p.captionStyle ?? '?'} (${p.captionDensity ?? '?'}); text overlays: ${p.textOverlayUse ?? '?'}; music: ${p.musicPresence ?? '?'}; sfx: ${p.sfxUse ?? '?'}`,
            p.summary ? `  takeaway: ${p.summary}` : null,
        ].filter(Boolean).join('\n');
    });
    const b = benchmarks
        ? `Benchmarks from ${b2(benchmarks)}`
        : '';
    return [...lines, b].filter(Boolean).join('\n\n');
}

const b2 = (b) => `${b.scope} (n=${b.sample}): avg shot ${b.avgShotSec ?? '?'}s, ${b.cutsPerMin ?? '?'} cuts/min, ${b.zoomsPerMin ?? '?'} zooms/min, speech ${b.speechWpm ?? '?'} wpm, length ${b.durationSec ?? '?'}s.`;

export function formatTracks(tracks) {
    const music = tracks.filter((x) => x.kind === 'music');
    if (!music.length) return 'No music tracks are available. Set music.trackId to "".';
    return music.map((m) => `${m.slug}: "${m.title}", mood ${m.mood ?? '?'}, energy ${m.energy ?? '?'}/5${m.bpm ? `, ${m.bpm} bpm` : ''}${m.genre ? `, ${m.genre}` : ''}`).join('\n');
}

/** User-turn content: text context, then each frame sheet with its time range. */
export function buildPlannerContent({ project, profile, knowledgeText, exemplarText, trackText, sheets }) {
    const src = project.source ?? {};
    const media = project.media ?? {};
    const intro = [
        'CREATOR',
        `Niche: ${profile?.niche || 'unknown'}. Platforms: ${(profile?.platforms ?? []).join(', ') || 'unknown'}. Goal: ${profile?.goal || 'unknown'}.`,
        '',
        'VIDEO',
        `Duration ${t(src.durationSec)}s, ${src.width}x${src.height}, ${src.fps ?? '?'} fps, audio ${src.hasAudio ? 'yes' : 'no'}${media.loudnessLufs != null ? `, loudness ${media.loudnessLufs} LUFS` : ''}.`,
        `Scene changes at: ${(media.sceneCuts ?? []).map(t).join(', ') || 'none detected'}.`,
        `Pauses: ${(media.silences ?? []).map((s) => `${t(s.start)}-${t(s.end)}`).join(', ') || 'none detected'}.`,
        '',
        'TRANSCRIPT (word index, start-end seconds, word)',
        formatTranscript(media.words),
        '',
        'CUT CANDIDATES (accept by id)',
        formatCandidates(media.cutCandidates),
        '',
        'REFERENCE NOTES',
        knowledgeText,
        '',
        'VIRAL EXAMPLES (real videos and their real results)',
        exemplarText,
        '',
        'MUSIC LIBRARY (music.trackId must be one of these ids, or "")',
        trackText,
        '',
        `FRAMES: ${sheets.length} contact sheet(s) follow. Each is a ${sheets[0]?.cols ?? 3}x${sheets[0]?.rows ?? 3} grid read left to right, top to bottom, one frame every ${sheets[0]?.intervalSec ?? 1}s.`,
    ].join('\n');
    const content = [{ type: 'text', text: intro }];
    for (const s of sheets) {
        content.push({ type: 'text', text: `Sheet covering ${t(s.from)}s to ${t(s.to)}s:` });
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: s.base64 } });
    }
    content.push({ type: 'text', text: 'Plan the edit now.' });
    return content;
}

const loadSheets = async (frameSheets) => Promise.all((frameSheets ?? []).map(async (s) => ({
    ...s,
    intervalSec: s.intervalSec ?? 1,
    base64: (await storage.readBuffer(s.key)).toString('base64'),
})));

const loadTracks = () => SoundAsset.find({ active: true }).select('kind slug title mood energy bpm genre sfxType').lean();

/**
 * @param {object} args
 * @param {object} args.project EditProject (lean) with media filled in
 * @param {object} args.profile resolved creator profile
 * @param {{note?:string, previousPlan?:object}} [args.revision] regenerate with the creator's note
 * @returns {Promise<{plan:object, generationId:string|null, exemplarCount:number}>}
 */
export async function planEdit({ project, profile, revision = null }, deps = {}) {
    const request = deps.request ?? requestClaudeJson;
    const retrieve = deps.retrieve ?? retrieveKnowledge;
    const pickExemplars = deps.selectExemplars ?? selectExemplars;
    const sheetsLoader = deps.loadSheets ?? loadSheets;
    const tracksLoader = deps.loadTracks ?? loadTracks;

    const media = project.media ?? {};
    const words = media.words ?? [];
    const gist = words.slice(0, 80).map((w) => w.w).join(' ');
    const niche = profile?.niche || null;
    const platform = profile?.platforms?.[0] || null;

    const [knowledge, { exemplars, benchmarks }, tracks, sheets] = await Promise.all([
        retrieve({ query: `${niche || 'short-form'} video editing: hook, pacing, captions, cuts. ${gist}`.slice(0, 1000), topics: KNOWLEDGE_TOPICS, limit: 8 }),
        pickExemplars({ description: `${niche || ''} ${platform || ''} video. ${gist}`.trim(), platform, niche }),
        tracksLoader(),
        sheetsLoader(media.frameSheets),
    ]);

    const content = buildPlannerContent({
        project,
        profile,
        knowledgeText: formatKnowledgeContext(knowledge, 'No reference notes matched. Use your editing judgment.'),
        exemplarText: formatExemplars(exemplars, benchmarks),
        trackText: formatTracks(tracks),
        sheets,
    });
    const messages = [{ role: 'user', content }];
    if (revision?.previousPlan) {
        messages.push({ role: 'assistant', content: JSON.stringify(revision.previousPlan) });
        messages.push({ role: 'user', content: `The creator reviewed that edit and asks: "${String(revision.note ?? '').slice(0, 500)}". Return a revised full plan that follows their request and every rule above.` });
    }

    const ctx = {
        durationSec: project.source?.durationSec ?? 0,
        wordCount: words.length,
        candidateIds: (media.cutCandidates ?? []).map((c) => c.id),
        candidateRanges: Object.fromEntries((media.cutCandidates ?? []).map((c) => [c.id, c])),
        trackIds: tracks.filter((x) => x.kind === 'music').map((x) => x.slug),
    };
    const system = [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];

    const first = await request({ label: 'editor_plan', system, messages, schema: EDL_SCHEMA });
    let result = validateEdl(first.data, ctx);
    markGenerationValidation(first.generationId, { passed: result.ok, issues: result.issues });
    let generationId = first.generationId;

    if (!result.ok) {
        const retryMessages = [
            ...messages,
            { role: 'assistant', content: first.message.content },
            { role: 'user', content: `That plan has problems. Fix all of them and return the full corrected plan:\n- ${result.issues.join('\n- ')}` },
        ];
        const second = await request({ label: 'editor_plan_retry', system, messages: retryMessages, schema: EDL_SCHEMA });
        result = validateEdl(second.data, ctx);
        markGenerationValidation(second.generationId, { passed: result.ok, issues: result.issues });
        generationId = second.generationId;
        if (!result.ok) {
            const err = new Error(`Edit plan failed validation: ${result.issues.join('; ')}`);
            err.issues = result.issues;
            throw err;
        }
    }
    return { plan: result.plan, generationId, exemplarCount: exemplars.length };
}
