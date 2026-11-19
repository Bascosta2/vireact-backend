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
 */
import { registerProvider } from './providers.js';

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

        async videoStats({ ids, videos = [] }) {
            const urls = new Map(videos.filter((v) => v?.url).map((v) => [v.externalId, v.url]));
            const input = ids.filter((id) => urls.has(id)).map((id) => ({ url: urls.get(id) }));
            if (!input.length) return { stats: [], used: 0 };
            const records = await runJob(DATASETS.stats, input);
            const stats = records.filter((r) => r && !r.error && r.post_id).map((r) => {
                const v = toVideo(r);
                return { externalId: v.externalId, views: v.views, likes: v.likes, comments: v.comments, shares: v.shares, saves: v.saves };
            });
            return { stats, used: billable(records) };
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
