import { env, inSeconds, num, requestJson } from './http.js';

/**
 * YouTube: Google OAuth 2.0 (offline access) + YouTube Data API v3 + YouTube Analytics API v2.
 * Scopes: youtube.readonly (channel, uploads, public counts) and yt-analytics.readonly (average view
 * duration and percentage, and the retention curve). Settings: YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET
 * (an OAuth client of type "Web application" in Google Cloud, with both APIs enabled).
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DATA = 'https://www.googleapis.com/youtube/v3';
const ANALYTICS = 'https://youtubeanalytics.googleapis.com/v2/reports';
export const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.readonly', 'https://www.googleapis.com/auth/yt-analytics.readonly'];
/** Retention curves are one Analytics call per video: only for this many of the newest videos per sync. */
const RETENTION_PER_SYNC = 10;

/** ISO 8601 duration (PT1M5S) -> seconds. */
export const isoDurationSec = (iso) => {
    const m = String(iso ?? '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
    if (!m) return null;
    return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
};

const day = (d) => new Date(d).toISOString().slice(0, 10);

export const youtube = {
    id: 'youtube',
    name: 'YouTube',
    usesPkce: true,
    isConfigured: (e = process.env) => Boolean(env('YOUTUBE_CLIENT_ID', e) && env('YOUTUBE_CLIENT_SECRET', e)),

    authUrl({ state, redirectUri, codeChallenge, env: e = process.env }) {
        const u = new URL(AUTH_URL);
        u.search = new URLSearchParams({
            client_id: env('YOUTUBE_CLIENT_ID', e), redirect_uri: redirectUri, response_type: 'code', scope: YOUTUBE_SCOPES.join(' '),
            access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state, code_challenge: codeChallenge, code_challenge_method: 'S256',
        }).toString();
        return u.toString();
    },

    async exchangeCode({ code, redirectUri, codeVerifier, env: e = process.env, fetchImpl }) {
        const body = await requestJson(TOKEN_URL, {
            method: 'POST', fetchImpl,
            form: { client_id: env('YOUTUBE_CLIENT_ID', e), client_secret: env('YOUTUBE_CLIENT_SECRET', e), code, grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: codeVerifier },
        });
        return { access: body.access_token, refresh: body.refresh_token ?? null, accessExpiresAt: inSeconds(body.expires_in), refreshExpiresAt: null, scopes: String(body.scope ?? '').split(' ').filter(Boolean) };
    },

    async refresh({ refreshToken, env: e = process.env, fetchImpl }) {
        const body = await requestJson(TOKEN_URL, {
            method: 'POST', fetchImpl,
            form: { client_id: env('YOUTUBE_CLIENT_ID', e), client_secret: env('YOUTUBE_CLIENT_SECRET', e), grant_type: 'refresh_token', refresh_token: refreshToken },
        });
        // Google keeps the same refresh token unless it sends a new one.
        return { access: body.access_token, refresh: body.refresh_token ?? refreshToken, accessExpiresAt: inSeconds(body.expires_in), refreshExpiresAt: null, scopes: String(body.scope ?? '').split(' ').filter(Boolean) };
    },

    async profile({ access, fetchImpl }) {
        const body = await requestJson(`${DATA}/channels?part=snippet,statistics,contentDetails&mine=true`, { headers: { Authorization: `Bearer ${access}` }, fetchImpl });
        const c = body?.items?.[0];
        if (!c) throw new Error('This Google account has no YouTube channel');
        return {
            externalId: c.id, handle: c.snippet?.customUrl ?? null, displayName: c.snippet?.title ?? null,
            avatarUrl: c.snippet?.thumbnails?.default?.url ?? null,
            followers: c.statistics?.hiddenSubscriberCount ? null : num(c.statistics?.subscriberCount),
            uploadsPlaylistId: c.contentDetails?.relatedPlaylists?.uploads ?? null,
        };
    },

    async listPosts({ access, account, maxPosts = 60, now = Date.now(), fetchImpl }) {
        const auth = { Authorization: `Bearer ${access}` };
        const playlist = account?.uploadsPlaylistId;
        if (!playlist) return [];
        const ids = [];
        let pageToken;
        for (let page = 0; page < 5 && ids.length < maxPosts; page++) {
            const body = await requestJson(`${DATA}/playlistItems?part=contentDetails&maxResults=50&playlistId=${encodeURIComponent(playlist)}${pageToken ? `&pageToken=${pageToken}` : ''}`, { headers: auth, fetchImpl });
            for (const it of body?.items ?? []) if (it.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
            pageToken = body?.nextPageToken;
            if (!pageToken) break;
        }
        const posts = [];
        for (let i = 0; i < Math.min(ids.length, maxPosts); i += 50) {
            const batch = ids.slice(i, Math.min(i + 50, maxPosts));
            const body = await requestJson(`${DATA}/videos?part=snippet,statistics,contentDetails&id=${batch.join(',')}`, { headers: auth, fetchImpl });
            for (const v of body?.items ?? []) {
                const durationSec = isoDurationSec(v.contentDetails?.duration);
                posts.push({
                    externalId: v.id, url: durationSec != null && durationSec <= 180 ? `https://www.youtube.com/shorts/${v.id}` : `https://www.youtube.com/watch?v=${v.id}`,
                    caption: v.snippet?.title ?? null, postedAt: v.snippet?.publishedAt ? new Date(v.snippet.publishedAt) : null, durationSec,
                    thumbnailUrl: v.snippet?.thumbnails?.medium?.url ?? v.snippet?.thumbnails?.default?.url ?? null,
                    mediaType: durationSec != null && durationSec <= 180 ? 'short' : 'video',
                    stats: { views: num(v.statistics?.viewCount), likes: num(v.statistics?.likeCount), comments: num(v.statistics?.commentCount) },
                });
            }
        }
        // Watch time from YouTube Analytics (connected channels only). A failure here keeps the public counts.
        if (posts.length) {
            try {
                const oldest = posts.reduce((m, p) => (p.postedAt && p.postedAt < m ? p.postedAt : m), new Date(now));
                const q = new URLSearchParams({
                    ids: 'channel==MINE', startDate: day(oldest), endDate: day(now), metrics: 'views,averageViewDuration,averageViewPercentage,shares',
                    dimensions: 'video', filters: `video==${posts.map((p) => p.externalId).join(',')}`, maxResults: '200',
                });
                const body = await requestJson(`${ANALYTICS}?${q}`, { headers: auth, fetchImpl });
                const cols = (body?.columnHeaders ?? []).map((h) => h.name);
                const byId = new Map((body?.rows ?? []).map((r) => [r[cols.indexOf('video')], r]));
                for (const p of posts) {
                    const r = byId.get(p.externalId);
                    if (!r) continue;
                    p.stats.avgWatchSec = num(r[cols.indexOf('averageViewDuration')]);
                    p.stats.avgViewPct = num(r[cols.indexOf('averageViewPercentage')]);
                    p.stats.shares = num(r[cols.indexOf('shares')]);
                }
                for (const p of posts.slice(0, RETENTION_PER_SYNC)) {
                    const rq = new URLSearchParams({
                        ids: 'channel==MINE', startDate: day(p.postedAt ?? oldest), endDate: day(now), metrics: 'audienceWatchRatio',
                        dimensions: 'elapsedVideoTimeRatio', filters: `video==${p.externalId}`,
                    });
                    const rb = await requestJson(`${ANALYTICS}?${rq}`, { headers: auth, fetchImpl }).catch(() => null);
                    const rc = (rb?.columnHeaders ?? []).map((h) => h.name);
                    const curve = (rb?.rows ?? []).map((r) => num(r[rc.indexOf('audienceWatchRatio')])).filter((x) => x != null);
                    if (curve.length) p.retention = curve.map((x) => Math.round(x * 1000) / 10);
                }
            } catch {
                // Analytics scope not granted or not ready yet: public counts only.
            }
        }
        return posts;
    },

    async revoke({ access, fetchImpl }) {
        await requestJson(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(access)}`, { method: 'POST', fetchImpl });
    },
};
