import openai from '../../lib/openai.js';
import { embeddingModel } from '../../config/ai-models.js';
import { recordEmbedding } from '../../lib/ai-tracking.js';
import { VideoPerformanceDataset } from '../../model/VideoPerformanceDataset.model.js';

/**
 * Viral examples (admin-uploaded videos with real analytics) that the editor learns from. Ranked in
 * memory: similarity to the user's video plus real performance. The dataset is small enough
 * (hundreds) that no vector index is needed.
 */

const MAX_POOL = 2000;
export const EXEMPLAR_COUNT = 5;

export const cosine = (a, b) => {
    if (!a?.length || !b?.length || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i += 1) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

const median = (values) => {
    const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/** Performance on a 0-1 scale within the pool: log views, plus share and retention bonuses. */
const performance = (doc, maxLogViews) => {
    const views = maxLogViews > 0 ? Math.log10((doc.actualViews ?? 0) + 1) / maxLogViews : 0;
    const shares = doc.actualViews ? Math.min(1, ((doc.shares ?? 0) / doc.actualViews) * 50) : 0;
    const retention = Number.isFinite(doc.retentionRate) ? Math.min(1, doc.retentionRate > 1 ? doc.retentionRate / 100 : doc.retentionRate) : 0;
    return 0.7 * views + 0.15 * shares + 0.15 * retention;
};

/**
 * Rank candidates for one edit. Same-platform examples get a small boost; when no query vector is
 * available, ranking falls back to performance alone.
 * @returns {Array<object>} top `count` docs with `_score`
 */
export function rankExemplars(pool, queryVector, { platform = null, niche = null, count = EXEMPLAR_COUNT } = {}) {
    const maxLogViews = Math.max(0, ...pool.map((d) => Math.log10((d.actualViews ?? 0) + 1)));
    return pool
        .map((d) => {
            const sim = queryVector ? cosine(queryVector, d.editEmbedding) : 0;
            const perf = performance(d, maxLogViews);
            const boost = (platform && d.platform === platform ? 0.05 : 0) + (niche && d.niche === niche ? 0.05 : 0);
            return { ...d, _score: (queryVector ? 0.55 * sim + 0.45 * perf : perf) + boost };
        })
        .sort((a, b) => b._score - a._score)
        .slice(0, count);
}

/** Median editing numbers among the strongest examples in a niche (or overall). */
export function nicheBenchmarks(pool, niche) {
    const inNiche = niche ? pool.filter((d) => d.niche === niche) : [];
    const base = inNiche.length >= 3 ? inNiche : pool;
    const top = [...base].sort((a, b) => (b.actualViews ?? 0) - (a.actualViews ?? 0)).slice(0, Math.max(3, Math.ceil(base.length / 2)));
    const pick = (k) => {
        const m = median(top.map((d) => d.editProfile?.[k]));
        return m == null ? null : Math.round(m * 10) / 10;
    };
    return {
        scope: inNiche.length >= 3 ? `top ${niche} examples` : 'top examples across niches',
        sample: top.length,
        avgShotSec: pick('avgShotSec'),
        cutsPerMin: pick('cutsPerMin'),
        zoomsPerMin: pick('zoomsPerMin'),
        speechWpm: pick('speechWpm'),
        durationSec: pick('durationSec'),
        medianViews: median(top.map((d) => d.actualViews)),
    };
}

export async function embedText(text, { client = openai } = {}) {
    const started = Date.now();
    const model = embeddingModel();
    const res = await client.embeddings.create({ model, input: String(text).slice(0, 8000) });
    recordEmbedding({ model, inputTokens: res?.usage?.prompt_tokens, latencyMs: Date.now() - started, label: 'editor_embedding' });
    return res.data[0].embedding;
}

/**
 * Load profiled examples and pick the best matches for a video. Never throws: the editor still
 * works (on the knowledge base alone) when the dataset is empty or embeddings fail.
 */
export async function selectExemplars({ description, platform, niche }, { embed = embedText } = {}) {
    try {
        const pool = await VideoPerformanceDataset.find({ editProfileStatus: 'ready' })
            .select('+editEmbedding platform niche actualViews retentionRate shares likes comments saves followers creatorSize viralCategory durationSeconds editProfile')
            .sort({ actualViews: -1 })
            .limit(MAX_POOL)
            .lean();
        if (pool.length === 0) return { exemplars: [], benchmarks: null };
        let vector = null;
        try {
            vector = description ? await embed(description) : null;
        } catch (err) {
            console.warn('[Editor] Exemplar embedding failed, ranking by performance only:', err.message);
        }
        const exemplars = rankExemplars(pool, vector, { platform, niche }).map(({ editEmbedding, ...d }) => d);
        return { exemplars, benchmarks: nicheBenchmarks(pool, niche) };
    } catch (err) {
        console.warn('[Editor] Could not load viral examples:', err.message);
        return { exemplars: [], benchmarks: null };
    }
}
