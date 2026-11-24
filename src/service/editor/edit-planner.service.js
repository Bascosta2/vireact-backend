import { requestClaudeJson } from '../../lib/anthropic.js';
import { markGenerationValidation } from '../../lib/ai-tracking.js';
import { storage } from '../../lib/storage.js';
import { VOICE_RULES } from '../analyzer/voice.js';
import { formatKnowledgeContext, retrieveKnowledge } from '../analyzer/retrieve-knowledge.js';
import { SoundAsset } from '../../model/sound-asset.model.js';
import { ACCENTS, CAPTION_PRESETS, EDL_SCHEMA, EFFECT_TYPES, GRADES, GRAPHIC_TYPES, SFX_FAMILIES, TRANSITION_STYLES, VISUALS, toSchemaShape, validateEdl } from './edl.js';
import { selectExemplars } from './exemplars.js';
import { activeSkillId, skillFor } from './skills.js';

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
    'You are the senior short-form video editor at Vireact. You plan high-retention edits for TikTok, Instagram Reels and YouTube Shorts the way the best editors do: tight, clean and story-first. Every element earns its place. Removing dead air, filler and repeated takes does most of the work; graphics, zooms and sounds are accents on the moments that matter, never wallpaper. A viewer should feel a confident, smooth video, not an effects reel.',
    '',
    'HARD RULES',
    "- Use only the creator's footage. Never add, invent or request clips, b-roll, stock footage, photos or generated images. You may cut, reorder, caption, zoom, frame, animate text and graphics, show the built-in animated illustrations (graphic type visual, names under VISUALS), and add transitions, effects, music and sound effects.",
    '- All times are in SOURCE seconds (the uploaded video). The server snaps cut points to word boundaries.',
    '- `segments` is the ordered list of source ranges to keep, in play order. Everything not covered is removed. No overlapping ranges. Ids are short and unique (s1, s2, ...).',
    '- Use few, long segments. A segment starts at the start of a sentence and ends at the end of a sentence (at a pause), never in the middle of a phrase: a cut that clips a word or splits a sentence is the worst mistake an edit can make. Pauses, filler and retakes inside a segment are removed with cut candidates, not by splitting the segment.',
    '- Every line is heard once. Creators repeat themselves: when the same line (or nearly the same) is said more than once, keep only the best take (usually the last, cleanest one) and leave every other take out. Never keep a line in the body that already played as the hook.',
    '- You may move the strongest moment to the start as the hook, but the edit must still make sense to a first-time viewer, and the rest stays in the order it was said.',
    '- Accept cut candidates (ids like c3) to remove pauses, filler words, retakes and dead air. Keep a pause only when it is a deliberate beat.',
    '- Graphics, effects and sound effects are placed at SOURCE times inside kept segments; anything on a removed moment is dropped.',
    '- The finished edit must be at least 3 seconds long.',
    '',
    'DENSITY (restraint; the server also caps these, and drops anything over the limits)',
    '- Graphics: about one every 8 to 12 seconds of the finished edit, only on the hook, the turns, the key numbers and the payoff. Each must add something the words alone do not. At most 2 slams in the whole video.',
    '- Illustrations: only when the speaker names a thing on the VISUALS list and the drawing really shows it; at most one every 15 seconds. Never force one.',
    '- Punch-in zooms (scale 1.1 to 1.2): one every 5 to 8 seconds, only on a real emphasis word or a punchline. Not on every sentence.',
    '- Sound: transitions, graphics and illustrations get their sounds automatically. Add your own sounds as `beats` only where the script has a moment you can hear: a riser before a reveal, an impact on the punchline, cash on money, a ding on a win. At most one every 6 seconds; many videos need only two or three. Never two within 2 seconds.',
    `- \`beats\` are timed moments at a source time: a visual effect (${EFFECT_TYPES.join(', ')}) or a sound. Sounds by family:`,
    ...Object.entries(SFX_FAMILIES).map(([family, types]) => `  ${family}: ${types.join(', ')}`),
    '',
    'GRAPHICS (type, start, end, text, subtext, items, focusX, focusY; unused fields are "" or 0.5; items is one string: list items separated by " | ", or the illustration name for a visual)',
    `- Types: ${GRAPHIC_TYPES.join(', ')}.`,
    '- Places on screen: pill, headline, counter, list and visual share the top area and each one replaces the one before it, so leave at least 1.5 seconds between their starts (an illustration replaced sooner than about a second is not shown at all). lower_third and cta share the strip under the captions. A slam that lands while a top graphic is showing is drawn under the captions.',
    '- visual: an animated illustration of the thing being talked about, drawn in the top third of the screen for 1.5 to 4 seconds, starting on the word that names it. items is exactly one name from VISUALS; text is an optional label of 1 to 3 words ("YOUR BRAIN", "DOPAMINE") or "". Example: the speaker says "your brain rewires itself" → type visual, items "brain", text "YOUR BRAIN". Pick the illustration by what is being said, not by the niche, and do not repeat the same one back to back.',
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
    'VISUALS (name: what it draws, then when to use it)',
    ...Object.entries(VISUALS).map(([name, v]) => `- ${name}: ${v.about}`),
    '',
    'CAPTIONS',
    '- Captions show 2 to 3 words at a time on one line in the middle of the screen. The whole phrase appears at once; nothing follows the spoken word.',
    `- Presets: ${CAPTION_PRESETS.join(', ')}. bold_pop for high-energy talking (default; heavy white capitals), highlight for educational or tips content (emphasis words sit in a colored box), impact for short punchy lines and fast speech (tall condensed capitals, 2 words at a time), clean for calm or serious topics (sentence case on a dark pill).`,
    '- Emphasis words by index: numbers, key nouns, payoff words and contrasts, about one in five words. They take the accent color.',
    '',
    'HOOK, TRANSITIONS, EFFECTS AND LOOK',
    '- Hook overlay: at most 7 words, concrete to this video and matching the footage. Usually enabled: it adds stakes or curiosity the first spoken line does not.',
    `- style.transition (${TRANSITION_STYLES.join(', ')}) plays only where the edit really jumps (the hook moved to the front, or a big skip); continuous speech just cuts. punch suits talking heads, whip energetic content, glitch tech or twists, flash a dramatic reveal, none slow or serious topics. style.jumpCutZoom true alternates a slight zoom between pause cuts inside a stretch, so removed pauses read as intentional cuts (keep it true for talking heads).`,
    '- Effects (as beats): shake on slams, punchlines and impacts; flash on reveals and before-after moments.',
    `- style.grade (${GRADES.join(', ')}): vivid suits most videos, warm for lifestyle, cool for tech, punchy_bw only for dramatic content. style.accent (${ACCENTS.join(', ')}) colors graphics and emphasis words; pick one that fits the mood and stands out against the footage. style.progressBar true for edits over 15 seconds. style.motion true adds a slow push-in so no shot is ever static.`,
    '- Framing: output is 9:16. fill (crop) when the subject stays near one horizontal position, with focusX on the subject; fit_blur for landscape footage where cropping would lose the action.',
    '- Music: a track id from the library that fits the mood, or "" when the video already has music, the audio is loud and continuous, or nothing fits. Volume 0.08 to 0.2.',
    '',
    'GROUNDING',
    "- The REFERENCE NOTES are Vireact's knowledge base, grouped by part of the edit. Apply the notes that fit this video: hook patterns, cut rates, caption and text rules, retention drivers. The VIRAL EXAMPLES show what worked for real creators; match their cut pace, but keep graphics and sounds within the DENSITY limits above.",
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
    // The style the edit is in now (a regeneration after a style switch plans for the new style).
    const skill = skillFor(activeSkillId(project.skill, project.edits));
    if (skill) content.push({ type: 'text', text: skill.plannerRules });
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
