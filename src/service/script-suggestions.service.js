/**
 * Scripts tab: several complete, timed alternative scripts for a video.
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

/** Regenerations allowed per video after the first generation. */
export const MAX_SCRIPT_REGENERATIONS = 3;
export const SCRIPT_OPTION_COUNT = 4;
/** Comfortable speaking pace for short-form voiceover. */
const MAX_WORDS_PER_SECOND = 3;
const SCRIPT_MODEL = 'gpt-4o';

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
                    title: { type: 'string', description: 'Two to five words naming the approach, e.g. "Result first".' },
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

/**
 * Generate script options for a video (no persistence).
 * @returns {Promise<{ targetSeconds: number, options: object[] }>}
 */
export const generateScriptOptions = async (video) => {
    const targetSeconds = scriptTargetSeconds(video);
    const scenesBlock = buildScenesBlock(video.scenes || []);
    const transcriptBlock = buildTranscriptBlock(video.rawTranscript || []);
    const hookScene = (video.scenes || []).find((s) => s.purpose?.toLowerCase() === 'hook') || video.scenes?.[0];
    const subject = [hookScene?.visualDescription, hookScene?.primaryAction, video.rawTranscript?.[0]?.text]
        .filter(Boolean)
        .join('. ')
        .slice(0, 600);

    const [hookDocs, structureDocs] = await Promise.all([
        retrieveKnowledge({ query: `Hook and opening line for a short-form video: ${subject}`, topics: ['hook', 'general'], limit: 8 }),
        retrieveKnowledge({ query: `Script structure, pacing, captions and payoff for: ${subject}`, topics: ['pacing', 'caption', 'audio', 'general'], limit: 6 }),
    ]);
    const referenceNotes = formatKnowledgeContext(dedupeDocs([...hookDocs, ...structureDocs]));
    const hasSpeech = Array.isArray(video.rawTranscript) && video.rawTranscript.length > 0;

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
Write ${SCRIPT_OPTION_COUNT} complete alternative scripts for this exact video. Each one must:
1. Fill exactly ${targetSeconds} seconds: beats run in order from 0 to ${targetSeconds} with no gaps, 3 to 8 beats, times in seconds.
2. Use a different hook mechanism from the other options (for example: show the result first, a specific bold claim, a question the video answers, a mistake or warning, a countdown or list). Pick the four that fit this footage best.
3. Land a clear hook in the first 2 seconds (hookLine), deliver the payoff before ${Math.max(3, Math.round(targetSeconds * 0.8))} seconds, and end on a specific call to action or loop back to the opening.
4. Keep spoken words under ${MAX_WORDS_PER_SECOND} per second of each beat. Keep each on-screen text to 7 words or fewer.
5. ${hasSpeech ? 'Keep the creator\'s real subject and voice. Rewrite weak lines rather than inventing a different video.' : 'This video has no speech. At least two options must include a short voiceover the creator can record (in "say"), because a spoken hook holds viewers better than music alone. The others can be on-screen text only.'}
6. Fix the problems listed above.
7. Every hookLine, "say" line and on-screen text must point at something concrete in this footage (what happens, where, what is at stake, or what the viewer is about to see). Write the way a creator talks, not like an ad. Bad: "Catch the thrill!", "Ride the waves!". Better: "I'm surfing straight through these pier legs", "Watch the gap on the left pillar". No exclamation marks, no hype words.
8. Do not invent facts you cannot see or hear in this video (names, times of day, numbers, results, follower counts). Use details that are visible or audible instead.
9. whyItWorks: one or two plain sentences about why this version keeps viewers watching this particular video.`;

    const payload = await requestStructuredCompletion({
        messages: [{ role: 'user', content: prompt }],
        schemaName: 'script_suggestions',
        jsonSchema: scriptSuggestionsJsonSchema,
        systemPrompt: SYSTEM_PROMPT,
        model: SCRIPT_MODEL,
        temperature: 0.7,
        maxTokens: 4000,
    });

    const options = (payload?.options || [])
        .map((option, index) => normalizeScriptOption(option, index, targetSeconds))
        .filter(Boolean)
        .slice(0, SCRIPT_OPTION_COUNT)
        .map((option, index) => ({ ...option, id: `script_${index + 1}` }));

    if (options.length === 0) {
        throw new Error('The script generator returned no usable scripts.');
    }
    return { targetSeconds, options };
};

/** Client shape for stored suggestions. */
export const toScriptSuggestionsResponse = (stored) => {
    if (!stored || !Array.isArray(stored.options) || stored.options.length === 0) {
        return { options: [], targetSeconds: null, generatedAt: null, regenerationsLeft: MAX_SCRIPT_REGENERATIONS };
    }
    const used = Math.max(0, (stored.generationCount ?? 1) - 1);
    return {
        options: stored.options.map((o) => (typeof o.toObject === 'function' ? o.toObject() : o)),
        targetSeconds: stored.targetSeconds ?? null,
        generatedAt: stored.generatedAt ?? null,
        regenerationsLeft: Math.max(0, MAX_SCRIPT_REGENERATIONS - used),
    };
};
