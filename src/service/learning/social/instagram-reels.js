/**
 * Bright Data adapter for public Instagram Reels (second platform next to TikTok; brightdata.js).
 *
 * Off unless LEARNING_REELS_ENABLED=true. Uses the same key as TikTok (LEARNING_PROVIDER=brightdata,
 * BRIGHTDATA_API_KEY) and the owner's own Instagram dataset ids:
 *   BRIGHTDATA_IG_REELS_DATASET_ID     required. "Instagram - Reels": collect by reel URL (re-checks) and
 *                                      discover by profile URL (type=discover_new, discover_by=url; a
 *                                      creator's recent reels, input { url, num_of_posts })
 *   BRIGHTDATA_IG_PROFILES_DATASET_ID  optional. "Instagram - Profiles", collect by profile URL: checks a
 *                                      seed account exists and reads its followers before reels are bought
 *
 * Instagram has no keyword search in Bright Data's documented Reels/Profiles APIs, so discovery starts
 * from seed accounts (LEARNING_REELS_SEEDS="handle:niche,handle2") instead of the niche search queries.
 *
 * Field mapping (Bright Data docs, Reels "collect by URL" / "discover by URL" sample responses, read
 * 2026-11-23; not checked against the live API from here):
 *   shortcode -> externalId      user_posted -> creator (keyed by handle: records carry no separate user id)
 *   views -> views               the "views" metric, the same one users' connected Instagram accounts report
 *                                (accounts/providers/instagram.js); video_play_count is NOT used, so one
 *                                creator's readings never mix two different counters
 *   likes, num_comments          shares / saves are not in the public data (null)
 *   length ("15.033", seconds) -> durationSec      date_posted (ISO) -> postedAt
 *   audio_url (.../reels/audio/<id>) -> soundId "ig:<id>" (prefixed so it can never match a TikTok sound id;
 *                                there is no audio title in the data)
 *   top_comments -> extras.topComments (text and counts only, like TikTok)
 */
import { registerPlatformProvider } from './providers.js';
import { createJobRunner } from './brightdata.js';
import { isNiche } from '../../../constants/taxonomy.js';

export const PLATFORM = 'instagram';
/** Seed accounts read per run (one profile record each, once per account). */
export const MAX_SEEDS = 200;
const DISCOVER = Object.freeze({ type: 'discover_new', discover_by: 'url' });

const HANDLE = /^[a-z0-9._]{1,30}$/;
const SHORTCODE = /^[A-Za-z0-9_-]{5,40}$/;
const DATASET_ID = /^gd_[a-z0-9]{6,40}$/i;

/** "@Some.User " -> "some.user"; null when it is not a valid Instagram username. */
export const normalizeHandle = (x) => {
    const h = String(x ?? '').trim().replace(/^@/, '').toLowerCase();
    return HANDLE.test(h) ? h : null;
};

export const reelsEnabled = (env = process.env) => String(env.LEARNING_REELS_ENABLED ?? '').trim().toLowerCase() === 'true';

/**
 * LEARNING_REELS_SEEDS: comma-separated "handle" or "handle:niche" (niche from the taxonomy; anything else
 * is dropped and the classifier labels the videos later). Invalid handles and duplicates are skipped.
 */
export const parseReelsSeeds = (raw) => {
    const seen = new Set();
    const seeds = [];
    for (const part of String(raw ?? '').split(',')) {
        const [h, n] = part.split(':').map((s) => s.trim());
        const handle = normalizeHandle(h);
        if (!handle || seen.has(handle)) continue;
        seen.add(handle);
        seeds.push({ handle, niche: n && isNiche(n.toLowerCase()) ? n.toLowerCase() : null });
        if (seeds.length >= MAX_SEEDS) break;
    }
    return seeds;
};

const profileUrl = (handle) => `https://www.instagram.com/${handle}/`;
const reelUrl = (shortcode) => `https://www.instagram.com/reel/${shortcode}/`;
const countOf = (x) => (x != null && x !== '' && Number.isFinite(Number(x)) && Number(x) >= 0 ? Math.round(Number(x)) : null);

const shortcodeOf = (r) => {
    if (typeof r?.shortcode === 'string' && SHORTCODE.test(r.shortcode)) return r.shortcode;
    const m = /instagram\.com\/(?:[\w.]+\/)?(?:reel|reels|p)\/([A-Za-z0-9_-]{5,40})/.exec(String(r?.url ?? ''));
    return m ? m[1] : null;
};

const audioIdOf = (url) => {
    const m = /instagram\.com\/reels\/audio\/(\d{1,40})/.exec(String(url ?? ''));
    return m ? `ig:${m[1]}` : null;
};

/** A usable reel: not an error record, has an id, and is a reel ("clips") when the type is given. */
export const isReelRecord = (r) => Boolean(r && !r.error && shortcodeOf(r) && (r.product_type == null || r.product_type === 'clips'));

/** One Bright Data Reels record -> provider-contract Video (validated later by cleanVideo). */
export const toReelVideo = (r) => {
    const shortcode = shortcodeOf(r);
    return {
        externalId: shortcode,
        creatorExternalId: normalizeHandle(r.user_posted),
        url: shortcode ? reelUrl(shortcode) : null,
        caption: r.description,
        hashtags: Array.isArray(r.hashtags) ? r.hashtags : [],
        soundId: audioIdOf(r.audio_url),
        soundTitle: null,
        durationSec: r.length == null || r.length === '' ? null : Number(r.length),
        postedAt: r.date_posted,
        region: null,
        language: null,
        views: countOf(r.views),
        likes: countOf(r.likes),
        comments: countOf(r.num_comments),
        shares: null,
        saves: null,
    };
};

/** The creator of a Reels record (user_posted, followers), or null. */
export const toReelCreator = (r) => {
    const handle = normalizeHandle(r?.user_posted);
    return handle ? { externalId: handle, handle, followers: countOf(r.followers) } : null;
};

/** One Bright Data Profiles record (account, followers) -> provider-contract Creator, or null. */
export const toProfileCreator = (p) => {
    const handle = !p || p.error ? null : normalizeHandle(p.account);
    return handle ? { externalId: handle, handle, followers: countOf(p.followers) } : null;
};

/** Top comments of a Reels record as an Extra (text and counts only; commenter names are dropped). */
export const toReelExtras = (r) => ({
    externalId: shortcodeOf(r),
    videoUrl: null,
    chainToken: null,
    coverUrl: null,
    subtitle: null,
    region: null,
    topComments: (Array.isArray(r.top_comments) ? r.top_comments : [])
        .map((c) => ({ text: typeof c?.comment === 'string' ? c.comment.trim().slice(0, 300) : '', likes: countOf(c?.likes), replies: countOf(c?.num_replies), at: c?.date_of_comment ?? null }))
        .filter((c) => c.text)
        .sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0))
        .slice(0, 20),
});

const firstCreator = (records) => records.map(toReelCreator).find(Boolean) ?? null;

/**
 * Provider contract (providers.js) for Instagram Reels. No searchVideos: discovery is by seed account
 * (creatorProfiles) and each creator's recent reels (creatorVideos).
 */
export const createInstagramReelsAdapter = ({ apiKey, datasets = {}, ...runnerOptions } = {}) => {
    if (!datasets.reels) throw new Error('Instagram Reels dataset id missing');
    const { runJob, billable } = createJobRunner({ apiKey, ...runnerOptions });

    return {
        platform: PLATFORM,

        /** Seed accounts that exist, with followers. Null when no Profiles dataset is configured. */
        creatorProfiles: datasets.profiles
            ? async ({ handles }) => {
                const input = [...new Set(handles.map(normalizeHandle).filter(Boolean))].map((h) => ({ url: profileUrl(h) }));
                if (!input.length) return { creators: [], used: 0 };
                const records = await runJob(datasets.profiles, input);
                return { creators: records.map(toProfileCreator).filter(Boolean), used: billable(records) };
            }
            : null,

        async creatorVideos({ handle, limit = 30 }) {
            const h = normalizeHandle(handle);
            if (!h) throw new Error('creator has no valid Instagram handle; Bright Data needs the profile URL');
            const records = await runJob(datasets.reels, [{ url: profileUrl(h), num_of_posts: limit }], { limitPerInput: limit, query: DISCOVER });
            const reels = records.filter(isReelRecord);
            return { videos: reels.map(toReelVideo), creator: firstCreator(reels), used: billable(records) };
        },

        /** Fresh numbers by reel URL, plus top comments as `extras`. */
        async videoStats({ ids, videos = [] }) {
            const urls = new Map(videos.filter((v) => v?.url).map((v) => [v.externalId, v.url]));
            const input = ids.filter((id) => urls.has(id)).map((id) => ({ url: urls.get(id) }));
            if (!input.length) return { stats: [], used: 0 };
            const records = await runJob(datasets.reels, input);
            const ok = records.filter(isReelRecord);
            const stats = ok.map((r) => {
                const v = toReelVideo(r);
                return { externalId: v.externalId, views: v.views, likes: v.likes, comments: v.comments, shares: null, saves: null };
            });
            return { stats, extras: ok.map(toReelExtras), used: billable(records) };
        },
    };
};

const datasetEnv = (env, name) => {
    const id = String(env[name] ?? '').trim();
    if (!id) return null;
    if (!DATASET_ID.test(id)) {
        console.warn(`[learning] ${name} does not look like a Bright Data dataset id (gd_...); ignored`);
        return null;
    }
    return id;
};

registerPlatformProvider(PLATFORM, (env) => {
    if (!reelsEnabled(env)) return null;
    if (String(env.LEARNING_PROVIDER ?? '').trim().toLowerCase() !== 'brightdata') {
        console.warn('[learning] LEARNING_REELS_ENABLED=true needs LEARNING_PROVIDER=brightdata; Reels collection skipped');
        return null;
    }
    const apiKey = String(env.BRIGHTDATA_API_KEY ?? '').trim();
    const reels = datasetEnv(env, 'BRIGHTDATA_IG_REELS_DATASET_ID');
    if (!apiKey || !reels) {
        console.warn('[learning] LEARNING_REELS_ENABLED=true but BRIGHTDATA_API_KEY or BRIGHTDATA_IG_REELS_DATASET_ID is not set; Reels collection skipped');
        return null;
    }
    return createInstagramReelsAdapter({ apiKey, datasets: { reels, profiles: datasetEnv(env, 'BRIGHTDATA_IG_PROFILES_DATASET_ID') } });
});
