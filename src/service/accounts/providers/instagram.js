import { env, inSeconds, num, requestJson } from './http.js';

/**
 * Instagram: the Instagram API with Instagram Login (professional accounts: Business or Creator).
 * Scopes: instagram_business_basic (profile, media) and instagram_business_manage_insights (Reels views,
 * reach, saves, shares, average watch time). The short-lived token is exchanged for a 60-day token,
 * refreshed before it expires. Settings: INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET (the Instagram app id and
 * secret from App Dashboard > Instagram > API setup with Instagram login), INSTAGRAM_GRAPH_VERSION.
 */

const AUTH_URL = 'https://www.instagram.com/oauth/authorize';
const TOKEN_URL = 'https://api.instagram.com/oauth/access_token';
const GRAPH = 'https://graph.instagram.com';
export const INSTAGRAM_SCOPES = ['instagram_business_basic', 'instagram_business_manage_insights'];
const version = (e) => env('INSTAGRAM_GRAPH_VERSION', e) || 'v25.0';
const REEL_METRICS = 'views,reach,saved,shares,ig_reels_avg_watch_time';
const POST_METRICS = 'views,reach,saved,shares';

export const instagram = {
    id: 'instagram',
    name: 'Instagram',
    usesPkce: false,
    isConfigured: (e = process.env) => Boolean(env('INSTAGRAM_APP_ID', e) && env('INSTAGRAM_APP_SECRET', e)),

    authUrl({ state, redirectUri, env: e = process.env }) {
        const u = new URL(AUTH_URL);
        u.search = new URLSearchParams({
            client_id: env('INSTAGRAM_APP_ID', e), redirect_uri: redirectUri, response_type: 'code', scope: INSTAGRAM_SCOPES.join(','), state,
        }).toString();
        return u.toString();
    },

    async exchangeCode({ code, redirectUri, env: e = process.env, fetchImpl }) {
        const short = await requestJson(TOKEN_URL, {
            method: 'POST', fetchImpl,
            form: { client_id: env('INSTAGRAM_APP_ID', e), client_secret: env('INSTAGRAM_APP_SECRET', e), grant_type: 'authorization_code', redirect_uri: redirectUri, code },
        });
        const shortToken = short?.access_token ?? short?.data?.[0]?.access_token;
        if (!shortToken) throw new Error('Instagram sign-in returned no token');
        const long = await requestJson(`${GRAPH}/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(env('INSTAGRAM_APP_SECRET', e))}&access_token=${encodeURIComponent(shortToken)}`, { fetchImpl });
        const scopes = String(short?.permissions ?? short?.data?.[0]?.permissions ?? '').split(/[,\s]+/).filter(Boolean);
        // The long-lived token is its own refresh credential (ig_refresh_token).
        // user_id here is the Instagram app-scoped id, the one Meta's deauthorize / data-deletion callbacks carry.
        const scopedId = short?.user_id ?? short?.data?.[0]?.user_id;
        return { access: long.access_token, refresh: null, accessExpiresAt: inSeconds(long.expires_in), refreshExpiresAt: null, scopes, scopedUserId: scopedId != null ? String(scopedId) : null };
    },

    /** Instagram refreshes the long-lived token itself (it must be at least 24 hours old and not expired). */
    async refresh({ access, fetchImpl }) {
        const body = await requestJson(`${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(access)}`, { fetchImpl });
        return { access: body.access_token, refresh: null, accessExpiresAt: inSeconds(body.expires_in), refreshExpiresAt: null };
    },
    refreshesWithAccessToken: true,

    async profile({ access, env: e = process.env, fetchImpl }) {
        const body = await requestJson(`${GRAPH}/${version(e)}/me?fields=id,user_id,username,name,profile_picture_url,followers_count&access_token=${encodeURIComponent(access)}`, { fetchImpl });
        // externalId: the professional account id (used for media calls). id: the app-scoped id (Meta callbacks).
        return {
            externalId: String(body.user_id ?? body.id), handle: body.username ?? null, displayName: body.name ?? null, avatarUrl: body.profile_picture_url ?? null,
            followers: num(body.followers_count), scopedUserId: body.id != null ? String(body.id) : null,
        };
    },

    async listPosts({ access, maxPosts = 60, env: e = process.env, fetchImpl }) {
        const posts = [];
        let next = `${GRAPH}/${version(e)}/me/media?fields=id,caption,media_type,media_product_type,permalink,timestamp,thumbnail_url,media_url,like_count,comments_count&limit=50&access_token=${encodeURIComponent(access)}`;
        for (let page = 0; page < 5 && next && posts.length < maxPosts; page++) {
            const body = await requestJson(next, { fetchImpl });
            for (const m of body?.data ?? []) {
                const reel = m.media_product_type === 'REELS';
                posts.push({
                    externalId: String(m.id), url: m.permalink ?? null, caption: m.caption ?? null, postedAt: m.timestamp ? new Date(m.timestamp) : null,
                    durationSec: null, thumbnailUrl: m.thumbnail_url ?? (m.media_type === 'IMAGE' ? m.media_url : null) ?? null,
                    mediaType: reel ? 'reel' : String(m.media_type ?? '').toLowerCase() || null,
                    stats: { likes: num(m.like_count), comments: num(m.comments_count) },
                });
            }
            next = body?.paging?.next ?? null;
        }
        const out = posts.slice(0, maxPosts);
        // Insights: one call per post. Posts too new, or made before the account was professional, have none.
        for (const p of out) {
            try {
                const metrics = p.mediaType === 'reel' ? REEL_METRICS : POST_METRICS;
                const body = await requestJson(`${GRAPH}/${version(e)}/${p.externalId}/insights?metric=${metrics}&access_token=${encodeURIComponent(access)}`, { fetchImpl });
                const value = (name) => num((body?.data ?? []).find((d) => d.name === name)?.values?.[0]?.value);
                p.stats.views = value('views');
                p.stats.reach = value('reach');
                p.stats.saves = value('saved');
                p.stats.shares = value('shares');
                const watchMs = value('ig_reels_avg_watch_time');
                if (watchMs != null) p.stats.avgWatchSec = Math.round(watchMs / 100) / 10;
            } catch (error) {
                if (error.reauth) throw error;
            }
        }
        return out;
    },
};
