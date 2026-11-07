import { requestStructuredCompletion } from './openai-response.service.js';
import { withAiContext } from '../lib/ai-tracking.js';
import { validateScriptRewriteItem } from './analyzer/feedback-validator.js';
import { LibraryItem } from '../model/library-item.model.js';
import { LIBRARY_REVIEW_STATUS, LIBRARY_VISIBILITY } from '../constants/library.js';

export const MAX_HOOK_LINE_LENGTH = 200;
const EXEMPLAR_LIMIT = 12;
const REWRITE_COUNT = 3;

const SYSTEM_PROMPT = [
    'You rewrite the opening line of a short-form video (TikTok, Reels, Shorts).',
    'Use only the hook patterns given as exemplars; each rewrite must follow one of them and name its slug.',
    'Write the literal line a creator would say, in the same language as the original.',
    'No placeholders, blanks or brackets: fill every gap with specifics from the original line.',
    'No advice phrasing ("try to", "consider"), no statistics, no promises of views or results.',
    'The diagnosis is one or two sentences on why the original line loses viewers.',
].join(' ');

export const REWRITE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['diagnosis', 'rewrites'],
    properties: {
        diagnosis: { type: 'string' },
        rewrites: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['line', 'sourceItemSlug'],
                properties: {
                    line: { type: 'string' },
                    sourceItemSlug: { type: ['string', 'null'] },
                },
            },
        },
    },
};

/** Approved hooks only (public and members): owner content the model may imitate. */
export async function loadExemplars({ niche, problem } = {}) {
    const hooks = await LibraryItem.find({
        type: 'hook',
        reviewStatus: LIBRARY_REVIEW_STATUS.APPROVED,
        visibility: { $in: [LIBRARY_VISIBILITY.PUBLIC, LIBRARY_VISIBILITY.MEMBERS] },
    })
        .sort({ order: 1, _id: 1 })
        .lean();
    const score = (h) => (h.niches?.includes(niche) ? 2 : 0) + (h.problemTags?.includes(problem) ? 1 : 0);
    return [...hooks].sort((a, b) => score(b) - score(a)).slice(0, EXEMPLAR_LIMIT);
}

const buildUserMessage = ({ hookLine, niche, platform, exemplars }) =>
    [
        `Original line: "${hookLine}"`,
        niche ? `Niche: ${niche}` : null,
        platform ? `Platform: ${platform}` : null,
        `Write exactly ${REWRITE_COUNT} rewrites.`,
        'Exemplar hook patterns (slug: pattern):',
        ...exemplars.map((h) => `- ${h.slug}: ${h.displayText}`),
    ]
        .filter(Boolean)
        .join('\n');

/** Splits model output into accepted rewrites and rejection reasons. */
export function screenRewrites(output, { hookLine, exemplarSlugs }) {
    const diagnosis = typeof output?.diagnosis === 'string' ? output.diagnosis.trim() : '';
    const accepted = [];
    const rejected = [];
    for (const rewrite of Array.isArray(output?.rewrites) ? output.rewrites : []) {
        const line = typeof rewrite?.line === 'string' ? rewrite.line.trim() : '';
        const check = validateScriptRewriteItem({ rewrittenLine: line, originalTranscript: hookLine, rationale: diagnosis });
        const duplicate = accepted.some((r) => r.line.toLowerCase() === line.toLowerCase());
        if (!check.valid || duplicate) {
            rejected.push({ line, errors: duplicate ? ['duplicate rewrite'] : check.errors });
            continue;
        }
        accepted.push({ line, sourceItemSlug: exemplarSlugs.has(rewrite.sourceItemSlug) ? rewrite.sourceItemSlug : null });
    }
    return { diagnosis, accepted: accepted.slice(0, REWRITE_COUNT), rejected };
}

/**
 * Returns { diagnosis, rewrites } or throws { code: 'REWRITE_FAILED' } when no
 * rewrite survives validation after one corrective retry.
 */
export async function rewriteHook({ hookLine, niche, platform, problem }, { complete = requestStructuredCompletion, exemplars } = {}) {
    const pool = exemplars || (await loadExemplars({ niche, problem }));
    const exemplarSlugs = new Set(pool.map((h) => h.slug));
    const messages = [{ role: 'user', content: buildUserMessage({ hookLine, niche, platform, exemplars: pool }) }];
    const ask = (msgs) =>
        complete({ messages: msgs, schemaName: 'hook_rewrite', jsonSchema: REWRITE_SCHEMA, systemPrompt: SYSTEM_PROMPT, temperature: 0.7, maxTokens: 600 });

    let result = screenRewrites(await ask(messages), { hookLine, exemplarSlugs });
    if (result.rejected.length > 0 || result.accepted.length < REWRITE_COUNT || result.diagnosis.length < 8) {
        const correction = [
            'Some rewrites were rejected:',
            ...result.rejected.map((r) => `- "${r.line}": ${r.errors.join(' ')}`),
            `Return ${REWRITE_COUNT} literal, complete lines that differ from the original, and a diagnosis of at least one full sentence.`,
        ].join('\n');
        const retry = screenRewrites(
            await withAiContext({ attempt: 2 }, () => ask([...messages, { role: 'assistant', content: JSON.stringify({ rewrites: result.rejected }) }, { role: 'user', content: correction }])),
            { hookLine, exemplarSlugs }
        );
        if (retry.accepted.length >= result.accepted.length && retry.diagnosis.length >= 8) result = retry;
    }
    if (result.accepted.length === 0 || result.diagnosis.length < 8) {
        const error = new Error('No valid rewrite');
        error.code = 'REWRITE_FAILED';
        throw error;
    }
    return { diagnosis: result.diagnosis, rewrites: result.accepted };
}
