/**
 * Shared execution path for every feature analyzer.
 *
 * Enforcement happens in two layers:
 *  1. OpenAI strict `json_schema` — output cannot be shapeless prose.
 *  2. `feedback-validator.js` — output cannot be vague, placeholder, or hedged.
 *
 * On validation failure the model gets exactly one correction attempt with the
 * offending text quoted back (see `validated-completion.js`). Items still failing
 * are dropped and logged, never silently discarded.
 */

import { buildTranscriptBlock, transcriptToPlainText } from '../transcript.service.js';
import { retrieveKnowledge, formatKnowledgeContext } from './retrieve-knowledge.js';
import { normalizeFrameFeedback, normalizeScriptRewrite } from './feedback-schema.js';
import { runValidatedStructuredCompletion } from './validated-completion.js';

/** Scene context block shared by all analyzers. */
export const buildScenesBlock = (scenes) => {
    if (!Array.isArray(scenes) || scenes.length === 0) return 'No scene breakdown available.';
    return scenes
        .map((scene, idx) => [
            `Scene ${idx + 1} (${scene.startTime}s - ${scene.endTime}s):`,
            `- Visual: ${scene.visualDescription || 'N/A'}`,
            `- On-screen text: ${scene.onScreenText || 'None'}`,
            `- Audio: ${scene.audioSummary || 'N/A'}`,
            `- Primary action: ${scene.primaryAction || 'N/A'}`,
            `- Emotional tone: ${scene.emotionalTone || 'N/A'}`,
            `- Purpose: ${scene.purpose || 'N/A'}`,
        ].join('\n'))
        .join('\n\n');
};

/**
 * Specificity contract injected into every analyzer and chat system prompt. This
 * is the prose half of the enforcement; the validator is the mechanical half.
 */
export const SPECIFICITY_CONTRACT = [
    'Every item in frameFeedback and scriptRewrites must satisfy all three rules:',
    '1. TIMESTAMP: cite a real range in seconds taken from the transcript or scene boundaries. Never invent times.',
    '2. OBSERVED: state what literally happens — quote the spoken words verbatim and give measured facts (e.g. "2.1s of dead air before the value prop"). Adjectives alone are rejected.',
    '3. FIX: fix.after must be the literal drop-in content the creator uses as-is — the exact new line, the exact overlay text, or an explicit cut range with times. Never "improve X", "tighten Y", "consider Z".',
    '',
    'Banned in fix.after and rewrittenLine: "try to", "consider", "you could", "make it more", "improve your", "be more", placeholders like "[topic]" or "<insert>".',
    'fix.before and originalTranscript must be copied verbatim from the supplied transcript. If the video has no speech, return an empty scriptRewrites array rather than inventing lines.',
    'Return fewer, fully specific items rather than padding the arrays with vague ones.',
].join('\n');

/** Normalize + index ids so every item has a stable per-analyzer id. */
export const normalizeAnalyzerPayload = (payload, { feature, duration }) => ({
    frameFeedback: (payload?.frameFeedback || [])
        .map((item, index) => normalizeFrameFeedback(item, { index, sourceFeature: feature, duration }))
        .filter(Boolean),
    scriptRewrites: (payload?.scriptRewrites || [])
        .map((item, index) => normalizeScriptRewrite(item, { index, sourceFeature: feature, duration }))
        .filter(Boolean),
});

/**
 * Run one analyzer end to end.
 *
 * @param {object} params
 * @param {string} params.feature Authoring feature, stored as `sourceFeature`
 * @param {string} params.schemaName Name passed to OpenAI structured outputs
 * @param {object} params.jsonSchema Strict JSON schema for the response
 * @param {string} params.systemPrompt
 * @param {(ctx: { scenesBlock: string, transcriptBlock: string, ragContext: string }) => string} params.buildPrompt
 * @param {string} params.ragQuery Text embedded for knowledge retrieval
 * @param {string[]} [params.ragTopics] Topic filter (always include 'general')
 * @param {object[]} [params.scenes]
 * @param {object[]} [params.rawTranscript]
 * @param {number} [params.duration] Video duration in seconds, used to clamp times
 * @param {string} [params.videoId] For validation logs only
 * @param {number} [params.maxTokens]
 * @param {number} [params.temperature]
 * @returns {Promise<object>} analyzer payload plus validated `frameFeedback` / `scriptRewrites`
 */
export const runFeedbackAnalyzer = async ({
    feature,
    schemaName,
    jsonSchema,
    systemPrompt,
    buildPrompt,
    ragQuery,
    ragTopics,
    scenes = [],
    rawTranscript = [],
    duration,
    videoId,
    maxTokens = 3500,
    temperature = 0.2,
}) => {
    const knowledgeDocs = await retrieveKnowledge({ query: ragQuery, topics: ragTopics });
    const ragContext = formatKnowledgeContext(knowledgeDocs);

    const prompt = buildPrompt({
        scenesBlock: buildScenesBlock(scenes),
        transcriptBlock: buildTranscriptBlock(rawTranscript),
        ragContext,
    });

    const { payload, frameFeedback, scriptRewrites } = await runValidatedStructuredCompletion({
        messages: [{ role: 'user', content: prompt }],
        schemaName,
        jsonSchema,
        systemPrompt,
        normalize: (candidate) => normalizeAnalyzerPayload(candidate, { feature, duration }),
        scope: `analyzer:${feature}`,
        videoId,
        transcriptText: transcriptToPlainText(rawTranscript),
        temperature,
        maxTokens,
    });

    return { ...payload, frameFeedback, scriptRewrites };
};
