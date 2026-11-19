/**
 * Bright Data adapter for public TikTok data (LEARNING_PROVIDER=brightdata, key in BRIGHTDATA_API_KEY).
 *
 * Every call is one asynchronous Bright Data job: trigger, poll until ready, download the records.
 * Jobs take roughly 1 to 3 minutes, so the collector runs several at once. Billing is per successful
 * record; error records (dead page, no results) are free and skipped here.
 *
 * Datasets, checked against the live API on 2026-11-19:
 *   search      gd_m7n5ixlw1gc4no56kx  "Posts by Search URL" (fast), input { url: tiktok.com/search?q=... }
 *   creator     gd_m7n5v2gq296pex2f5m  "Posts by Profile" (fast), input { url: tiktok.com/@handle }
 *   stats       gd_lu702nij2f790tmv9h  "Posts", collect by URL, input { url: video url } (many per job)
 * Keyword discovery on the Posts dataset also works but took ~10 minutes, so it is not used.
 *
 * Only the full "Posts" dataset (stats) returns the video file link (video_url / cdn_link; cdn_url is a
 * tiktok.com page, not the file), TikTok's auto-captions (subtitle_url, subtitle_info, valid ~3 days),
 * the cover image and top comments. The fast search/profile datasets return none of these (checked
 * 2026-11-19). So re-checks and the deep analyzer, which both use the stats dataset, get them as
 * `extras`; links are session-bound, so downloads send the record's tt_chain_token cookie.
 */
import { registerProvider } from './providers.js';
import { parseCaptions } from '../deep-features.js';

const BASE = 'https://api.brightdata.com/datasets/v3';
export const DATASETS = Object.freeze({
    search: 'gd_m7n5ixlw1gc4no56kx',
    creator: 'gd_m7n5v2gq296pex2f5m',
    stats: 'gd_lu702nij2f790tmv9h',
});
const DONE = new Set(['ready', 'failed', 'canceled']);
const MAX_RETRIES = 4;

/** One Bright Data post record -> provider-contract Video (validated later by cleanVideo). */
export const toVideo = (r) => ({
    externalId: r.post_id,
    creatorExternalId: r.profile_id,
    url: r.url,
    caption: r.description,
    hashtags: Array.isArray(r.hashtags) ? r.hashtags : [],
    soundId: r.music?.id,
    soundTitle: r.music?.title ?? (typeof r.original_sound === 'string' ? r.original_sound : null),
    durationSec: r.video_duration,
    postedAt: r.create_time,
    region: r.region,
    language: null,
    views: r.play_count,
    likes: r.digg_count,
    comments: r.comment_count,
    shares: r.num_share_count ?? r.share_count,
    saves: r.collect_count,
});

export const toCreator = (r) => (r?.profile_id
    ? { externalId: r.profile_id, handle: r.account_id ?? null, followers: r.profile_followers ?? null }
    : null);

const isVideoRecord = (r) => r && !r.error && r.post_id && (r.post_type == null || r.post_type === 'video');

/** Hosts TikTok serves video files and captions from. Provider links to anything else are ignored. */
const MEDIA_HOST = /(^|\.)(tiktok\.com|tiktokcdn\.com|tiktokcdn-us\.com|tiktokcdn-eu\.com|tiktokv\.com|tiktokv\.us|tiktokv\.eu|ibytedtos\.com|ibyteimg\.com|byteoversea\.com|muscdn\.com)$/i;
export const isMediaUrl = (x) => {
    try {
        const u = new URL(String(x));
        return u.protocol === 'https:' && MEDIA_HOST.test(u.hostname);
    } catch {
        return false;
    }
};

/** Headers TikTok's CDN expects for a session-bound link. */
export const mediaHeaders = (chainToken) => ({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
    Referer: 'https://www.tiktok.com/',
    ...(typeof chainToken === 'string' && /^[\w%.=+/-]{1,500}$/.test(chainToken) ? { Cookie: `tt_chain_token=${chainToken}` } : {}),
});

const pickSubtitle = (r) => {
    const infos = Array.isArray(r.subtitle_info) ? r.subtitle_info : [];
    const top = isMediaUrl(r.subtitle_url) ? r.subtitle_url : null;
    const match = infos.find((s) => s?.url === top) ?? infos.find((s) => isMediaUrl(s?.url)) ?? null;
    const url = top ?? match?.url ?? null;
    return url ? { url, language: typeof match?.language_code_name === 'string' ? match.language_code_name.slice(0, 16) : null } : null;
};

const countOf = (x) => (Number.isFinite(Number(x)) && Number(x) >= 0 ? Math.round(Number(x)) : null);

/** The non-numeric extras of a full Posts record: file link, captions link, cover, top comments. */
export const toExtras = (r) => ({
    externalId: r.post_id,
    videoUrl: [r.video_url, r.cdn_link].find(isMediaUrl) ?? null,
    chainToken: typeof r.tt_chain_token === 'string' ? r.tt_chain_token : null,
    coverUrl: isMediaUrl(r.preview_image) ? r.preview_image : null,
    subtitle: pickSubtitle(r),
    region: typeof r.region === 'string' ? r.region.slice(0, 8) : null,
    // Comment text and counts only (no commenter handles): audience-reaction evidence, never shown to users.
    topComments: (Array.isArray(r.comments) ? r.comments : [])
        .map((c) => ({ text: typeof c?.comment === 'string' ? c.comment.trim().slice(0, 300) : '', likes: countOf(c?.likes), replies: countOf(c?.num_of_replies), at: c?.date ?? null }))
        .filter((c) => c.text)
        .sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0))
        .slice(0, 20),
});

const CAPTION_CONCURRENCY = 8;
const CAPTION_TIMEOUT_MS = 15_000;

export const createBrightDataAdapter = ({
    apiKey,
    fetchImpl = globalThis.fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    pollMs = 10_000,
    timeoutMs = 15 * 60_000,
} = {}) => {
    if (!apiKey) throw new Error('Bright Data API key missing');
    const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

    /** fetch with retries on 429 and 5xx (Retry-After honoured, else 2, 4, 8, 16 s). */
    const request = async (url, init = {}) => {
        for (let attempt = 0; ; attempt++) {
            const res = await fetchImpl(url, { ...init, headers });
            if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
                const after = Number(res.headers?.get?.('retry-after'));
                await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * 2 ** attempt);
                continue;
            }
            return res;
        }
    };

    const errorText = async (res) => String(await res.text().catch(() => '')).slice(0, 200);

    /** Runs one job and returns its records (error records included; callers filter). */
    const runJob = async (datasetId, input, { limitPerInput } = {}) => {
        const qs = new URLSearchParams({ dataset_id: datasetId, format: 'json', include_errors: 'true' });
        const body = { input, ...(limitPerInput ? { limit_per_input: limitPerInput } : {}) };
        const trig = await request(`${BASE}/trigger?${qs}`, { method: 'POST', body: JSON.stringify(body) });
        if (!trig.ok) throw new Error(`Bright Data trigger ${trig.status}: ${await errorText(trig)}`);
        const snapshotId = (await trig.json())?.snapshot_id;
        if (!snapshotId) throw new Error('Bright Data trigger returned no snapshot id');

        const started = Date.now();
        for (;;) {
            if (Date.now() - started > timeoutMs) throw new Error(`Bright Data job ${snapshotId} timed out`);
            await sleep(pollMs);
            const res = await request(`${BASE}/progress/${snapshotId}`);
            if (!res.ok) throw new Error(`Bright Data progress ${res.status}: ${await errorText(res)}`);
            const p = await res.json();
            if (!DONE.has(p?.status)) continue;
            if (p.status !== 'ready') throw new Error(`Bright Data job ${p.status}: ${String(p.error_message ?? '').slice(0, 200)}`);
            break;
        }

        for (;;) {
            if (Date.now() - started > timeoutMs) throw new Error(`Bright Data snapshot ${snapshotId} never became downloadable`);
            const res = await request(`${BASE}/snapshot/${snapshotId}?format=json`);
            if (res.status === 202) { await sleep(pollMs); continue; }
            if (res.status === 400) {
                const msg = await errorText(res);
                if (/empty/i.test(msg)) return [];
                throw new Error(`Bright Data snapshot 400: ${msg}`);
            }
            if (!res.ok) throw new Error(`Bright Data snapshot ${res.status}: ${await errorText(res)}`);
            const data = await res.json();
            return Array.isArray(data) ? data : data ? [data] : [];
        }
    };

    const billable = (records) => records.filter((r) => r && !r.error).length;

    /** Caption text for each extra that has a captions link (several at once). Failures leave captions null. */
    const fetchCaptions = async (extras) => {
        const queue = extras.filter((e) => e.subtitle?.url);
        const worker = async () => {
            for (let e = queue.shift(); e; e = queue.shift()) {
                try {
                    const res = await fetchImpl(e.subtitle.url, { headers: mediaHeaders(e.chainToken), signal: AbortSignal.timeout(CAPTION_TIMEOUT_MS) });
                    if (!res.ok) continue;
                    const segments = parseCaptions(String(await res.text()).slice(0, 500_000));
                    if (segments.length) e.captions = segments;
                } catch {
                    // captions are a bonus; the reading still counts
                }
            }
        };
        await Promise.all(Array.from({ length: CAPTION_CONCURRENCY }, worker));
        return extras;
    };

    return {
        async searchVideos({ query, limit = 30 }) {
            const url = `https://www.tiktok.com/search?q=${encodeURIComponent(query)}`;
            const records = await runJob(DATASETS.search, [{ url }], { limitPerInput: limit });
            const posts = records.filter(isVideoRecord);
            const creators = new Map();
            for (const r of posts) {
                const c = toCreator(r);
                if (c && !creators.has(c.externalId)) creators.set(c.externalId, c);
            }
            return { videos: posts.map(toVideo), creators: [...creators.values()], used: billable(records) };
        },

        async creatorVideos({ handle, limit = 30 }) {
            if (!handle) throw new Error('creator has no handle; Bright Data needs the profile URL');
            const url = `https://www.tiktok.com/@${encodeURIComponent(String(handle).replace(/^@/, ''))}`;
            const records = await runJob(DATASETS.creator, [{ url }], { limitPerInput: limit });
            const posts = records.filter(isVideoRecord);
            return { videos: posts.map(toVideo), creator: posts.length ? toCreator(posts[0]) : null, used: billable(records) };
        },

        /** Fresh numbers plus `extras` (file link, captions, comments); withCaptions downloads caption text. */
        async videoStats({ ids, videos = [], withCaptions = true }) {
            const urls = new Map(videos.filter((v) => v?.url).map((v) => [v.externalId, v.url]));
            const input = ids.filter((id) => urls.has(id)).map((id) => ({ url: urls.get(id) }));
            if (!input.length) return { stats: [], used: 0 };
            const records = await runJob(DATASETS.stats, input);
            const ok = records.filter((r) => r && !r.error && r.post_id);
            const stats = ok.map((r) => {
                const v = toVideo(r);
                return { externalId: v.externalId, views: v.views, likes: v.likes, comments: v.comments, shares: v.shares, saves: v.saves };
            });
            const extras = withCaptions ? await fetchCaptions(ok.map(toExtras)) : ok.map(toExtras);
            return { stats, extras, used: billable(records) };
        },
    };
};

registerProvider('brightdata', (env) => {
    const apiKey = String(env.BRIGHTDATA_API_KEY ?? '').trim();
    if (!apiKey) {
        console.warn('[learning] LEARNING_PROVIDER=brightdata but BRIGHTDATA_API_KEY is not set; collection skipped');
        return null;
    }
    return createBrightDataAdapter({ apiKey });
});
