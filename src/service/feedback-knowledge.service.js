/**
 * Exemplar ingestion for the RAG knowledge base.
 *
 * Grounds future `expectedImpact` claims and rewrite suggestions in content that
 * actually performed, rather than in generic advice:
 *  - `feedback_impact_pair` — a frame-level fix paired with the measured outcome
 *    of the video it came from.
 *  - `hook_rewrite` / `script_rewrite` — literal before/after line pairs, indexed
 *    by content category.
 *
 * Every chunk written here is tagged `specificity: 'literal'` because it contains
 * quotable before/after content. `analyzer/retrieve-knowledge.js` excludes `vague`
 * chunks from retrieval, so only usable exemplars can back a drop-in fix.
 *
 * Measured impact only exists for admin creator ingest (where `actualViews` is
 * known). User-uploaded videos have no post-publish metrics, so they contribute
 * exemplars without a `measuredImpact` block.
 */

import openai from '../lib/openai.js';
import { KnowledgeBase } from '../model/knowledge-base.model.js';
import { KB_SPECIFICITY, KB_EXEMPLAR_TYPES } from '../constants.js';
import { formatTimecode } from './analyzer/feedback-schema.js';

const EMBEDDING_MODEL = 'text-embedding-3-large';

/** Topic bucket per feedback category, matching `KnowledgeBase.metadata.topic`. */
const CATEGORY_TO_TOPIC = {
    hook: 'hook',
    caption: 'caption',
    pacing: 'pacing',
    audio: 'audio',
    visual: 'advanced_analytics',
    script: 'hook',
};

const createEntry = async (content, metadata) => {
    const response = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: content,
        encoding_format: 'float',
    });
    const embedding = response?.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error('Empty embedding returned');
    }
    return KnowledgeBase.create({
        content,
        embedding,
        metadata: {
            layer: 'example',
            score: 0.9,
            date: new Date(),
            ingestedAt: new Date(),
            specificity: KB_SPECIFICITY.LITERAL,
            ...metadata,
        },
    });
};

/** Retrieval-friendly text for a feedback -> impact pair. */
const buildFeedbackImpactContent = (item, { measuredImpact, contentCategory, platform }) => [
    '[FEEDBACK_IMPACT_PAIR]',
    `Category: ${item.category} | Severity: ${item.severity}/5`,
    contentCategory ? `Content category: ${contentCategory}` : null,
    platform ? `Platform: ${platform}` : null,
    `Moment: ${formatTimecode(item.tStart)}-${formatTimecode(item.tEnd)}`,
    `Observed: ${item.observed}`,
    `Issue: ${item.issue}`,
    item.fix?.before ? `Before: "${item.fix.before}"` : null,
    `Fix (${item.fix?.type}): "${item.fix?.after}"`,
    measuredImpact?.metric && measuredImpact?.deltaPercent != null
        ? `Measured outcome: ${measuredImpact.metric} ${measuredImpact.deltaPercent > 0 ? '+' : ''}${measuredImpact.deltaPercent}%${measuredImpact.basis ? ` (${measuredImpact.basis})` : ''}`
        : item.expectedImpact ? `Predicted impact (unverified): ${item.expectedImpact}` : null,
].filter(Boolean).join('\n');

/** Retrieval-friendly text for a literal line rewrite. */
const buildRewriteContent = (rewrite, { isHook, contentCategory, platform, actualViews }) => [
    isHook ? '[HOOK_REWRITE]' : '[SCRIPT_REWRITE]',
    contentCategory ? `Content category: ${contentCategory}` : null,
    platform ? `Platform: ${platform}` : null,
    `Position: ${formatTimecode(rewrite.timestamp)}`,
    `Before: "${rewrite.originalTranscript}"`,
    `After: "${rewrite.rewrittenLine}"`,
    rewrite.rationale ? `Why: ${rewrite.rationale}` : null,
    rewrite.deliveryNote ? `Delivery: ${rewrite.deliveryNote}` : null,
    actualViews != null ? `Source video actual views: ${actualViews}` : null,
].filter(Boolean).join('\n');

/**
 * Ingest frame feedback as feedback -> impact exemplars.
 * Only items carrying a literal fix are ingested.
 *
 * @param {object[]} frameFeedback Validated FrameFeedback items
 * @param {object} [context]
 * @param {{ metric: string, deltaPercent: number, basis?: string }} [context.measuredImpact]
 * @param {string} [context.contentCategory]
 * @param {string} [context.platform]
 * @param {string} [context.source] Provenance label for `metadata.source`
 * @returns {Promise<number>} chunks written
 */
export const ingestFeedbackImpactPairs = async (frameFeedback, context = {}) => {
    const items = (frameFeedback || []).filter((item) => item?.fix?.after);
    let written = 0;

    for (const item of items) {
        try {
            await createEntry(buildFeedbackImpactContent(item, context), {
                topic: CATEGORY_TO_TOPIC[item.category] || 'general',
                exemplarType: KB_EXEMPLAR_TYPES.FEEDBACK_IMPACT_PAIR,
                contentCategory: context.contentCategory,
                platform: context.platform,
                measuredImpact: context.measuredImpact,
                source: context.source || 'analysis_feedback',
                sourceType: 'feedback_impact_pair',
                contentType: 'exemplar',
            });
            written += 1;
        } catch (error) {
            console.error('[FeedbackKB] Failed to ingest feedback impact pair:', error.message);
        }
    }

    return written;
};

/**
 * Ingest script rewrites as literal before/after exemplars, indexed by content
 * category. Rewrites at or before `hookWindowSeconds` are tagged as hook rewrites.
 *
 * @param {object[]} scriptRewrites Validated ScriptRewrite items
 * @param {object} [context]
 * @param {number} [context.hookWindowSeconds] Default 3
 * @returns {Promise<number>} chunks written
 */
export const ingestScriptRewriteExemplars = async (scriptRewrites, context = {}) => {
    const { hookWindowSeconds = 3 } = context;
    const items = (scriptRewrites || []).filter((item) => item?.originalTranscript && item?.rewrittenLine);
    let written = 0;

    for (const item of items) {
        const isHook = item.timestamp <= hookWindowSeconds;
        try {
            await createEntry(buildRewriteContent(item, { ...context, isHook }), {
                topic: isHook ? 'hook' : 'general',
                exemplarType: isHook ? KB_EXEMPLAR_TYPES.HOOK_REWRITE : KB_EXEMPLAR_TYPES.SCRIPT_REWRITE,
                contentCategory: context.contentCategory,
                platform: context.platform,
                actualViews: context.actualViews,
                measuredImpact: context.measuredImpact,
                source: context.source || 'analysis_rewrite',
                sourceType: 'script_rewrite',
                contentType: 'exemplar',
            });
            written += 1;
        } catch (error) {
            console.error('[FeedbackKB] Failed to ingest script rewrite exemplar:', error.message);
        }
    }

    return written;
};

/**
 * Convenience wrapper for admin creator ingest: writes both exemplar kinds from
 * one analyzed video. Never throws — exemplar ingestion is best-effort enrichment.
 */
export const ingestAnalyzedVideoExemplars = async ({ frameFeedback, scriptRewrites }, context = {}) => {
    try {
        const pairs = await ingestFeedbackImpactPairs(frameFeedback, context);
        const rewrites = await ingestScriptRewriteExemplars(scriptRewrites, context);
        if (pairs + rewrites > 0) {
            console.log(`[FeedbackKB] Ingested ${pairs} impact pair(s) and ${rewrites} rewrite exemplar(s)`);
        }
        return { pairs, rewrites };
    } catch (error) {
        console.error('[FeedbackKB] Exemplar ingestion failed:', error.message);
        return { pairs: 0, rewrites: 0 };
    }
};
