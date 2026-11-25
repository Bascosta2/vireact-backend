import { env, inSeconds, num, requestJson as baseRequestJson, ReauthError } from './http.js';

/**
 * Facebook Pages: Facebook Login + Graph API, read-only. Scopes: pages_show_list (which Pages the person
 * manages), pages_read_engagement (the Page's videos and Reels) and read_insights (views, reach, average watch
 * time, retention). In Facebook's login dialog the person picks which Pages to share; /me/accounts returns only
 * those, so the Pages they choose are the Pages we read. The short-lived token is exchanged for a 60-day user
 * token (Facebook has no refresh: when it lapses the account asks to reconnect). Page tokens, fetched from that
 * user token on every read, are used for the insights. Settings: FACEBOOK_APP_ID, FACEBOOK_APP_SECRET,
 * FACEBOOK_GRAPH_VERSION. Publish scopes are deliberately not requested here: add them to FACEBOOK_SCOPES
 * (or an option on authUrl) when publishing ships.
 */

const AUTH_HOST = 'https://www.facebook.com';
const GRAPH = 'https://graph.facebook.com';
export const FACEBOOK_SCOPES = ['pages_show_list', 'pages_read_engagement', 'read_insights'];
const version = (e) => env('FACEBOOK_GRAPH_VERSION', e) || 'v25.0';
const MAX_PAGES = 5;
const VIDEO_METRICS = 'total_video_views,total_video_impressions_unique,total_video_avg_time_watched,total_video_retention_graph';
const REEL_METRICS = 'fb_reels_total_plays,post_impressions_unique,post_video_avg_time_watched,post_video_retention_graph,post_video_social_actions';
const VIDEO_FIELDS = 'id,description,created_time,length,permalink_url,picture,likes.limit(0).summary(true),comments.limit(0).summary(true),shares';
const q = encodeURIComponent;

/** Meta says the login is no longer valid: error 190, or error 10 with a session subcode. Often HTTP 400, so http.js misses it. */
export const isLoginGone = (error) => error?.code === 190 || (error?.code === 10 && [459, 460, 463, 467].includes(Number(error?.error_subcode)));

const requestJson = async (url, opts = {}) => {
    // http.js keeps only the message of a failed answer, so remember the error object Meta sent.
    let metaError = null;
    const real = opts.fetchImpl ?? fetch;
    const fetchImpl = async (u, init) => {
        const res = await real(u, init);
        const text = await res.text();
        try { metaError = JSON.parse(text)?.error ?? null; } catch { metaError = null; }
        return { status: res.status, ok: res.ok, text: async () => text };
    };
    try {
        return await baseRequestJson(url, { ...opts, fetchImpl });
    } catch (e) {
        if (!e.reauth && isLoginGone(metaError)) throw new ReauthError(metaError.message || 'Facebook login expired');
        throw e;
    }
};

/** First value of a named insight metric, or null. */
export const insightValue = (body, name) => (body?.data ?? []).find((d) => d.name === name)?.values?.[0]?.value ?? null;

/** Retention graph as percentages per interval: Facebook sends an array or an object keyed by interval position. */
export const parseRetention = (raw) => {
    const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object'
        ? Object.entries(raw).sort(([a], [b]) => Number(a) - Number(b)).map(([, v]) => v) : [];
    const curve = list.map(num).filter((x) => x != null);
    return curve.length ? curve.map((x) => Math.round(x * 10) / 10) : null;
};

/** Social actions on a Reel arrive as { comment, share }. */
const sumOf = (v) => (v && typeof v === 'object' ? num(v.share ?? v.shares) : num(v));

/** Turns one /video_insights answer into the stats the sync stores. */
export const parseInsights = (body, { reel = false } = {}) => {
    const views = num(insightValue(body, reel ? 'fb_reels_total_plays' : 'total_video_views'));
    const reach = num(insightValue(body, reel ? 'post_impressions_unique' : 'total_video_impressions_unique'));
    const watchMs = num(insightValue(body, reel ? 'post_video_avg_time_watched' : 'total_video_avg_time_watched'));
    const retention = parseRetention(insightValue(body, reel ? 'post_video_retention_graph' : 'total_video_retention_graph'));
    const shares = reel ? sumOf(insightValue(body, 'post_video_social_actions')) : null;
    return { views, reach, shares, avgWatchSec: watchMs != null ? Math.round(watchMs / 100) / 10 : null, retention };
};

/** One Page video or Reel from the list endpoints, in the shape every provider returns. */
export const parseVideo = (v, page, { reel = false } = {}) => ({
    externalId: String(v.id), url: v.permalink_url ? (/^https?:/.test(v.permalink_url) ? v.permalink_url : `https://www.facebook.com${v.permalink_url}`) : null,
    caption: v.description ?? null, postedAt: v.created_time ? new Date(v.created_time) : null,
    durationSec: num(v.length), thumbnailUrl: v.picture ?? null, mediaType: reel ? 'reel' : 'video',
    stats: { likes: num(v.likes?.summary?.total_count), comments: num(v.comments?.summary?.total_count), shares: num(v.shares?.count) },
    pageId: String(page.id),
});

export const facebook = {
    id: 'facebook',
    name: 'Facebook',
    usesPkce: false,
    isConfigured: (e = process.env) => Boolean(env('FACEBOOK_APP_ID', e) && env('FACEBOOK_APP_SECRET', e)),

    authUrl({ state, redirectUri, env: e = process.env }) {
        const u = new URL(`${AUTH_HOST}/${version(e)}/dialog/oauth`);
        u.search = new URLSearchParams({
            client_id: env('FACEBOOK_APP_ID', e), redirect_uri: redirectUri, response_type: 'code', scope: FACEBOOK_SCOPES.join(','), state,
        }).toString();
        return u.toString();
    },

    async exchangeCode({ code, redirectUri, env: e = process.env, fetchImpl }) {
        const app = `client_id=${q(env('FACEBOOK_APP_ID', e))}&client_secret=${q(env('FACEBOOK_APP_SECRET', e))}`;
        const short = await requestJson(`${GRAPH}/${version(e)}/oauth/access_token?${app}&redirect_uri=${q(redirectUri)}&code=${q(code)}`, { fetchImpl });
        if (!short?.access_token) throw new Error('Facebook sign-in returned no token');
        const long = await requestJson(`${GRAPH}/${version(e)}/oauth/access_token?grant_type=fb_exchange_token&${app}&fb_exchange_token=${q(short.access_token)}`, { fetchImpl });
        const token = long?.access_token ?? short.access_token;
        const perms = await requestJson(`${GRAPH}/${version(e)}/me/permissions?access_token=${q(token)}`, { fetchImpl }).catch(() => null);
        const scopes = (perms?.data ?? []).filter((p) => p.status === 'granted').map((p) => p.permission);
        return { access: token, refresh: null, accessExpiresAt: inSeconds(long?.expires_in ?? short.expires_in), refreshExpiresAt: null, scopes };
    },

    /** Disconnect: removes the app's access to the person's Facebook account. */
    async revoke({ access, env: e = process.env, fetchImpl }) {
        await requestJson(`${GRAPH}/${version(e)}/me/permissions?access_token=${q(access)}`, { method: 'DELETE', fetchImpl });
    },

    /** The Pages the person shared, with their Page tokens (never stored: fetched with the user token each time). */
    async pages({ access, env: e = process.env, fetchImpl }) {
        const body = await requestJson(`${GRAPH}/${version(e)}/me/accounts?fields=id,name,access_token,followers_count,fan_count,picture.type(large)&limit=${MAX_PAGES}&access_token=${q(access)}`, { fetchImpl });
        return (body?.data ?? []).filter((p) => p.id && p.access_token).slice(0, MAX_PAGES);
    },

    /** The account is the person's Facebook login; the followers are the shared Pages' followers together. */
    async profile({ access, env: e = process.env, fetchImpl }) {
        const me = await requestJson(`${GRAPH}/${version(e)}/me?fields=id,name&access_token=${q(access)}`, { fetchImpl });
        const pages = await this.pages({ access, env: e, fetchImpl });
        if (!pages.length) throw new Error('No Facebook Page was shared: connect again and choose a Page');
        const followers = pages.reduce((sum, p) => sum + (num(p.followers_count ?? p.fan_count) ?? 0), 0);
        return {
            externalId: String(me.id), handle: pages.map((p) => p.name).join(', ').slice(0, 120), displayName: pages[0].name ?? me.name ?? null,
            avatarUrl: pages[0].picture?.data?.url ?? null, followers,
        };
    },

    async listPosts({ access, account, maxPosts = 60, env: e = process.env, fetchImpl }) {
        const scopes = account?.tokens?.scopes;
        if (Array.isArray(scopes) && scopes.length && !scopes.includes('read_insights')) console.warn('[accounts] facebook: read_insights was not granted, so views and watch time are missing; reconnect and allow it');
        let insightsWarned = false;
        const pages = await this.pages({ access, env: e, fetchImpl });
        const perPage = Math.max(1, Math.ceil(maxPosts / Math.max(1, pages.length)));
        const out = [];
        for (const page of pages) {
            const seen = new Map();
            for (const [edge, reel] of [['video_reels', true], ['videos', false]]) {
                try {
                    const body = await requestJson(`${GRAPH}/${version(e)}/${page.id}/${edge}?fields=${q(VIDEO_FIELDS)}&limit=${Math.min(perPage, 50)}&access_token=${q(page.access_token)}`, { fetchImpl });
                    for (const v of body?.data ?? []) if (v?.id && !seen.has(String(v.id))) seen.set(String(v.id), parseVideo(v, page, { reel }));
                } catch (error) {
                    if (error.reauth) throw error;
                    // A Page with no Reels edge (or no video access) still gives the other edge.
                }
            }
            const posts = [...seen.values()].sort((a, b) => (b.postedAt?.getTime() ?? 0) - (a.postedAt?.getTime() ?? 0)).slice(0, perPage);
            // Insights: one call per video, with the Page's token. Very new videos have none yet.
            for (const p of posts) {
                try {
                    const reel = p.mediaType === 'reel';
                    const body = await requestJson(`${GRAPH}/${version(e)}/${p.externalId}/video_insights?metric=${reel ? REEL_METRICS : VIDEO_METRICS}&access_token=${q(page.access_token)}`, { fetchImpl });
                    const s = parseInsights(body, { reel });
                    p.stats.views = s.views;
                    p.stats.reach = s.reach;
                    if (s.shares != null) p.stats.shares = s.shares;
                    if (s.avgWatchSec != null) p.stats.avgWatchSec = s.avgWatchSec;
                    if (s.retention) p.retention = s.retention;
                } catch (error) {
                    if (error.reauth) throw error;
                    if (!insightsWarned) {
                        insightsWarned = true;
                        console.warn(`[accounts] facebook: insights unavailable for a video (${String(error.message).replace(/access_token=[^&\s]+/g, '').slice(0, 160)})`);
                    }
                }
                delete p.pageId;
            }
            out.push(...posts);
        }
        return out.slice(0, maxPosts);
    },
};
