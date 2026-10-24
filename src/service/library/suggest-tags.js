import { requestStructuredCompletion } from '../openai-response.service.js';
import { NICHES, PROBLEMS } from '../../constants/library.js';

const BATCH_SIZE = 25;

const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
        items: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['slug', 'niches', 'problemTags'],
                properties: {
                    slug: { type: 'string' },
                    niches: { type: 'array', items: { type: 'string', enum: [...NICHES] } },
                    problemTags: { type: 'array', items: { type: 'string', enum: [...PROBLEMS] } },
                },
            },
        },
    },
};

const SYSTEM_PROMPT = [
    'You tag short-form video hook templates for a library. Use only the text given; do not invent claims.',
    `niches: up to 3 from ${NICHES.join(', ')} where the template fits naturally (empty if generic).`,
    `problemTags: up to 2 from ${PROBLEMS.join(', ')} that the template helps fix.`,
    'Return one entry per input slug.',
].join('\n');

/**
 * Draft tag suggestions from item text only (plan §5.2 optional pass).
 * @returns {Promise<Map<string, { niches: string[], problemTags: string[] }>>}
 */
export async function suggestTags(items) {
    const result = new Map();
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE).map((item) => ({
            slug: item.slug,
            category: item.category,
            text: item.displayText.slice(0, 300),
        }));
        const response = await requestStructuredCompletion({
            messages: [{ role: 'user', content: JSON.stringify(batch) }],
            schemaName: 'library_tag_suggestions',
            jsonSchema: schema,
            systemPrompt: SYSTEM_PROMPT,
            temperature: 0,
            maxTokens: 3000,
        });
        const known = new Set(batch.map((b) => b.slug));
        for (const entry of response.items || []) {
            if (!known.has(entry.slug)) continue;
            result.set(entry.slug, {
                niches: [...new Set(entry.niches)].slice(0, 3),
                problemTags: [...new Set(entry.problemTags)].slice(0, 2),
            });
        }
    }
    return result;
}
