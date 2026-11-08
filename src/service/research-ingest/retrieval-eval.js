/**
 * Retrieval health check for research batches.
 *
 * 30 fixed queries (6 each: hook, pacing, caption, audio, views) run against the raw vector
 * search (before the per-query research cap) so the check sees what the cap would be hiding.
 * A batch is rolled back when, after ingest:
 *   - research docs take more than 5 of the top 10 for any query, or
 *   - the owner's core content (the "Viral Creator" PDF chunks and the seeded insights) disappears
 *     from the top 10 for more than 3 queries where it previously appeared, or
 *   - the vector index errors or stops returning results.
 */
import { KNOWLEDGE_BASE_VECTOR_INDEX } from '../../config/index.js';

export const EVAL_TOP_K = 10;

const Q = (category, topics, queries) => queries.map((query) => ({ category, topics, query }));

export const EVAL_QUERIES = Object.freeze([
    ...Q('hook', ['hook', 'general'], [
        'How should a short-form video open in the first 3 seconds to stop the scroll?',
        'Hook lines that create curiosity for a TikTok about personal finance',
        'Pattern interrupt at the start of an Instagram Reel',
        'Bold claim or question as the opening line of a YouTube Short',
        'Why viewers swipe away in the first second of a video',
        'Visual hook versus spoken hook for a talking-head video',
    ]),
    ...Q('pacing', ['pacing', 'general'], [
        'How often should I cut in a 30 second talking-head video?',
        'Jump cuts and b-roll timing to keep retention high',
        'Ideal video length for TikTok versus YouTube Shorts',
        'Dead air and slow sections that cause drop-off mid-video',
        'Pacing the payoff so viewers watch to the end',
        'Editing rhythm for a tutorial short with many steps',
    ]),
    ...Q('caption', ['caption', 'general'], [
        'On-screen text placement so captions are readable on TikTok',
        'Keyword captions versus full subtitles in short-form video',
        'How long should text stay on screen in a Reel?',
        'Caption hooks that summarize the video in the first frame',
        'Hashtags and caption copy for discovery on Instagram Reels',
        'Font size and contrast for captions viewed on a phone',
    ]),
    ...Q('audio', ['audio', 'general'], [
        'Trending sound versus original audio for reach on TikTok',
        'Voiceover or background music for an educational short',
        'Music volume relative to voice in a short-form video',
        'How long a trending audio stays useful before it is stale',
        'Sound effects that add emphasis in fast-paced edits',
        'Audio quality problems that make viewers scroll away',
    ]),
    ...Q('views', ['views_predictor', 'advanced_analytics', 'general'], [
        'How many views does a typical short-form video get for a small creator?',
        'Retention rate needed for a Short to get pushed by the algorithm',
        'Signals the TikTok For You feed uses to rank videos',
        'Instagram Reels ranking signals like sends and watch time',
        'Benchmarks for average view duration and completion rate',
        'What percent of short-form posts go viral past 100k views?',
    ]),
]);

/** The owner's core content: the "Viral Creator" hooks PDF chunks and the seeded insights. */
export const isCoreDoc = (doc) => {
    const m = doc?.metadata || {};
    if (m.origin === 'research') return false;
    return (m.source === 'Viral Creator' && m.contentType === 'algorithm_breakdown') || m.source === 'manual_note';
};

export const isResearchDoc = (doc) => doc?.metadata?.origin === 'research';

/** Default vector search: raw $vectorSearch on knowledgebases (no research cap, no vague filter). */
export const defaultVectorSearch = async ({ queryVector, topics, limit }) => {
    const { KnowledgeBase } = await import('../../model/knowledge-base.model.js');
    return KnowledgeBase.aggregate([
        {
            $vectorSearch: {
                index: KNOWLEDGE_BASE_VECTOR_INDEX,
                queryVector,
                path: 'embedding',
                limit,
                numCandidates: Math.max(100, limit * 10),
                filter: { 'metadata.topic': { $in: topics } },
            },
        },
        { $project: { _id: 1, 'metadata.origin': 1, 'metadata.source': 1, 'metadata.contentType': 1, 'metadata.researchId': 1 } },
    ]);
};

/**
 * Embed the eval queries once per run (the same vectors are used before and after).
 * @returns {Promise<number[][]>}
 */
export const embedEvalQueries = (embed) => embed(EVAL_QUERIES.map((q) => q.query));

/**
 * Run all queries and record the top 10 for each.
 * @returns {Promise<{ ok: boolean, error?: string, queries: {category, query, ids: string[], research: number, core: number}[] }>}
 */
export const takeSnapshot = async ({ vectors, vectorSearch = defaultVectorSearch }) => {
    const queries = [];
    try {
        for (let i = 0; i < EVAL_QUERIES.length; i++) {
            const { category, topics, query } = EVAL_QUERIES[i];
            const docs = (await vectorSearch({ queryVector: vectors[i], topics, limit: EVAL_TOP_K })) || [];
            const top = docs.slice(0, EVAL_TOP_K);
            queries.push({
                category,
                query,
                ids: top.map((d) => String(d._id)),
                research: top.filter(isResearchDoc).length,
                core: top.filter(isCoreDoc).length,
            });
        }
    } catch (error) {
        return { ok: false, error: `vector search failed: ${error.message}`, queries };
    }
    return { ok: true, queries };
};

/** Compare snapshots. Returns { passed, reasons[] }. */
export const evaluateSnapshots = (before, after) => {
    const reasons = [];
    if (!after?.ok) reasons.push(after?.error || 'vector search failed');
    else {
        const emptyNow = after.queries.filter((q, i) => q.ids.length === 0 && (before?.queries?.[i]?.ids?.length ?? 1) > 0);
        if (emptyNow.length) reasons.push(`vector index returned no results for ${emptyNow.length} quer${emptyNow.length === 1 ? 'y' : 'ies'}`);

        const crowded = after.queries.filter((q) => q.research > 5);
        if (crowded.length) reasons.push(`research docs took more than 5 of the top ${EVAL_TOP_K} for ${crowded.length} quer${crowded.length === 1 ? 'y' : 'ies'} (e.g. "${crowded[0].query}")`);

        if (before?.ok) {
            const lostCore = after.queries.filter((q, i) => (before.queries[i]?.core || 0) > 0 && q.core === 0);
            if (lostCore.length > 3) reasons.push(`owner core content dropped out of the top ${EVAL_TOP_K} for ${lostCore.length} queries`);
        }
    }
    return { passed: reasons.length === 0, reasons };
};
