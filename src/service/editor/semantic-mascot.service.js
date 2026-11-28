/**
 * Semantic mascot-fit check: decides whether a storyboard's subjects overlap a style's painted-mascot
 * vocabulary using embedding cosine similarity. A story about a "leviathan" fits Impasto Oil's
 * `whale` vocabulary even though the word "leviathan" is not in the mascotSubjects list; a story
 * about a "SaaS onboarding funnel" fits nothing painted.
 *
 * Shipped dark: EDITOR_SEMANTIC_MASCOT_FIT must be set to "true" for this path to run. When the flag
 * is off (default), consumers fall back to the word-overlap check in storyboard.service.js so Stage 1
 * behaviour is preserved. When the flag is on but no provider token is set or a provider call fails,
 * we also fall back to the overlap check: there is never a hard dependency on the embedding provider.
 *
 * Embeddings are cached per process: the style vocabularies change rarely (only when a new style's
 * mascotSubjects are declared), and each storyboard's subject string is embedded once per project.
 */

import crypto from 'node:crypto';

/** On by default once EDITOR_SEMANTIC_MASCOT_FIT=true in the environment. */
export const semanticMascotFitEnabled = () => String(process.env.EDITOR_SEMANTIC_MASCOT_FIT ?? '').toLowerCase() === 'true';

/** Cosine similarity threshold above which the story is considered a mascot fit. Tuned by hand. */
export const DEFAULT_THRESHOLD = Number(process.env.EDITOR_SEMANTIC_MASCOT_FIT_THRESHOLD ?? 0.35) || 0.35;

const CACHE = new Map();
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

/** Build the string embedded for a style's mascot vocabulary. */
export const mascotCorpus = (mascotSubjects) => (mascotSubjects ?? []).join(', ');

/** Build the string embedded for a storyboard's subject registry. */
export const storyCorpus = (subjects) => (subjects ?? [])
    .filter((sb) => sb && (sb.role === 'protagonist' || sb.role === 'supporting' || sb.role === 'object'))
    .map((sb) => `${sb.name}: ${sb.description}`.trim())
    .join('; ');

export const cosine = (a, b) => {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let k = 0; k < a.length; k += 1) {
        dot += a[k] * b[k];
        na += a[k] * a[k];
        nb += b[k] * b[k];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / Math.sqrt(na * nb);
};

/**
 * Embed one string via the configured provider. Returns a Float32Array-like number[] or null when
 * no provider is configured. Cached by (provider, string) hash.
 */
export async function embed(text, { provider: providerOverride } = {}) {
    const clean = String(text ?? '').trim();
    if (!clean) return null;
    const provider = providerOverride ?? getEmbeddingProvider();
    if (!provider) return null;
    const key = `${provider.id}:${hash(clean)}`;
    const cached = CACHE.get(key);
    if (cached) return cached;
    try {
        const vec = await provider.embed(clean);
        if (!Array.isArray(vec) || vec.length === 0) return null;
        CACHE.set(key, vec);
        return vec;
    } catch (_err) {
        return null;
    }
}

/**
 * The semantic check. Returns true when the story fits the style's mascot vocabulary above the
 * configured threshold, false otherwise. Returns `null` when the semantic path cannot answer (flag
 * off, provider missing, call failed); the caller should fall back to the word-overlap heuristic.
 */
export async function semanticSubjectMatchesMascot({ subjects, mascotSubjects, threshold = DEFAULT_THRESHOLD, provider } = {}) {
    if (!semanticMascotFitEnabled()) return null;
    if (!Array.isArray(mascotSubjects) || mascotSubjects.length === 0) return true;
    const story = storyCorpus(subjects);
    if (!story) return null;
    const [storyVec, mascotVec] = await Promise.all([embed(story, { provider }), embed(mascotCorpus(mascotSubjects), { provider })]);
    if (!storyVec || !mascotVec) return null;
    const score = cosine(storyVec, mascotVec);
    return score >= threshold;
}

/**
 * Chooses an embedding provider from the environment. Returns null when nothing is configured; the
 * caller falls back to the word-overlap check. Providers are registered here (OpenAI today; Cohere,
 * Voyage, etc. slot in trivially) so the service file above never knows about any SDK.
 */
export function getEmbeddingProvider() {
    const name = String(process.env.EDITOR_EMBEDDING_PROVIDER ?? '').toLowerCase().trim();
    if (!name || name === 'none') return null;
    if (name === 'openai') {
        if (!process.env.OPENAI_API_KEY) return null;
        const model = process.env.EDITOR_EMBEDDING_MODEL || 'text-embedding-3-small';
        return {
            id: `openai:${model}`,
            async embed(text) {
                const res = await fetch('https://api.openai.com/v1/embeddings', {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                    },
                    body: JSON.stringify({ input: text, model }),
                });
                if (!res.ok) throw new Error(`OpenAI embeddings HTTP ${res.status}`);
                const data = await res.json();
                return data?.data?.[0]?.embedding ?? null;
            },
        };
    }
    return null;
}

/** Reset the in-process embedding cache (tests). */
export function __resetSemanticMascotCache() {
    CACHE.clear();
}
