/**
 * Public social data providers (docs/learning-engine/PLAN.md, section 3).
 *
 * Collection talks only to this contract, so the vendor can be chosen or swapped with one setting
 * (LEARNING_PROVIDER) and one adapter file. Nothing is collected until a real adapter is registered and
 * configured. Every record from a provider is validated here before it can reach the database.
 *
 * Contract (all async; `used` = billable records consumed, for the daily budget):
 *   searchVideos({ query, region, limit })        -> { videos: Video[], creators: Creator[], used }
 *   creatorVideos({ externalId, handle, limit })  -> { videos: Video[], creator: Creator|null, used }
 *   videoStats({ ids })                           -> { stats: Stats[], used }   (ids: <= 20 externalIds)
 *
 *   Video   = { externalId, creatorExternalId, url, caption, hashtags[], soundId, soundTitle, durationSec,
 *               postedAt, region, language, views, likes, comments, shares, saves }
 *   Creator = { externalId, handle, followers }
 *   Stats   = { externalId, views, likes, comments, shares, saves }
 */

const registry = new Map();
let testOverride = null;

/** Adapters call this at import time: registerProvider('name', (env) => adapter | null). */
export const registerProvider = (name, factory) => {
    registry.set(String(name).toLowerCase(), factory);
};

/** The configured provider, or null (collection is skipped) when none is set, known and configured. */
export const getProvider = (env = process.env) => {
    if (testOverride) return testOverride;
    const name = String(env.LEARNING_PROVIDER ?? '').trim().toLowerCase();
    if (!name) return null;
    const factory = registry.get(name);
    if (!factory) {
        console.warn(`[learning] LEARNING_PROVIDER "${name}" has no adapter; collection skipped`);
        return null;
    }
    const adapter = factory(env);
    return adapter ? { name, ...adapter } : null;
};

export const setProviderForTests = (provider) => {
    testOverride = provider ? { name: provider.name ?? 'test', ...provider } : null;
};

// ---- validation: provider data is untrusted input

const count = (x) => {
    const n = Number(x);
    return Number.isFinite(n) && n >= 0 && n < 1e13 ? Math.round(n) : null;
};
const text = (x, max) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : null);
const id = (x) => {
    const s = typeof x === 'number' ? String(x) : typeof x === 'string' ? x.trim() : '';
    return /^[A-Za-z0-9._:-]{1,64}$/.test(s) ? s : null;
};
const httpsUrl = (x) => {
    try {
        const u = new URL(String(x));
        return u.protocol === 'https:' ? u.toString().slice(0, 500) : null;
    } catch {
        return null;
    }
};
const date = (x) => {
    if (x == null || x === '') return null;
    const d = typeof x === 'number' && x < 1e11 ? new Date(x * 1000) : new Date(x);
    const t = d.getTime();
    return Number.isFinite(t) && t > Date.UTC(2015, 0, 1) && t < Date.now() + 60 * 60 * 1000 ? d : null;
};

export const cleanVideo = (v) => {
    const externalId = id(v?.externalId);
    if (!externalId) return null;
    const duration = Number(v?.durationSec);
    return {
        externalId,
        creatorExternalId: id(v?.creatorExternalId),
        url: httpsUrl(v?.url),
        caption: text(v?.caption, 2200),
        hashtags: (Array.isArray(v?.hashtags) ? v.hashtags : [])
            .map((h) => text(String(h ?? '').replace(/^#/, ''), 100)?.toLowerCase())
            .filter(Boolean)
            .slice(0, 30),
        soundId: id(v?.soundId),
        soundTitle: text(v?.soundTitle, 200),
        durationSec: Number.isFinite(duration) && duration > 0 && duration < 4 * 3600 ? Math.round(duration * 10) / 10 : null,
        postedAt: date(v?.postedAt),
        region: text(v?.region, 8),
        language: text(v?.language, 16),
        views: count(v?.views),
        likes: count(v?.likes),
        comments: count(v?.comments),
        shares: count(v?.shares),
        saves: count(v?.saves),
    };
};

export const cleanCreator = (c) => {
    const externalId = id(c?.externalId);
    return externalId ? { externalId, handle: text(c?.handle, 100), followers: count(c?.followers) } : null;
};

export const cleanStats = (s) => {
    const externalId = id(s?.externalId);
    const views = count(s?.views);
    return externalId && views != null
        ? { externalId, views, likes: count(s?.likes), comments: count(s?.comments), shares: count(s?.shares), saves: count(s?.saves) }
        : null;
};

export const usedOf = (result) => {
    const n = Number(result?.used);
    return Number.isFinite(n) && n >= 0 ? n : 0;
};
