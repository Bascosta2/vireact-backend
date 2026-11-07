/**
 * Shared RAG retrieval for the analyzers and chat.
 *
 * Vector similarity on `KnowledgeBase.embedding` with a topic filter that always
 * includes `general` so admin creator profiles surface cross-niche (see SLASH_DOC
 * "Local admin ingest").
 *
 * SPECIFICITY: chunks tagged `metadata.specificity: 'vague'` are dropped so
 * historical prose entries cannot be cited as exemplars for a literal rewrite.
 * The drop happens in code rather than in the `$vectorSearch` filter on purpose:
 * adding a new filter path requires an Atlas index change, and documents missing
 * the field would be excluded entirely by a server-side filter. Over-fetching and
 * filtering locally keeps legacy `unrated` chunks retrievable.
 */

import openai from '../../lib/openai.js';
import { embeddingModel } from '../../config/ai-models.js';
import { KnowledgeBase } from '../../model/knowledge-base.model.js';
import { KNOWLEDGE_BASE_VECTOR_INDEX } from '../../config/index.js';
import { KB_SPECIFICITY } from '../../constants.js';
import { recordEmbedding } from '../../lib/ai-tracking.js';

const EMBEDDING_MODEL = embeddingModel();

/**
 * @param {object} params
 * @param {string} params.query Text to embed for similarity search
 * @param {string[]} [params.topics] `metadata.topic` values to allow (omit for unfiltered)
 * @param {number} [params.limit] Chunks to return after filtering
 * @param {boolean} [params.excludeVague] Drop `specificity: 'vague'` chunks (default true)
 * @returns {Promise<object[]>} KnowledgeBase documents (empty array on failure)
 */
export const retrieveKnowledge = async ({ query, topics, limit = 10, excludeVague = true } = {}) => {
    if (!query || !String(query).trim()) return [];

    try {
        const started = Date.now();
        const embeddingResponse = await openai.embeddings.create({
            model: EMBEDDING_MODEL,
            input: String(query),
        });
        recordEmbedding({ model: EMBEDDING_MODEL, inputTokens: embeddingResponse?.usage?.prompt_tokens, latencyMs: Date.now() - started, label: 'rag_query_embedding' });
        const queryVector = embeddingResponse.data[0].embedding;

        // Over-fetch when filtering locally so the post-filter still returns `limit`.
        const fetchLimit = excludeVague ? limit * 2 : limit;

        const vectorSearch = {
            index: KNOWLEDGE_BASE_VECTOR_INDEX,
            queryVector,
            path: 'embedding',
            limit: fetchLimit,
            numCandidates: Math.max(100, fetchLimit * 10),
        };
        if (Array.isArray(topics) && topics.length > 0) {
            vectorSearch.filter = { 'metadata.topic': { $in: topics } };
        }

        const docs = await KnowledgeBase.aggregate([{ $vectorSearch: vectorSearch }]);

        const filtered = excludeVague
            ? docs.filter((doc) => doc?.metadata?.specificity !== KB_SPECIFICITY.VAGUE)
            : docs;

        return filtered.slice(0, limit);
    } catch (error) {
        console.error('[RAG] Knowledge retrieval failed:', error.message);
        return [];
    }
};

/**
 * Render retrieved chunks for a prompt. Measured-impact metadata is surfaced so
 * the model can ground `expectedImpact` in a real number instead of inventing one.
 */
export const formatKnowledgeContext = (docs, emptyFallback = 'No relevant knowledge base documents found.') => {
    if (!Array.isArray(docs) || docs.length === 0) return emptyFallback;

    return docs
        .map((doc, index) => {
            const layer = (doc?.metadata?.layer || 'raw').toUpperCase();
            const parts = [`${index + 1}. [${layer}]`];

            if (doc?.metadata?.exemplarType) parts.push(`(${doc.metadata.exemplarType})`);

            const impact = doc?.metadata?.measuredImpact;
            if (impact?.metric && impact?.deltaPercent != null) {
                parts.push(`(measured: ${impact.metric} ${impact.deltaPercent > 0 ? '+' : ''}${impact.deltaPercent}%)`);
            } else if (doc?.metadata?.actualViews != null) {
                parts.push(`(actual views: ${doc.metadata.actualViews})`);
            }

            parts.push(doc?.content || '');
            return parts.join(' ');
        })
        .join('\n');
};
