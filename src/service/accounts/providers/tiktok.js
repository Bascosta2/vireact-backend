import { env, inSeconds, num, requestJson } from './http.js';

/**
 * TikTok: Login Kit (OAuth 2.0 with PKCE) + Display API v2.
 * Scopes: user.info.basic, user.info.profile (username), user.info.stats (followers), video.list (the user's
 * own public videos with view, like, comment and share counts). Needs an app approved for these scopes.
 * Settings: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET.
 */

const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const API = 'https://open.tiktokapis.com/v2';
export const TIKTOK_SCOPES = ['user.info.basic', 'user.info.profile', 'user.info.stats', 'video.list'];
const VIDEO_FIELDS = 'id,create_time,title,video_description,duration,cover_image_url,share_url,view_count,like_count,comment_count,share_count';

const tokensFrom = (body, now = Date.now()) => ({
    access: body.access_token,
    refresh: body.refresh_token ?? null,
    accessExpiresAt: inSeconds(body.expires_in, now),
    refreshExpiresAt: inSeconds(body.refresh_expires_in, now),
    scopes: String(body.scope ?? '').split(/[,\s]+/).filter(Boolean),
    externalId: body.open_id ?? null,
});

export const tiktok = {
    id: 'tiktok',
    name: 'TikTok',
    usesPkce: true,
    isConfigured: (e = process.env) => Boolean(env('TIKTOK_CLIENT_KEY', e) && env('TIKTOK_CLIENT_SECRET', e)),

    authUrl({ state, redirectUri, codeChallenge, env: e = process.env }) {
        const u = new URL(AUTH_URL);
        u.search = new URLSearchParams({
            client_key: env('TIKTOK_CLIENT_KEY', e), scope: TIKTOK_SCOPES.join(','), response_type: 'code',
            redirect_uri: redirectUri, state, code_challenge: codeChallenge, code_challenge_method: 'S256',
        }).toString();
        return u.toString();
    },

    async exchangeCode({ code, redirectUri, codeVerifier, env: e = process.env, fetchImpl }) {
        const body = await requestJson(`${API}/oauth/token/`, {
            method: 'POST', fetchImpl,
            form: { client_key: env('TIKTOK_CLIENT_KEY', e), client_secret: env('TIKTOK_CLIENT_SECRET', e), code, grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: codeVerifier },
        });
        if (!body?.access_token) throw new Error(`TikTok sign-in failed: ${body?.error_description || body?.error || 'no token'}`);
        return tokensFrom(body);
    },

    async refresh({ refreshToken, env: e = process.env, fetchImpl }) {
        const body = await requestJson(`${API}/oauth/token/`, {
            method: 'POST', fetchImpl,
            form: { client_key: env('TIKTOK_CLIENT_KEY', e), client_secret: env('TIKTOK_CLIENT_SECRET', e), grant_type: 'refresh_token', refresh_token: refreshToken },
        });
        if (!body?.access_token) throw new Error('TikTok refresh returned no token');
        return tokensFrom(body);
    },

    async profile({ access, fetchImpl }) {
        const body = await requestJson(`${API}/user/info/?fields=open_id,display_name,avatar_url,username,follower_count`, { headers: { Authorization: `Bearer ${access}` }, fetchImpl });
        const u = body?.data?.user ?? {};
        return { externalId: u.open_id, handle: u.username ?? null, displayName: u.display_name ?? null, avatarUrl: u.avatar_url ?? null, followers: num(u.follower_count) };
    },

    /** Newest first, up to `maxPosts` (20 per page). */
    async listPosts({ access, maxPosts = 60, fetchImpl }) {
        const posts = [];
        let cursor;
        for (let page = 0; page < 10 && posts.length < maxPosts; page++) {
            const body = await requestJson(`${API}/video/list/?fields=${VIDEO_FIELDS}`, {
                method: 'POST', headers: { Authorization: `Bearer ${access}` }, json: { max_count: 20, ...(cursor ? { cursor } : {}) }, fetchImpl,
            });
            for (const v of body?.data?.videos ?? []) {
                posts.push({
                    externalId: String(v.id), url: v.share_url ?? null, caption: v.video_description || v.title || null,
                    postedAt: num(v.create_time) ? new Date(num(v.create_time) * 1000) : null, durationSec: num(v.duration),
                    thumbnailUrl: v.cover_image_url ?? null, mediaType: 'video',
                    stats: { views: num(v.view_count), likes: num(v.like_count), comments: num(v.comment_count), shares: num(v.share_count) },
                });
            }
            if (!body?.data?.has_more || !body?.data?.cursor) break;
            cursor = body.data.cursor;
        }
        return posts.slice(0, maxPosts);
    },

    async revoke({ access, env: e = process.env, fetchImpl }) {
        await requestJson(`${API}/oauth/revoke/`, { method: 'POST', fetchImpl, form: { client_key: env('TIKTOK_CLIENT_KEY', e), client_secret: env('TIKTOK_CLIENT_SECRET', e), token: access } });
    },
};
