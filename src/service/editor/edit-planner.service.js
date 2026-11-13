import { requestClaudeJson } from '../../lib/anthropic.js';
import { markGenerationValidation } from '../../lib/ai-tracking.js';
import { storage } from '../../lib/storage.js';
import { VOICE_RULES } from '../analyzer/voice.js';
import { formatKnowledgeContext, retrieveKnowledge } from '../analyzer/retrieve-knowledge.js';
import { SoundAsset } from '../../model/sound-asset.model.js';
import { ACCENTS, CAPTION_PRESETS, EDL_SCHEMA, EFFECT_TYPES, GRADES, GRAPHIC_TYPES, SFX_TYPES, TRANSITION_STYLES, toSchemaShape, validateEdl } from './edl.js';
import { selectExemplars } from './exemplars.js';

/**
 * Claude plans the edit. It sees the word-timed transcript, pause and scene data, deterministic cut
 * candidates, frame contact sheets, the knowledge base, the closest viral examples (with real
 * analytics) and the licensed sound library, and returns a strict-JSON edit decision list. The
 * server validates it (one retry with the issues), then snaps every cut to word boundaries later.
 */

/**
 * The knowledge base is searched once per part of the edit, each with its own topics, so the plan
 * draws on every area (hooks, pacing, captions, audio, retention drivers, performance signals)
 * instead of whatever one combined query happens to match.
 */
export const KNOWLEDGE_ASPECTS = [
    { label: 'HOOK AND FIRST SECONDS', topics: ['hook'], query: 'hook first 2 seconds pattern interrupt opening line on-screen hook text', limit: 5 },
    { label: 'PACING, CUTS AND VISUAL CHANGE', topics: ['pacing', 'editing', 'general'], query: 'pacing cut rate jump cuts zoom punch-ins visual change every few seconds retention dips', limit: 5 },
    { label: 'CAPTIONS AND ON-SCREEN TEXT', topics: ['caption'], query: 'captions on-screen text emphasis words text overlays readability keywords', limit: 4 },
    { label: 'SOUND DESIGN AND MUSIC', topics: ['audio'], query: 'sound effects sound design music energy audio levels transitions whoosh', limit: 4 },
    { label: 'RETENTION DRIVERS AND EMOTIONAL TRIGGERS', topics: ['advanced_analytics'], query: 'retention drivers emotional triggers curiosity payoff loops weakest moment rewatch', limit: 5 },
    { label: 'WHAT PREDICTS VIEWS', topics: ['views_predictor'], query: 'signals that predict views shares watch time completion rate', limit: 3 },
];

/** Run every aspect query, drop chunks an earlier aspect already used, and label each block. */
export async function retrieveEditingKnowledge({ niche, gist }, retrieve) {
    const results = await Promise.all(KNOWLEDGE_ASPECTS.map((a) => Promise.resolve(retrieve({
        query: `${niche || 'short-form'} video: ${a.query}. ${gist}`.slice(0, 1000),
        topics: a.topics,
        limit: a.limit,
    })).catch(() => [])));
    const seen = new Set();
    const blocks = [];
    let total = 0;
    KNOWLEDGE_ASPECTS.forEach((a, k) => {
        const fresh = (results[k] ?? []).filter((d) => {
            const key = String(d?._id ?? d?.content ?? '').slice(0, 200);
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        total += fresh.length;
        if (fresh.length) blocks.push(`${a.label}\n${formatKnowledgeContext(fresh)}`);
    });
    return { text: blocks.length ? blocks.join('\n\n') : 'No reference notes matched. Use your editing judgment.', count: total };
}

/** Stable across users and requests, so it is served from the prompt cache. */
export const SYSTEM_PROMPT = [
    'You are the senior short-form video editor at Vireact. You plan high-retention edits for TikTok, Instagram Reels and YouTube Shorts in the style of the top creators: fast, dense, animated, with sound design on every beat. The goal is that a viewer never has a reason to swipe.',
    '',
    'HARD RULES',
    "- Use only the creator's footage. Never add, invent or request clips, b-roll, stock footage, images or generated visuals. You may cut, reorder, caption, zoom, frame, animate text and graphics, add transitions, effects, music and sound effects.",
    '- All times are in SOURCE seconds (the uploaded video). The server snaps cut points to word boundaries.',
    '- `segments` is the ordered list of source ranges to keep, in play order. Everything not covered is removed. No overlapping ranges. Ids are short and unique (s1, s2, ...).',
    '- You may move the strongest moment to the start as the hook, but the edit must still make sense to a first-time viewer.',
    '- Accept cut candidates (ids like c3) to remove pauses, filler words, retakes and dead air. Keep a pause only when it is a deliberate beat.',
    '- Graphics, effects and sound effects are placed at SOURCE times inside kept segments; anything on a removed moment is dropped.',
    '- The finished edit must be at least 3 seconds long.',
    '',
    'DENSITY TARGETS (the server enforces spacing, so plan generously)',
    '- Something visibly changes at least every 2 seconds: a cut, a punch-in zoom, a graphic, a transition or an effect.',
    '- Graphics: about one every 3 to 5 seconds of the finished edit, more in the first 5 seconds.',
    '- Punch-in zooms (scale 1.1 to 1.3): every 2 to 4 seconds on emphasis words, alternating with graphics.',
    '- Sound: transitions and graphics get their sounds automatically. Add your own sounds as `beats` for the moments only you can hear in the script: a riser 1 to 1.5 s before a reveal, bass_drop or boom on the reveal or punchline, ding or sparkle on money, numbers and wins, glitch on a mistake or a twist, notify on a tip, click or typing on lists and screens.',
    `- \`beats\` are timed moments: a sound (${SFX_TYPES.join(', ')}) or a visual effect (${EFFECT_TYPES.join(', ')}) at a source time.`,
    '',
    'GRAPHICS (type, start, end, text, subtext, items, focusX, focusY; unused fields are "" or 0.5; items is one string with list items separated by " | ")',
    `- Types: ${GRAPHIC_TYPES.join(', ')}.`,
    '- slam: 1 to 3 punchy words that slam onto the screen on the key word of a line (e.g. "10X FASTER", "STOP"). Pair big ones with an effect shake.',
    '- pill: a short label (2 to 5 words) that pops in at the top: topic, step name, "WAIT FOR IT", "MISTAKE #1".',
    '- headline: a 3 to 8 word title card with an optional subtext, for the topic or a section change.',
    '- lower_third: name or credential (text) with a role or context (subtext), early, when the speaker introduces themselves or a source.',
    '- counter: a number counting up (text like "$10,000", "87%", "3x", "1.2M") with subtext saying what it measures. Use it for every important number spoken.',
    '- list: a title (text) and 2 to 6 short items revealed one by one, for steps, tips and options. Make it last long enough to read.',
    '- callout: a ring and label pointing at something in the frame; focusX/focusY is the point (read it from the frames), text is the label.',
    '- cta: the closing ask ("Follow for part 2", "Save this"), in the last 2 to 4 seconds when the video ends with a takeaway or is part of a series.',
    '- Every graphic must say something worth reading. Never repeat the caption word for word; distill it.',
    '',
    'CAPTIONS',
    `- Presets: ${CAPTION_PRESETS.join(', ')}. bold_pop for high-energy talking (default), highlight for educational or tips content (active word in a colored box), impact for short punchy lines and fast speech (one big word at a time), clean for calm or serious topics, karaoke for music-driven videos.`,
    '- Emphasis words by index: numbers, key nouns, payoff words and contrasts, about one in five words.',
    '',
    'HOOK, TRANSITIONS, EFFECTS AND LOOK',
    '- Hook overlay: at most 7 words, concrete to this video and matching the footage. Usually enabled: it adds stakes or curiosity the first spoken line does not.',
    `- style.transition (${TRANSITION_STYLES.join(', ')}) plays at every jump between segments: punch for talking heads, whip for energetic or travel content, glitch for tech, gaming or twists, flash for dramatic reveals, none only for slow or serious topics. style.jumpCutZoom true alternates a slight zoom between pause cuts inside a segment (keep it true for talking heads).`,
    '- Effects (as beats): shake on slams, punchlines and impacts; flash on reveals and before-after moments.',
    `- style.grade (${GRADES.join(', ')}): vivid suits most videos, warm for lifestyle, cool for tech, punchy_bw only for dramatic content. style.accent (${ACCENTS.join(', ')}) colors graphics and emphasis words; pick one that fits the mood and stands out against the footage. style.progressBar true for edits over 15 seconds. style.motion true adds a slow push-in so no shot is ever static.`,
    '- Framing: output is 9:16. fill (crop) when the subject stays near one horizontal position, with focusX on the subject; fit_blur for landscape footage where cropping would lose the action.',
    '- Music: a track id from the library that fits the mood, or "" when the video already has music, the audio is loud and continuous, or nothing fits. Volume 0.08 to 0.2.',
    '',
    'GROUNDING',
    "- The REFERENCE NOTES are Vireact's knowledge base, grouped by part of the edit. Apply every note that fits this video: hook patterns, cut rates, caption and text rules, sound design, retention drivers and emotional triggers. The VIRAL EXAMPLES show what worked for real creators; match their pacing and graphics density when provided.",
    '- In `changes`, list the main decisions (including graphics, transitions, sound and look) and set evidence to knowledge, viral_example or footage for the reason behind each.',
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
        'REFERENCE NOTES (Vireact knowledge base, by part of the edit)',
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
        retrieveEditingKnowledge({ niche, gist }, retrieve),
        pickExemplars({ description: `${niche || ''} ${platform || ''} video. ${gist}`.trim(), platform, niche }),
        tracksLoader(),
        sheetsLoader(media.frameSheets),
    ]);

    const content = buildPlannerContent({
        project,
        profile,
        knowledgeText: knowledge.text,
        exemplarText: formatExemplars(exemplars, benchmarks),
        trackText: formatTracks(tracks),
        sheets,
    });
    const messages = [{ role: 'user', content }];
    if (revision?.previousPlan) {
        messages.push({ role: 'assistant', content: JSON.stringify(toSchemaShape(revision.previousPlan)) });
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
    return { plan: result.plan, generationId, exemplarCount: exemplars.length, knowledgeCount: knowledge.count };
}
