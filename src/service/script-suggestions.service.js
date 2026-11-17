/**
 * Scripts: ten complete, timed alternative scripts for a video, each with a short idea name.
 * Everyone sees the ten names; how many full scripts open depends on the plan (SCRIPT_ACCESS).
 * Locked scripts are never sent to the browser.
 *
 * Grounded in three things: this video's real content (scene breakdown + transcript), its weakest
 * scored areas and top timestamped fixes, and the knowledge base (hooks/general plus pacing,
 * captions and audio). Every option fills exactly the video's length, so the creator can reshoot
 * or re-edit to it directly.
 */
import { requestStructuredCompletion } from './openai-response.service.js';
import { retrieveKnowledge, formatKnowledgeContext } from './analyzer/retrieve-knowledge.js';
import { buildScenesBlock } from './analyzer/run-feedback-analyzer.js';
import { buildTranscriptBlock } from './transcript.service.js';
import { VOICE_RULES, cleanUserText } from './analyzer/voice.js';
import { formatClock, describeFix } from './initial-analysis-message.js';
import { SCRIPT_ACCESS, SUBSCRIPTION_PLANS } from '../constants.js';

/** Regenerations allowed per video after the first generation. */
export const MAX_SCRIPT_REGENERATIONS = 3;
export const SCRIPT_OPTION_COUNT = 10;
/** Stored sets written by this version (ten named ideas). */
export const SCRIPT_SET_VERSION = 2;

/**
 * One hook mechanism per script, so the ten ideas are genuinely different. Written in two parallel
 * requests of five (shorter, faster and more reliable than one request for ten).
 */
export const SCRIPT_MECHANISMS = [
    'Result first: open on the finished outcome or the best moment, then show how it happened.',
    'Bold claim: open on one specific, checkable statement the video then proves.',
    'Question: open on the exact question this video answers.',
    'Mistake or warning: open on what most people get wrong, then show the right way.',
    'List or countdown: number the points and say how many there are up front.',
    'Story: open in the middle of the moment that matters, then explain how you got there.',
    'Myth buster: state a common belief, then show why it is wrong.',
    'Before and after: put the starting point and the end point side by side in the first seconds.',
    'Direct challenge: speak to one specific kind of viewer and tell them what to try.',
    'Curiosity gap: tease one surprising detail and hold it back until the payoff.',
];

/** How many full scripts a plan opens per video. Unknown plans get the Free amount. */
export const scriptAccessForPlan = (plan) => SCRIPT_ACCESS[plan] ?? SCRIPT_ACCESS[SUBSCRIPTION_PLANS.FREE];

/** The cheapest plan that opens the script at this position (0-based). */
export const requiredPlanForScript = (index) => (index < SCRIPT_ACCESS.premium ? SUBSCRIPTION_PLANS.PREMIUM : SUBSCRIPTION_PLANS.PRO);
/** Comfortable speaking pace for short-form voiceover. */
const MAX_WORDS_PER_SECOND = 3;

const MIN_TARGET_SECONDS = 6;
const MAX_TARGET_SECONDS = 90;

/** Length the scripts should fill: the video's own duration, clamped to a sensible range. */
export const scriptTargetSeconds = (video) => {
    const candidates = [
        Number(video?.duration),
        Number(video?.scenes?.[video.scenes.length - 1]?.endTime),
        Number(video?.rawTranscript?.[video.rawTranscript.length - 1]?.tEnd),
    ].filter((n) => Number.isFinite(n) && n > 0);
    const seconds = candidates.length > 0 ? Math.max(...candidates) : 30;
    return Math.min(MAX_TARGET_SECONDS, Math.max(MIN_TARGET_SECONDS, Math.round(seconds)));
};

export const scriptSuggestionsJsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['options'],
    properties: {
        options: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['title', 'angle', 'hookLine', 'beats', 'cta', 'whyItWorks'],
                properties: {
                    title: { type: 'string', description: 'One or two words (three at most) naming the idea for THIS video, e.g. "Score first", "Resource question". No punctuation.' },
                    angle: { type: 'string', description: 'One sentence: how this version hooks and holds viewers.' },
                    hookLine: { type: 'string', description: 'The exact first line (spoken or on screen) in the first 2 seconds.' },
                    beats: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            required: ['tStart', 'tEnd', 'say', 'onScreenText', 'visual'],
                            properties: {
                                tStart: { type: 'number' },
                                tEnd: { type: 'number' },
                                say: { type: 'string', description: 'Exact words spoken in this beat, or "" when nothing is said.' },
                                onScreenText: { type: 'string', description: 'Exact overlay text (7 words max), or "".' },
                                visual: { type: 'string', description: 'What is on screen, using footage this creator actually has.' },
                            },
                        },
                    },
                    cta: { type: 'string', description: 'The exact closing line or overlay.' },
                    whyItWorks: { type: 'string', description: 'One or two plain sentences for this specific video. Never mention sources.' },
                },
            },
        },
    },
};

const wordCount = (text) => (String(text || '').trim().match(/\S+/g) || []).length;

/**
 * Clamp, order and sanity-check one generated option. Returns null when it is unusable.
 * Beats are fitted to [0, target]; the last beat is stretched to end exactly at the target.
 */
export const normalizeScriptOption = (option, index, targetSeconds) => {
    const beats = (Array.isArray(option?.beats) ? option.beats : [])
        .map((beat) => {
            const tStart = Math.max(0, Math.min(targetSeconds, Number(beat?.tStart)));
            const tEnd = Math.max(0, Math.min(targetSeconds, Number(beat?.tEnd)));
            if (!Number.isFinite(tStart) || !Number.isFinite(tEnd) || tEnd <= tStart) return null;
            return {
                tStart: Math.round(tStart * 10) / 10,
                tEnd: Math.round(tEnd * 10) / 10,
                say: cleanUserText(String(beat?.say ?? '').trim()),
                onScreenText: cleanUserText(String(beat?.onScreenText ?? '').trim()),
                visual: cleanUserText(String(beat?.visual ?? '').trim()),
            };
        })
        .filter((beat) => beat && (beat.say || beat.onScreenText || beat.visual))
        .sort((a, b) => a.tStart - b.tStart);

    if (beats.length < 2) return null;
    beats[0].tStart = 0;
    beats[beats.length - 1].tEnd = targetSeconds;

    // Reject scripts nobody could actually say in the time available.
    const spokenWords = beats.reduce((sum, beat) => sum + wordCount(beat.say), 0);
    if (spokenWords > targetSeconds * MAX_WORDS_PER_SECOND * 1.15) return null;

    const title = cleanUserText(String(option?.title ?? '').trim()) || `Option ${index + 1}`;
    return {
        id: `script_${index + 1}`,
        title,
        angle: cleanUserText(String(option?.angle ?? '').trim()),
        hookLine: cleanUserText(String(option?.hookLine ?? '').trim()),
        beats,
        cta: cleanUserText(String(option?.cta ?? '').trim()),
        whyItWorks: cleanUserText(String(option?.whyItWorks ?? '').trim()),
    };
};

const featureScoreLines = (video) =>
    (video.analysis || [])
        .filter((a) => typeof a.score === 'number')
        .sort((a, b) => a.score - b.score)
        .map((a) => `- ${a.feature}: ${a.score}/100${a.feedback ? `. ${String(a.feedback).slice(0, 220)}` : ''}`)
        .join('\n') || '- No scores stored.';

const topFixLines = (video) =>
    (video.timestampFeedback || [])
        .filter((item) => item.sourceFeature !== 'advanced_analytics')
        .slice()
        .sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0))
        .slice(0, 5)
        .map((item) => `- ${formatClock(item.tStart)}-${formatClock(item.tEnd)} (${item.category}): ${item.issue} ${describeFix(item.fix)}`)
        .join('\n') || '- None stored.';

const dedupeDocs = (docs) => {
    const seen = new Set();
    return docs.filter((doc) => {
        const key = String(doc?._id ?? doc?.content ?? '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

const SYSTEM_PROMPT = [
    'You write short-form video scripts for one specific creator and one specific video. You return structured data only.',
    'Every option must be about the subject actually shown in this video, using footage the creator already has or can easily reshoot. No placeholders like [topic] or <product>.',
    VOICE_RULES,
].join('\n\n');

/** Everything about the video the writer needs; built once and shared by both requests. */
const buildScriptContext = async (video, targetSeconds, { retrieve = retrieveKnowledge } = {}) => {
    const scenesBlock = buildScenesBlock(video.scenes || []);
    const transcriptBlock = buildTranscriptBlock(video.rawTranscript || []);
    const hookScene = (video.scenes || []).find((s) => s.purpose?.toLowerCase() === 'hook') || video.scenes?.[0];
    const subject = [hookScene?.visualDescription, hookScene?.primaryAction, video.rawTranscript?.[0]?.text]
        .filter(Boolean)
        .join('. ')
        .slice(0, 600);

    const [hookDocs, structureDocs] = await Promise.all([
        retrieve({ query: `Hook and opening line for a short-form video: ${subject}`, topics: ['hook', 'general'], limit: 8 }),
        retrieve({ query: `Script structure, pacing, captions and payoff for: ${subject}`, topics: ['pacing', 'caption', 'audio', 'general'], limit: 6 }),
    ]);
    const referenceNotes = formatKnowledgeContext(dedupeDocs([...hookDocs, ...structureDocs]));
    const hasSpeech = Array.isArray(video.rawTranscript) && video.rawTranscript.length > 0;
    return { video, targetSeconds, scenesBlock, transcriptBlock, referenceNotes, hasSpeech };
};

/** One request: a script for each of the given mechanisms. Returns the raw options. */
const writeScriptBatch = async (context, mechanisms, { complete = requestStructuredCompletion } = {}) => {
    const { video, targetSeconds, scenesBlock, transcriptBlock, referenceNotes, hasSpeech } = context;

    const prompt = `REFERENCE NOTES (your private playbook. Apply them; never mention them, their author or that they exist):
${referenceNotes}

THIS VIDEO
Length: ${targetSeconds} seconds.
Scene breakdown:
${scenesBlock}

Transcript (verbatim):
${transcriptBlock}

Scores, weakest first:
${featureScoreLines(video)}

Biggest problems found, with fixes:
${topFixLines(video)}

TASK
Write ${mechanisms.length} complete alternative scripts for this exact video, one for each hook mechanism below, in this order:
${mechanisms.map((m, i) => `${i + 1}. ${m}`).join('\n')}
Each script must:
1. Fill exactly ${targetSeconds} seconds: beats run in order from 0 to ${targetSeconds} with no gaps, 3 to 8 beats, times in seconds.
2. Use its assigned hook mechanism, adapted to this footage. Give it a title of one or two words (three at most) that names the idea for this video, like "Score first" or "Resource question". Every title must be different.
3. Land a clear hook in the first 2 seconds (hookLine), deliver the payoff before ${Math.max(3, Math.round(targetSeconds * 0.8))} seconds, and end on a specific call to action or loop back to the opening.
4. Keep spoken words under ${MAX_WORDS_PER_SECOND} per second of each beat. Keep each on-screen text to 7 words or fewer.
5. ${hasSpeech ? 'Keep the creator\'s real subject and voice. Rewrite weak lines rather than inventing a different video.' : 'This video has no speech. At least two options must include a short voiceover the creator can record (in "say"), because a spoken hook holds viewers better than music alone. The others can be on-screen text only.'}
6. Fix the problems listed above.
7. Every hookLine, "say" line and on-screen text must point at something concrete in this footage (what happens, where, what is at stake, or what the viewer is about to see). Write the way a creator talks, not like an ad. Bad: "Catch the thrill!", "Ride the waves!". Better: "I'm surfing straight through these pier legs", "Watch the gap on the left pillar". No exclamation marks, no hype words.
8. Do not invent facts you cannot see or hear in this video (names, times of day, numbers, results, follower counts). Use details that are visible or audible instead.
9. Language: write every hookLine, "say" line and on-screen text in the language people speak in this video. If nobody speaks, write them in English even when existing on-screen text is in another language. Write title, angle and whyItWorks in English.
10. whyItWorks: one or two plain sentences about why this version keeps viewers watching this particular video.`;

    const payload = await complete({
        messages: [{ role: 'user', content: prompt }],
        schemaName: 'script_suggestions',
        jsonSchema: scriptSuggestionsJsonSchema,
        systemPrompt: SYSTEM_PROMPT,
        role: 'writer',
        temperature: 0.7,
        maxTokens: 6000,
    });
    return (payload?.options || []).slice(0, mechanisms.length);
};

/** Keep titles short and unique so the idea list reads cleanly. */
export const tidyScriptTitles = (options) => {
    const seen = new Map();
    return options.map((option) => {
        const words = String(option.title || '').replace(/[.!?:;"]+/g, '').trim().split(/\s+/).filter(Boolean).slice(0, 3);
        let title = words.join(' ') || 'Script idea';
        const key = title.toLowerCase();
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        if (count > 1) title = `${title} ${count}`;
        return { ...option, title };
    });
};

/**
 * Generate script options for a video (no persistence): two parallel requests of five ideas.
 * One failed request still leaves the other five; both failing throws.
 * @returns {Promise<{ targetSeconds: number, options: object[] }>}
 */
export const generateScriptOptions = async (video, deps = {}) => {
    const targetSeconds = scriptTargetSeconds(video);
    const context = await buildScriptContext(video, targetSeconds, deps);
    const half = Math.ceil(SCRIPT_MECHANISMS.length / 2);
    const batches = [SCRIPT_MECHANISMS.slice(0, half), SCRIPT_MECHANISMS.slice(half)];
    const results = await Promise.allSettled(batches.map((mechanisms) => writeScriptBatch(context, mechanisms, deps)));

    const raw = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    const options = tidyScriptTitles(
        raw
            .map((option, index) => normalizeScriptOption(option, index, targetSeconds))
            .filter(Boolean)
            .slice(0, SCRIPT_OPTION_COUNT)
    ).map((option, index) => ({ ...option, id: `script_${index + 1}` }));

    if (options.length === 0) {
        const failure = results.find((r) => r.status === 'rejected');
        throw failure?.reason instanceof Error ? failure.reason : new Error('The script generator returned no usable scripts.');
    }
    return { targetSeconds, options };
};

/** True for sets written before the ten-idea version: they are rewritten (free of charge) on next open. */
export const isLegacyScriptSet = (stored) =>
    Array.isArray(stored?.options) && stored.options.length > 0 && (stored.version ?? 1) < SCRIPT_SET_VERSION;

/**
 * Client shape for stored suggestions, gated by plan. The first `scriptAccessForPlan(plan)` scripts
 * are sent in full; the rest carry only their idea name and the plan that opens them.
 */
export const toScriptSuggestionsResponse = (stored, { plan = SUBSCRIPTION_PLANS.FREE } = {}) => {
    const unlockedCount = scriptAccessForPlan(plan);
    const access = { plan, unlocked: unlockedCount, total: SCRIPT_OPTION_COUNT };
    if (!stored || !Array.isArray(stored.options) || stored.options.length === 0) {
        return { options: [], targetSeconds: null, generatedAt: null, regenerationsLeft: MAX_SCRIPT_REGENERATIONS, access, needsRefresh: false };
    }
    const used = Math.max(0, (stored.generationCount ?? 1) - 1);
    return {
        options: stored.options.map((o, index) => {
            const option = typeof o.toObject === 'function' ? o.toObject() : o;
            if (index < unlockedCount) return { ...option, locked: false };
            return { id: option.id, title: option.title, locked: true, requiredPlan: requiredPlanForScript(index), angle: '', hookLine: '', beats: [], cta: '', whyItWorks: '' };
        }),
        targetSeconds: stored.targetSeconds ?? null,
        generatedAt: stored.generatedAt ?? null,
        regenerationsLeft: Math.max(0, MAX_SCRIPT_REGENERATIONS - used),
        access,
        needsRefresh: isLegacyScriptSet(stored),
    };
};
