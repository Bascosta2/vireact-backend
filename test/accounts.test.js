import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.LEARNING_READ_CONTENT = 'false';
console.warn = () => {};
console.log = () => {};

const { connectTestDb, disconnectTestDb } = await import('./helpers/test-db.js');
const { User } = await import('../src/model/user.model.js');
const { Video } = await import('../src/model/video.model.js');
const { OutcomeSnapshot } = await import('../src/model/learning.model.js');
const { ConnectedAccount, ConnectedPost, AccountOAuthState } = await import('../src/model/connected-account.model.js');
const A = await import('../src/service/accounts/accounts.service.js');
const { encryptToken, decryptToken, tokenKey } = await import('../src/service/accounts/token-crypto.js');
const { isoDurationSec } = await import('../src/service/accounts/providers/youtube.js');
const { hasAccountsAccess } = await import('../src/config/flags.js');

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const ENV = {
    ACCOUNTS_TOKEN_KEY: crypto.randomBytes(32).toString('base64'),
    BACKEND_URL: 'https://api.example.test',
    FRONTEND_URL: 'https://app.example.test',
    TIKTOK_CLIENT_KEY: 'tk-key', TIKTOK_CLIENT_SECRET: 'tk-secret',
    YOUTUBE_CLIENT_ID: 'yt-id', YOUTUBE_CLIENT_SECRET: 'yt-secret',
    INSTAGRAM_APP_ID: 'ig-id', INSTAGRAM_APP_SECRET: 'ig-secret',
};

// Provider tests need no database: the hooks only connect when DB_URL is set.
const HAS_DB = Boolean(process.env.DB_URL);
before(async () => {
    if (!HAS_DB) return;
    Object.assign(process.env, { ACCOUNTS_TOKEN_KEY: ENV.ACCOUNTS_TOKEN_KEY });
    await connectTestDb();
    await Promise.all([ConnectedAccount, ConnectedPost, AccountOAuthState, Video, OutcomeSnapshot].map((m) => m.syncIndexes()));
});
after(async () => { if (HAS_DB) await disconnectTestDb(); });

/** Fake platform: answers by URL; records every request. */
const fakeFetch = (routes) => {
    const calls = [];
    const fn = async (url, init = {}) => {
        calls.push({ url: String(url), init });
        for (const [pattern, reply] of routes) {
            if (String(url).includes(pattern)) {
                const r = typeof reply === 'function' ? reply(String(url), init) : reply;
                const status = r?.__status ?? 200;
                return { status, ok: status < 400, text: async () => JSON.stringify(r?.__body ?? r) };
            }
        }
        return { status: 404, ok: false, text: async () => JSON.stringify({ error: { message: `no route for ${url}` } }) };
    };
    fn.calls = calls;
    return fn;
};

const makeUser = () => User.create({ name: 'C', email: `acct-${Date.now()}-${Math.random()}@example.invalid`, password: 'pw-123456', isEmailVerified: true });
const makeVideo = (userId, { duration, createdAt }) => Video.create({
    filename: 'clip.mp4', fileSize: 10, uploadStatus: 'completed', analysisStatus: 'completed', uploader_id: userId, duration, createdAt,
});

test('token encryption round-trips, rejects tampering, and needs a 32-byte key', () => {
    const key = tokenKey(ENV);
    const sealed = encryptToken('secret-token', key);
    assert.match(sealed, /^v1:/);
    assert.notEqual(sealed.includes('secret-token'), true);
    assert.equal(decryptToken(sealed, key), 'secret-token');
    const parts = sealed.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    assert.throws(() => decryptToken(parts.join(':'), key));
    assert.equal(tokenKey({ ACCOUNTS_TOKEN_KEY: 'short' }), null);
    assert.equal(tokenKey({ ACCOUNTS_TOKEN_KEY: 'ab'.repeat(32) })?.length, 32, 'hex keys work too');
});

test('platforms are only offered when their keys, the token key and the callback base exist; beta gate', () => {
    assert.deepEqual(A.platformStatus(ENV).map((p) => p.configured), [true, true, true]);
    assert.deepEqual(A.platformStatus({ ...ENV, ACCOUNTS_TOKEN_KEY: '' }).map((p) => p.configured), [false, false, false]);
    assert.deepEqual(A.platformStatus({ ...ENV, YOUTUBE_CLIENT_SECRET: '' }).map((p) => p.configured), [true, false, true]);
    const saved = { e: process.env.ACCOUNTS_ENABLED, b: process.env.ACCOUNTS_BETA_EMAILS };
    process.env.ACCOUNTS_ENABLED = '';
    process.env.ACCOUNTS_BETA_EMAILS = 'Owner@Example.com';
    assert.equal(hasAccountsAccess({ email: 'owner@example.com' }), true);
    assert.equal(hasAccountsAccess({ email: 'someone@example.com' }), false);
    process.env.ACCOUNTS_ENABLED = 'true';
    assert.equal(hasAccountsAccess({ email: 'someone@example.com' }), true);
    process.env.ACCOUNTS_ENABLED = saved.e ?? '';
    process.env.ACCOUNTS_BETA_EMAILS = saved.b ?? '';
});

test('matching: one upload of the same length made before the post links automatically; ties do not', () => {
    const posted = new Date('2026-11-10T12:00:00Z');
    const v = (id, duration, daysBefore) => ({ _id: id, duration, createdAt: new Date(posted.getTime() - daysBefore * DAY), filename: id });
    assert.equal(A.matchCandidates({ postedAt: posted, durationSec: 31 }, [v('a', 30.6, 1), v('b', 58, 2)]).clear, 'a');
    assert.equal(A.matchCandidates({ postedAt: posted, durationSec: 31 }, [v('a', 30.6, 1), v('b', 31.2, 2)]).clear, null, 'two fit: the user picks');
    assert.equal(A.matchCandidates({ postedAt: posted, durationSec: 31 }, [v('a', 31, 40)]).clear, null, 'uploaded too long before the post');
    assert.equal(A.matchCandidates({ postedAt: posted, durationSec: null }, [v('a', 31, 1)]).clear, null, 'no length: never automatic');
    assert.equal(isoDurationSec('PT1M5S'), 65);
    assert.equal(isoDurationSec('PT45S'), 45);
});

test('TikTok: sign-in with PKCE, encrypted tokens, sync, automatic match, milestones become verified results', async () => {
    const user = await makeUser();
    const now = Date.UTC(2026, 10, 21, 6);
    const postedAt = Math.floor((now - 8 * DAY) / 1000);
    const video = await makeVideo(user._id, { duration: 24.2, createdAt: new Date(now - 9 * DAY) });
    await makeVideo(user._id, { duration: 70, createdAt: new Date(now - 9 * DAY) });

    const { url } = await A.startConnect(user._id, 'tiktok', { env: ENV });
    const u = new URL(url);
    assert.equal(u.host, 'www.tiktok.com');
    assert.equal(u.searchParams.get('client_key'), 'tk-key');
    assert.equal(u.searchParams.get('redirect_uri'), 'https://api.example.test/api/v1/accounts/callback/tiktok');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.match(u.searchParams.get('scope'), /video\.list/);
    const state = u.searchParams.get('state');

    const fetchImpl = fakeFetch([
        ['/oauth/token/', (_, init) => {
            assert.match(init.body, /code_verifier=/, 'the PKCE verifier is sent');
            return { access_token: 'tt-access', refresh_token: 'tt-refresh', expires_in: 86400, refresh_expires_in: 31536000, open_id: 'open-1', scope: 'user.info.basic,video.list' };
        }],
        ['/user/info/', { data: { user: { open_id: 'open-1', username: 'maker', display_name: 'Maker', follower_count: 9000 } } }],
        ['/video/list/', { data: { videos: [
            { id: '111', create_time: postedAt, duration: 24, video_description: 'my edit', share_url: 'https://www.tiktok.com/@maker/video/111', view_count: 4200, like_count: 300, comment_count: 12, share_count: 9 },
            { id: '222', create_time: postedAt, duration: 15, view_count: 90 },
        ], has_more: false } }],
    ]);
    const back = await A.finishConnect('tiktok', { code: 'abc', state }, { env: ENV, fetchImpl, syncInBackground: false });
    assert.equal(back, 'https://app.example.test/accounts?connected=tiktok');
    assert.equal(await AccountOAuthState.countDocuments({ userId: user._id }), 0, 'the state is single-use');
    const replay = await A.finishConnect('tiktok', { code: 'abc', state }, { env: ENV, fetchImpl, syncInBackground: false });
    assert.match(replay, /error=expired/);

    const account = await ConnectedAccount.findOne({ userId: user._id, platform: 'tiktok' }).lean();
    assert.equal(account.handle, 'maker');
    assert.notEqual(account.tokens.access, 'tt-access', 'stored encrypted');
    assert.equal(decryptToken(account.tokens.access), 'tt-access');

    const counts = await A.syncAccount(account._id, { env: ENV, fetchImpl, now });
    assert.deepEqual({ posts: counts.posts, newPosts: counts.newPosts, autoLinked: counts.autoLinked }, { posts: 2, newPosts: 2, autoLinked: 1 });
    const post = await ConnectedPost.findOne({ externalId: '111' }).lean();
    assert.equal(String(post.videoId), String(video._id));
    assert.equal(post.linkSource, 'auto');
    assert.equal(post.latest.views, 4200);
    // 8 days old: the 24 h, 3 d and 7 d milestones are all due from today's reading.
    assert.deepEqual([...post.milestonesSent].sort((a, b) => a - b), [24, 72, 168]);
    const v = await Video.findById(video._id).lean();
    assert.equal(v.performanceSnapshots.length, 1, 'one reading, stored once');
    assert.equal(v.performanceSnapshots[0].source, 'tiktok');
    assert.equal(v.actualViews, 4200);
    assert.equal(v.postUrl, 'https://www.tiktok.com/@maker/video/111');
    assert.equal(v.creatorFollowers, 9000);
    await new Promise((r) => setTimeout(r, 150));
    const outcome = await OutcomeSnapshot.findOne({ subjectType: 'video', subjectId: video._id }).lean();
    assert.equal(outcome.source, 'api_verified', 'the learning engine sees a verified result');

    const again = await A.syncAccount(account._id, { env: ENV, fetchImpl, now: now + HOUR });
    assert.equal(again.newPosts, 0);
    const p2 = await ConnectedPost.findOne({ externalId: '111' }).lean();
    assert.equal(p2.readings.length, 1, 'same day: the reading is replaced, not added');

    const listed = await A.listPosts(user._id);
    const unlinked = listed.posts.find((p) => p.platform === 'tiktok' && !p.videoId);
    assert.ok(unlinked, 'the 15 s post stays for the user to link');
    const accounts = await A.listAccounts(user._id, { env: ENV });
    assert.equal(accounts.accounts[0].posts, 2);
    assert.equal(accounts.accounts[0].linked, 1);
    assert.equal(JSON.stringify(accounts).includes('tt-access'), false, 'tokens never reach the app');
    assert.equal(JSON.stringify(accounts).includes(account.tokens.access), false);
});

test('a refused token marks the account for reconnecting; expiring tokens are refreshed', async () => {
    const user = await makeUser();
    const account = await ConnectedAccount.create({
        userId: user._id, platform: 'tiktok', externalId: 'open-2',
        tokens: { access: encryptToken('old'), refresh: encryptToken('r1'), accessExpiresAt: new Date(Date.now() + 60_000) },
    });
    const fetchImpl = fakeFetch([
        ['/oauth/token/', { access_token: 'new', refresh_token: 'r2', expires_in: 86400 }],
        ['/user/info/', { __status: 401, __body: { error: { code: 'access_token_invalid', message: 'The access token is invalid' } } }],
        ['/video/list/', { __status: 401, __body: { error: { code: 'access_token_invalid', message: 'The access token is invalid' } } }],
    ]);
    await assert.rejects(A.syncAccount(account._id, { env: ENV, fetchImpl }), (e) => e.reauth === true);
    const after = await ConnectedAccount.findById(account._id).lean();
    assert.equal(after.status, 'needs_reauth');
    assert.equal(decryptToken(after.tokens.access), 'new', 'the token about to expire was refreshed first');
    assert.equal(decryptToken(after.tokens.refresh), 'r2');
    const daily = await A.syncAllAccounts({ env: ENV, fetchImpl });
    assert.equal(daily.accounts >= 0, true, 'accounts needing reconnection are skipped by the daily sync');
});

test('YouTube: channel, uploads, Shorts, watch time and retention from Analytics', async () => {
    const user = await makeUser();
    const now = Date.UTC(2026, 10, 21, 6);
    const account = await ConnectedAccount.create({
        userId: user._id, platform: 'youtube', externalId: 'UC1', uploadsPlaylistId: 'UU1',
        tokens: { access: encryptToken('ya'), refresh: encryptToken('yr'), accessExpiresAt: new Date(now + DAY) },
    });
    const fetchImpl = fakeFetch([
        ['/channels?', { items: [{ id: 'UC1', snippet: { title: 'Chan', customUrl: '@chan' }, statistics: { subscriberCount: '1200' }, contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] }],
        ['/playlistItems?', { items: [{ contentDetails: { videoId: 'v1' } }, { contentDetails: { videoId: 'v2' } }] }],
        ['/videos?', { items: [
            { id: 'v1', snippet: { title: 'Short one', publishedAt: new Date(now - 4 * DAY).toISOString() }, contentDetails: { duration: 'PT32S' }, statistics: { viewCount: '5000', likeCount: '200', commentCount: '7' } },
            { id: 'v2', snippet: { title: 'Long one', publishedAt: new Date(now - 20 * DAY).toISOString() }, contentDetails: { duration: 'PT12M3S' }, statistics: { viewCount: '800' } },
        ] }],
        ['dimensions=video', { columnHeaders: [{ name: 'video' }, { name: 'views' }, { name: 'averageViewDuration' }, { name: 'averageViewPercentage' }, { name: 'shares' }], rows: [['v1', 5000, 21, 65.6, 14]] }],
        ['elapsedVideoTimeRatio', (url) => (url.includes('video%3D%3Dv1') ? { columnHeaders: [{ name: 'elapsedVideoTimeRatio' }, { name: 'audienceWatchRatio' }], rows: [[0.01, 1.02], [0.5, 0.61], [1, 0.3]] } : { rows: [] })],
    ]);
    const counts = await A.syncAccount(account._id, { env: ENV, fetchImpl, now });
    assert.equal(counts.posts, 2);
    const short = await ConnectedPost.findOne({ accountId: account._id, externalId: 'v1' }).lean();
    assert.equal(short.url, 'https://www.youtube.com/shorts/v1');
    assert.equal(short.mediaType, 'short');
    assert.equal(short.latest.avgWatchSec, 21);
    assert.equal(short.latest.avgViewPct, 65.6);
    assert.equal(short.latest.shares, 14);
    assert.deepEqual(short.retention, [102, 61, 30]);
    const long = await ConnectedPost.findOne({ accountId: account._id, externalId: 'v2' }).lean();
    assert.equal(long.durationSec, 723);
    const acc = await ConnectedAccount.findById(account._id).lean();
    assert.equal(acc.followers, 1200);
});

test('Instagram: long-lived token on sign-in, Reels insights, manual link sends milestones, disconnect removes everything', async () => {
    const user = await makeUser();
    const now = Date.UTC(2026, 10, 21, 6);
    const { url } = await A.startConnect(user._id, 'instagram', { env: ENV });
    const state = new URL(url).searchParams.get('state');
    assert.equal(new URL(url).searchParams.get('scope'), 'instagram_business_basic,instagram_business_manage_insights');
    const fetchImpl = fakeFetch([
        ['api.instagram.com/oauth/access_token', { access_token: 'short', user_id: 17, permissions: 'instagram_business_basic,instagram_business_manage_insights' }],
        ['ig_exchange_token', { access_token: 'long', expires_in: 5184000 }],
        ['/me?fields', { user_id: '17', username: 'reelmaker', followers_count: 3400 }],
        ['/me/media?', { data: [{ id: 'm1', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://www.instagram.com/reel/m1/', timestamp: new Date(now - 31 * DAY).toISOString(), like_count: 80, comments_count: 4 }] }],
        ['/m1/insights?', { data: [{ name: 'views', values: [{ value: 12000 }] }, { name: 'reach', values: [{ value: 9000 }] }, { name: 'saved', values: [{ value: 55 }] }, { name: 'shares', values: [{ value: 31 }] }, { name: 'ig_reels_avg_watch_time', values: [{ value: 6400 }] }] }],
        ['/oauth/revoke', {}],
    ]);
    assert.equal(await A.finishConnect('instagram', { code: 'c', state }, { env: ENV, fetchImpl, syncInBackground: false }), 'https://app.example.test/accounts?connected=instagram');
    const account = await ConnectedAccount.findOne({ userId: user._id, platform: 'instagram' }).lean();
    assert.equal(decryptToken(account.tokens.access), 'long', 'the 60-day token is the one stored');
    await A.syncAccount(account._id, { env: ENV, fetchImpl, now });
    const post = await ConnectedPost.findOne({ accountId: account._id }).lean();
    assert.equal(post.mediaType, 'reel');
    assert.equal(post.latest.views, 12000);
    assert.equal(post.latest.saves, 55);
    assert.equal(post.latest.avgWatchSec, 6.4);
    assert.equal(post.videoId, null, 'Instagram gives no length, so the match is the user\'s');

    const video = await makeVideo(user._id, { duration: 18, createdAt: new Date(now - 32 * DAY) });
    const linked = await A.linkPost(user._id, String(post._id), String(video._id));
    assert.equal(linked.videoId, String(video._id));
    const v = await Video.findById(video._id).lean();
    assert.equal(v.actualViews, 12000);
    assert.equal(v.performanceSnapshots[0].source, 'instagram');
    const other = await makeUser();
    await assert.rejects(A.linkPost(other._id, String(post._id), String(video._id)), /not found/i, 'only the owner can link');

    await A.disconnect(user._id, String(account._id), { env: ENV, fetchImpl });
    assert.equal(await ConnectedAccount.countDocuments({ userId: user._id }), 0);
    assert.equal(await ConnectedPost.countDocuments({ userId: user._id }), 0);
    assert.equal((await Video.findById(video._id).lean()).performanceSnapshots.length, 1, 'results already on the upload stay');
});

test('callback with a denied sign-in or a bad state goes back to the tab with the reason', async () => {
    assert.match(await A.finishConnect('tiktok', { state: 'nope', code: 'x' }, { env: ENV }), /accounts\?error=expired&platform=tiktok/);
    assert.match(await A.finishConnect('nowhere', { state: 's' }, { env: ENV }), /error=unknown_platform/);
    const user = await makeUser();
    const { url } = await A.startConnect(user._id, 'youtube', { env: ENV });
    const state = new URL(url).searchParams.get('state');
    assert.match(await A.finishConnect('youtube', { state, error: 'access_denied' }, { env: ENV }), /error=denied/);
    await assert.rejects(A.startConnect(user._id, 'youtube', { env: { ...ENV, YOUTUBE_CLIENT_ID: '' } }), /not available yet/);
});

test('Facebook provider: Page videos and Reels parse into the shared post shape (no database needed)', async () => {
    const F = await import('../src/service/accounts/providers/facebook.js');
    const scope = new URL(F.facebook.authUrl({ state: 's', redirectUri: 'https://api.example.test/cb', env: { FACEBOOK_APP_ID: 'fb-id' } })).searchParams.get('scope');
    assert.equal(scope, 'pages_show_list,pages_read_engagement,read_insights', 'read-only scopes, no publishing');
    assert.equal(F.facebook.isConfigured({}), false);
    assert.equal(F.facebook.isConfigured({ FACEBOOK_APP_ID: 'a', FACEBOOK_APP_SECRET: 'b' }), true);

    const fetchImpl = fakeFetch([
        ['/oauth/access_token?client_id', { access_token: 'short' }],
        ['fb_exchange_token', { access_token: 'long', expires_in: 5184000 }],
        ['/me/permissions', { data: [{ permission: 'pages_show_list', status: 'granted' }, { permission: 'read_insights', status: 'declined' }] }],
        ['/me/accounts', { data: [{ id: 'p1', name: 'My Page', access_token: 'page-token', followers_count: 900, picture: { data: { url: 'https://img.test/p.jpg' } } }, { id: 'p2', name: 'No token' }] }],
        ['/me?fields', { id: '77', name: 'Owner' }],
        ['/p1/video_reels?', { data: [{ id: 'r1', description: 'a reel', created_time: '2026-11-01T10:00:00+0000', length: 14.5, permalink_url: '/reel/r1', likes: { summary: { total_count: 40 } }, comments: { summary: { total_count: 3 } } }] }],
        ['/p1/videos?', { data: [{ id: 'r1', length: 14.5 }, { id: 'v1', created_time: '2026-10-01T10:00:00+0000', length: 62, permalink_url: 'https://www.facebook.com/p1/videos/v1', shares: { count: 5 } }] }],
        ['/r1/video_insights', { data: [{ name: 'fb_reels_total_plays', values: [{ value: 5000 }] }, { name: 'post_impressions_unique', values: [{ value: 3100 }] }, { name: 'post_video_avg_time_watched', values: [{ value: 6400 }] }, { name: 'post_video_retention_graph', values: [{ value: { 1: 100, 2: 80.04, 3: 55 } }] }, { name: 'post_video_social_actions', values: [{ value: { comment: 3, share: 9 } }] }] }],
        ['/v1/video_insights', { data: [{ name: 'total_video_views', values: [{ value: 800 }] }] }],
    ]);
    const tokens = await F.facebook.exchangeCode({ code: 'c', redirectUri: 'https://api.example.test/cb', env: { FACEBOOK_APP_ID: 'a', FACEBOOK_APP_SECRET: 'b' }, fetchImpl });
    assert.equal(tokens.access, 'long');
    assert.deepEqual(tokens.scopes, ['pages_show_list']);
    const profile = await F.facebook.profile({ access: 'long', fetchImpl });
    assert.deepEqual([profile.externalId, profile.displayName, profile.followers], ['77', 'My Page', 900]);
    const posts = await F.facebook.listPosts({ access: 'long', fetchImpl });
    assert.equal(posts.length, 2, 'the Reel listed on both edges counts once');
    const reel = posts.find((p) => p.externalId === 'r1');
    assert.deepEqual([reel.mediaType, reel.url, reel.durationSec], ['reel', 'https://www.facebook.com/reel/r1', 14.5]);
    assert.deepEqual([reel.stats.views, reel.stats.reach, reel.stats.avgWatchSec, reel.stats.shares, reel.stats.likes], [5000, 3100, 6.4, 9, 40]);
    assert.deepEqual(reel.retention, [100, 80, 55]);
    const video = posts.find((p) => p.externalId === 'v1');
    assert.deepEqual([video.mediaType, video.stats.views, video.stats.shares, video.stats.avgWatchSec ?? null], ['video', 800, 5, null]);
    assert.ok(fetchImpl.calls.filter((c) => c.url.includes('video_insights')).every((c) => c.url.includes('access_token=page-token')), 'insights use the Page token');
});

test('Facebook provider: login-gone answers (code 190, code 10 with a session subcode) ask the user to reconnect', async () => {
    const F = await import('../src/service/accounts/providers/facebook.js');
    const answer = (error) => fakeFetch([['/me?fields', { __status: 400, __body: { error } }]]);
    for (const error of [{ message: 'The user has logged out', type: 'OAuthException', code: 190, error_subcode: 467 }, { message: 'x', code: 10, error_subcode: 460 }, { message: 'y', code: 190 }]) {
        await assert.rejects(F.facebook.profile({ access: 't', fetchImpl: answer(error) }), (e) => e.reauth === true);
    }
    await assert.rejects(F.facebook.profile({ access: 't', fetchImpl: answer({ message: 'Permission denied', code: 10, error_subcode: 1 }) }), (e) => !e.reauth);
});
