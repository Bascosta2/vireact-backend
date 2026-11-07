/**
 * Structured completion + specificity gate, with exactly one correction retry.
 *
 * Shared by the analyzers and the chat controller so both enforce the same
 * contract: strict `json_schema` guarantees shape, `feedback-validator.js`
 * guarantees the content is literal and timestamped, and anything still failing
 * after the retry is dropped and logged rather than persisted.
 */

import { requestStructuredCompletion } from '../openai-response.service.js';
import {
    validateFeedbackPayload,
    buildCorrectionPrompt,
    logFeedbackValidationFailure,
} from './feedback-validator.js';
import { withAiContext, lastGenerationId, markGenerationValidation } from '../../lib/ai-tracking.js';

/** Short, human-readable reasons for the admin "AI responses" page. */
const describeRejections = (rejected = []) =>
    rejected.map((entry) => `${entry.kind}${entry.id ? ` ${entry.id}` : ''}: ${(entry.errors || []).join('; ')}`);

/** Run one model call in its own tracking scope and return [result, generationId]. */
const tracked = (attempt, fn) => withAiContext({ attempt }, async () => [await fn(), lastGenerationId()]);

/**
 * @param {object} params
 * @param {Array<{role: string, content: string}>} params.messages
 * @param {string} params.schemaName
 * @param {object} params.jsonSchema
 * @param {string} params.systemPrompt
 * @param {(payload: object) => { frameFeedback: object[], scriptRewrites: object[] }} params.normalize
 * @param {string} params.scope Label for validation logs, e.g. `analyzer:hook` or `chat`
 * @param {string} [params.videoId]
 * @param {string} [params.transcriptText] Enables the verbatim check
 * @param {number} [params.temperature]
 * @param {number} [params.maxTokens]
 * @param {string} [params.role] model role from config/ai-models.js (default "structured")
 * @returns {Promise<{ payload: object, frameFeedback: object[], scriptRewrites: object[], valid: boolean }>}
 */
export const runValidatedStructuredCompletion = async ({
    messages,
    schemaName,
    jsonSchema,
    systemPrompt,
    normalize,
    scope,
    videoId,
    transcriptText = '',
    temperature = 0.2,
    maxTokens = 3500,
    role = 'structured',
}) => {
    let [payload, firstId] = await tracked(1, () => requestStructuredCompletion({
        messages,
        schemaName,
        jsonSchema,
        systemPrompt,
        temperature,
        maxTokens,
        role,
    }));

    let normalized = normalize(payload);
    let validation = validateFeedbackPayload(normalized, { transcriptText });
    markGenerationValidation(firstId, { passed: validation.valid, issues: describeRejections(validation.rejected) });

    if (validation.valid) {
        return {
            payload,
            frameFeedback: validation.kept.frameFeedback,
            scriptRewrites: validation.kept.scriptRewrites,
            valid: true,
        };
    }

    logFeedbackValidationFailure({
        scope,
        videoId,
        attempt: 1,
        rejected: validation.rejected,
        warnings: validation.warnings,
    });

    try {
        const [retryPayload, retryId] = await tracked(2, () => requestStructuredCompletion({
            messages: [
                ...messages,
                { role: 'assistant', content: JSON.stringify(payload) },
                { role: 'user', content: buildCorrectionPrompt(validation.rejected) },
            ],
            schemaName,
            jsonSchema,
            systemPrompt,
            temperature,
            maxTokens,
            role,
        }));

        const retryNormalized = normalize(retryPayload);
        const retryValidation = validateFeedbackPayload(retryNormalized, { transcriptText });
        markGenerationValidation(retryId, { passed: retryValidation.valid, issues: describeRejections(retryValidation.rejected) });

        // Accept the retry only when it keeps at least as many valid items.
        const retryKept = retryValidation.kept.frameFeedback.length + retryValidation.kept.scriptRewrites.length;
        const firstKept = validation.kept.frameFeedback.length + validation.kept.scriptRewrites.length;
        if (retryKept >= firstKept) {
            payload = retryPayload;
            validation = retryValidation;
        }

        if (!validation.valid) {
            logFeedbackValidationFailure({
                scope,
                videoId,
                attempt: 2,
                rejected: validation.rejected,
                warnings: validation.warnings,
            });
        }
    } catch (retryError) {
        console.error(`[${scope}] Correction retry failed: ${retryError.message}`);
    }

    return {
        payload,
        frameFeedback: validation.kept.frameFeedback,
        scriptRewrites: validation.kept.scriptRewrites,
        valid: validation.valid,
    };
};
