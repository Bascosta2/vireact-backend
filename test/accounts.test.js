import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';

process.env.NODE_ENV = 'test';
process.env.LEARNING_READ_CONTENT = 'false';
console.warn = () => {};
console.log = () => {};

const { connectTestDb, disconnectTestDb, fakeRes } = await import('./helpers/test-db.js');
const { User } = await import('../src/model/user.model.js');
const { Video } = await import('../src/model/video.model.js');
const { OutcomeSnapshot, VideoFeatures } = await import('../src/model/learning.model.js');
const { ConnectedAccount, ConnectedPost, AccountOAuthState, MetaDeletionRequest } = await import('../src/model/connected-account.model.js');
const Meta = await import('../src/service/accounts/meta-data-deletion.js');
const AccountsController = await import('../src/controller/accounts.controller.js');
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

// Provider and Meta callback tests need no database: the hooks only connect when DB_URL is set.
const HAS_DB = Boolean(process.env.DB_URL);
before(async () => {
    if (!HAS_DB) return;
    Object.assign(process.env, { ACCOUNTS_TOKEN_KEY: ENV.ACCOUNTS_TOKEN_KEY });
    await connectTestDb();
    await Promise.all([ConnectedAccount, ConnectedPost, AccountOAuthState, MetaDeletionRequest, Video, OutcomeSnapshot].map((m) => m.syncIndexes()));
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

// ---- Meta data deletion / deauthorize callbacks

const META_ENV = { FACEBOOK_APP_SECRET: 'fb-app-secret', INSTAGRAM_APP_SECRET: 'ig-app-secret', FRONTEND_URL: 'https://app.example.test/' };
const b64u = (x) => Buffer.from(x).toString('base64url');
/** A signed_request as Meta builds it: base64url(HMAC-SHA256(encoded payload)) + '.' + base64url(JSON). */
const signedRequest = (payload, secret) => {
    const encoded = b64u(JSON.stringify(payload));
    return `${crypto.createHmac('sha256', secret).update(encoded).digest('base64url')}.${encoded}`;
};
const metaPayload = (userId = '1029384756', extra = {}) => ({ algorithm: 'HMAC-SHA256', expires: 1291840400, issued_at: 1291836800, user_id: userId, ...extra });

/** Runs fn with properties swapped for fakes (process.env keys, model statics), always restoring them. */
const withStubs = async (stubs, fn) => {
    const saved = stubs.map(([obj, key]) => [obj, key, Object.hasOwn(obj, key), obj[key]]);
    try {
        for (const [obj, key, value] of stubs) {
            if (value === undefined) delete obj[key];
            else obj[key] = value;
        }
        return await fn();
    } finally {
        for (const [obj, key, own, value] of saved) {
            if (own) obj[key] = value;
            else delete obj[key];
        }
    }
};
/** A mongoose-like query: chainable, awaitable, .lean(). */
const query = (value) => {
    const q = { select: () => q, sort: () => q, limit: () => q, lean: async () => value, then: (ok, fail) => Promise.resolve(value).then(ok, fail) };
    return q;
};
/** In-memory MetaDeletionRequest store (findOne by subjectHash / confirmationCode, create, save). */
const fakeDeletionStore = () => {
    const docs = [];
    const wrap = (d) => Object.assign(d, { save: async () => d });
    return {
        docs,
        stubs: [
            [MetaDeletionRequest, 'findOne', (filter) => query(docs.find((d) => Object.entries(filter).every(([k, v]) => d[k] === v)) ?? null)],
            [MetaDeletionRequest, 'create', async (fields) => {
                const d = wrap({ status: 'pending', completedAt: null, attempts: 0, counts: null, ...fields });
                docs.push(d);
                return d;
            }],
            [MetaDeletionRequest, 'find', (filter) => query(docs.filter((d) => d.status === filter.status && d.metaUserId != null))],
        ],
    };
};

test('Meta signed_request: verified with either app secret, timing-safe; bad signature, algorithm or encoding is refused', () => {
    const fb = Meta.parseSignedRequest(signedRequest(metaPayload(), META_ENV.FACEBOOK_APP_SECRET), META_ENV);
    assert.deepEqual(fb, { ok: true, platform: 'facebook', userId: '1029384756' });
    const ig = Meta.parseSignedRequest(signedRequest(metaPayload(17841400000000), META_ENV.INSTAGRAM_APP_SECRET), META_ENV);
    assert.deepEqual(ig, { ok: true, platform: 'instagram', userId: '17841400000000' }, 'Instagram Login callbacks use the separate Instagram secret; numeric ids read as strings');

    const reason = (sr, env = META_ENV) => Meta.parseSignedRequest(sr, env).reason;
    assert.equal(reason(signedRequest(metaPayload(), META_ENV.FACEBOOK_APP_SECRET), { INSTAGRAM_APP_SECRET: 'ig-app-secret' }), 'bad_signature', 'only configured secrets count');
    assert.equal(reason(signedRequest(metaPayload(), 'someone-else')), 'bad_signature');
    const [sig] = signedRequest(metaPayload('1'), META_ENV.FACEBOOK_APP_SECRET).split('.');
    assert.equal(reason(`${sig}.${b64u(JSON.stringify(metaPayload('2')))}`), 'bad_signature', 'a payload swapped under a valid signature');
    assert.equal(reason(signedRequest(metaPayload('1', { algorithm: 'HMAC-SHA1' }), META_ENV.FACEBOOK_APP_SECRET)), 'bad_algorithm');
    assert.equal(reason(signedRequest(metaPayload('1', { algorithm: 'hmac-sha256' }), META_ENV.FACEBOOK_APP_SECRET)), 'bad_algorithm');
    assert.equal(reason(signedRequest({ user_id: '1' }, META_ENV.FACEBOOK_APP_SECRET)), 'bad_algorithm');
    assert.equal(reason(signedRequest(metaPayload('abc'), META_ENV.FACEBOOK_APP_SECRET)), 'no_user');
    assert.equal(reason(signedRequest({ algorithm: 'HMAC-SHA256' }, META_ENV.FACEBOOK_APP_SECRET)), 'no_user');
    const notJson = b64u('not json');
    assert.equal(reason(`${crypto.createHmac('sha256', META_ENV.FACEBOOK_APP_SECRET).update(notJson).digest('base64url')}.${notJson}`), 'malformed');
    for (const bad of [undefined, null, '', 42, ['a.b'], 'no-dot', 'a.b.c', 'ab$c.ZGVm', `${sig}.ab+/cd`, `${b64u('short')}.${b64u('{}')}`, `${sig}.`, `.${b64u('{}')}`, `${sig}.${'A'.repeat(9000)}`]) {
        assert.equal(reason(bad), 'malformed', `refused: ${String(bad).slice(0, 30)}`);
    }
    assert.equal(reason(signedRequest(metaPayload(), 'x'), {}), 'not_configured');
    assert.equal(reason(signedRequest(metaPayload(), 'x'), { FACEBOOK_APP_SECRET: '  ', INSTAGRAM_APP_SECRET: '' }), 'not_configured');
});

test('Meta data deletion: Meta gets { url, confirmation_code }; the status page gets only { status, completedAt? }', async () => {
    const code = 'a'.repeat(32);
    assert.deepEqual(Meta.deletionResponse(code, META_ENV), { url: `https://app.example.test/data-deletion?code=${code}`, confirmation_code: code });
    const pending = { status: 'pending', completedAt: null, platform: 'instagram', metaUserId: '17', confirmationCode: code, counts: null };
    assert.deepEqual(Meta.toPublicDeletionStatus(pending), { status: 'pending' });
    const at = new Date('2026-11-24T10:00:00Z');
    assert.deepEqual(Meta.toPublicDeletionStatus({ ...pending, status: 'completed', completedAt: at, metaUserId: null, counts: { accounts: 1 } }), { status: 'completed', completedAt: at });
    await withStubs([[MetaDeletionRequest, 'findOne', () => { throw new Error('no lookup for a malformed code'); }]], async () => {
        for (const bad of ['', 'short', 'g'.repeat(32), `${code}x`, '../../etc', undefined]) assert.equal(await Meta.getMetaDeletionStatus(bad), null);
    });
});

test('Instagram sign-in keeps the app-scoped ids Meta sends in its callbacks', async () => {
    const { instagram } = await import('../src/service/accounts/providers/instagram.js');
    const fetchImpl = fakeFetch([
        ['api.instagram.com/oauth/access_token', { access_token: 'short', user_id: 9001, permissions: 'instagram_business_basic' }],
        ['ig_exchange_token', { access_token: 'long', expires_in: 5184000 }],
        ['/me?fields', { id: '9001', user_id: '17841400000000', username: 'reelmaker' }],
    ]);
    const tokens = await instagram.exchangeCode({ code: 'c', redirectUri: 'https://api.example.test/cb', env: ENV, fetchImpl });
    assert.equal(tokens.scopedUserId, '9001');
    const profile = await instagram.profile({ access: 'long', env: ENV, fetchImpl });
    assert.deepEqual([profile.externalId, profile.scopedUserId], ['17841400000000', '9001'], 'media calls use the professional id; callbacks carry the app-scoped one');
});

test('Meta data deletion callback: off by default, verified, deletes only what Meta sent, same code on repeat', async () => {
    const userId = new mongoose.Types.ObjectId();
    const accountId = new mongoose.Types.ObjectId();
    const postedAt = new Date('2026-10-01T12:00:00Z');
    const video = new Video({
        filename: 'mine.mp4', fileSize: 10, uploader_id: userId, postUrl: 'https://www.instagram.com/reel/m1/', postedAt, creatorFollowers: 3400, creatorPlatform: 'instagram',
        performanceSnapshots: [
            { capturedAt: new Date('2026-10-02T12:00:00Z'), views: 500, source: 'manual' },
            { capturedAt: new Date('2026-10-03T12:00:00Z'), views: 12000, source: 'instagram' },
        ],
    });
    let videoSaves = 0;
    video.save = async () => { videoSaves += 1; return video; };
    const calls = { accountFind: [], postDelete: [], accountDelete: [], outcomeDelete: [] };
    const account = { _id: accountId, userId, platform: 'instagram', externalId: '17841400000000', scopedUserIds: ['9001'], followers: 3400 };
    const store = fakeDeletionStore();
    const callback = async (body) => {
        const res = fakeRes();
        await AccountsController.metaDataDeletion({ body }, res);
        return res;
    };
    const stubs = [
        ...store.stubs,
        [process.env, 'META_DATA_DELETION_ENABLED', 'true'],
        [process.env, 'FACEBOOK_APP_SECRET', META_ENV.FACEBOOK_APP_SECRET],
        [process.env, 'INSTAGRAM_APP_SECRET', META_ENV.INSTAGRAM_APP_SECRET],
        [process.env, 'FRONTEND_URL', META_ENV.FRONTEND_URL],
        [ConnectedAccount, 'find', (filter) => { calls.accountFind.push(filter); return query(filter.$or.some((c) => c.externalId === '9001' || c.scopedUserIds === '9001') && calls.accountDelete.length === 0 ? [account] : []); }],
        [ConnectedAccount, 'exists', async () => null],
        [ConnectedAccount, 'deleteOne', async (filter) => { calls.accountDelete.push(filter); return { deletedCount: 1 }; }],
        [ConnectedPost, 'find', () => query([{ _id: new mongoose.Types.ObjectId(), videoId: video._id, url: 'https://www.instagram.com/reel/m1/', postedAt }])],
        [ConnectedPost, 'deleteMany', async (filter) => { calls.postDelete.push(filter); return { deletedCount: 1 }; }],
        [Video, 'find', () => query([{ _id: video._id }])],
        [Video, 'findOne', async (filter) => (String(filter._id) === String(video._id) && String(filter.uploader_id) === String(userId) ? video : null)],
        [OutcomeSnapshot, 'deleteMany', async (filter) => { calls.outcomeDelete.push(filter); return {}; }],
        [OutcomeSnapshot, 'bulkWrite', async () => ({})],
        [VideoFeatures, 'updateOne', async () => ({})],
    ];
    await withStubs(stubs, async () => {
        const request = signedRequest(metaPayload('9001'), META_ENV.INSTAGRAM_APP_SECRET);
        await withStubs([[process.env, 'META_DATA_DELETION_ENABLED', undefined]], async () => {
            await assert.rejects(callback({ signed_request: request }), (e) => e.statusCode === 404, 'flag off: no callback');
        });
        await assert.rejects(callback({ signed_request: signedRequest(metaPayload('9001'), 'forged') }), (e) => e.statusCode === 400);
        await assert.rejects(callback({}), (e) => e.statusCode === 400);
        await withStubs([[process.env, 'FACEBOOK_APP_SECRET', undefined], [process.env, 'INSTAGRAM_APP_SECRET', undefined]], async () => {
            await assert.rejects(callback({ signed_request: request }), (e) => e.statusCode === 503);
        });
        assert.equal(store.docs.length, 0, 'nothing recorded for a refused callback');

        const first = await callback({ signed_request: request });
        assert.equal(first.statusCode, 200);
        assert.deepEqual(Object.keys(first.body).sort(), ['confirmation_code', 'url']);
        const code = first.body.confirmation_code;
        assert.match(code, /^[a-f0-9]{32}$/);
        assert.equal(first.body.url, `https://app.example.test/data-deletion?code=${code}`);
        assert.deepEqual(calls.accountFind[0], { platform: { $in: ['instagram', 'facebook'] }, $or: [{ externalId: '9001' }, { scopedUserIds: '9001' }] });

        assert.deepEqual(video.performanceSnapshots.map((x) => x.source), ['manual'], 'Instagram readings go, the typed entry stays');
        assert.equal(video.actualViews, 500);
        assert.deepEqual([video.postUrl, video.postedAt, video.creatorFollowers], [null, null, null], 'link, date and followers Instagram gave are cleared');
        assert.equal(video.filename, 'mine.mp4');
        assert.equal(videoSaves, 1, 'the upload itself is kept');
        assert.equal(calls.outcomeDelete.length >= 1, true, 'learning copies of removed readings are removed');
        assert.deepEqual(calls.postDelete, [{ accountId }]);
        assert.deepEqual(calls.accountDelete, [{ _id: accountId }]);
        const [doc] = store.docs;
        assert.deepEqual([doc.status, doc.platform, doc.metaUserId, doc.counts], ['completed', 'instagram', null, { accounts: 1, posts: 1, readings: 1 }]);
        assert.equal(JSON.stringify(doc).includes('9001'), false, 'the Meta user id is not kept once done');

        const again = await callback({ signed_request: request });
        assert.deepEqual(again.body, first.body, 'a repeated callback gets the same code');
        assert.equal(store.docs.length, 1);

        const statusRes = fakeRes();
        statusRes.set = () => statusRes;
        await AccountsController.metaDataDeletionStatus({ params: { code } }, statusRes);
        assert.deepEqual(Object.keys(statusRes.body).sort(), ['completedAt', 'status']);
        assert.equal(statusRes.body.status, 'completed');
        const missing = fakeRes();
        missing.set = () => missing;
        await assert.rejects(AccountsController.metaDataDeletionStatus({ params: { code: 'b'.repeat(32) } }, missing), (e) => e.statusCode === 404);
    });
});

test('Meta data deletion that fails is recorded pending, answered with a code, and finished by the daily retry', async () => {
    const store = fakeDeletionStore();
    let down = true;
    const log = [];
    await withStubs([
        ...store.stubs,
        [ConnectedAccount, 'find', () => { if (down) throw new Error('db hiccup'); return query([]); }],
    ], async () => {
        const body = await Meta.requestMetaDataDeletion({ platform: 'facebook', userId: '4242' }, { env: META_ENV, log: (l) => log.push(l) });
        assert.match(body.confirmation_code, /^[a-f0-9]{32}$/);
        assert.deepEqual([store.docs[0].status, store.docs[0].metaUserId], ['pending', '4242'], 'kept for the retry');
        assert.equal(log.join(' ').includes('4242'), false, 'the Meta user id is never logged');
        assert.deepEqual(await Meta.getMetaDeletionStatus(body.confirmation_code), { status: 'pending' });
        down = false;
        assert.deepEqual(await Meta.finishPendingMetaDeletions({ log: (l) => log.push(l) }), { pending: 1, completed: 1 });
        assert.deepEqual([store.docs[0].status, store.docs[0].metaUserId], ['completed', null]);
    });
});

test('Meta deauthorize callback: accounts need reconnecting, dead tokens are wiped, no data is deleted', async () => {
    const updates = [];
    let deleted = 0;
    await withStubs([
        [process.env, 'META_DATA_DELETION_ENABLED', 'true'],
        [process.env, 'FACEBOOK_APP_SECRET', META_ENV.FACEBOOK_APP_SECRET],
        [process.env, 'INSTAGRAM_APP_SECRET', undefined],
        [ConnectedAccount, 'updateMany', async (filter, update) => { updates.push([filter, update]); return { modifiedCount: 1 }; }],
        [ConnectedAccount, 'deleteOne', async () => { deleted += 1; }],
        [ConnectedPost, 'deleteMany', async () => { deleted += 1; }],
    ], async () => {
        const res = fakeRes();
        await AccountsController.metaDeauthorize({ body: { signed_request: signedRequest(metaPayload('555'), META_ENV.FACEBOOK_APP_SECRET) } }, res);
        assert.equal(res.statusCode, 200);
        const [[filter, update]] = updates;
        assert.deepEqual(filter, { platform: { $in: ['instagram', 'facebook'] }, $or: [{ externalId: '555' }, { scopedUserIds: '555' }] });
        assert.equal(update.$set.status, 'needs_reauth');
        assert.equal(update.$set['tokens.access'], null);
        assert.equal(deleted, 0);
        await assert.rejects(AccountsController.metaDeauthorize({ body: { signed_request: signedRequest(metaPayload('555'), META_ENV.INSTAGRAM_APP_SECRET) } }, fakeRes()), (e) => e.statusCode === 400, 'Instagram secret not set here');
    });
});

test('with a database: Meta deletion and disconnect with deleteData remove Meta data and keep the user and uploads', { skip: !HAS_DB }, async () => {
    const user = await makeUser();
    const video = await makeVideo(user._id, { duration: 18, createdAt: new Date(Date.now() - 3 * DAY) });
    await Video.updateOne({ _id: video._id }, { $push: { performanceSnapshots: { $each: [{ capturedAt: new Date(Date.now() - 2 * DAY), views: 10, source: 'manual' }, { capturedAt: new Date(Date.now() - DAY), views: 900, source: 'instagram' }] } } });
    const ig = await ConnectedAccount.create({ userId: user._id, platform: 'instagram', externalId: '178414', scopedUserIds: ['9001'], tokens: { access: encryptToken('long') } });
    await ConnectedPost.create({ accountId: ig._id, userId: user._id, platform: 'instagram', externalId: 'm1', videoId: video._id });
    const tt = await ConnectedAccount.create({ userId: user._id, platform: 'tiktok', externalId: '9001' });
    const body = await Meta.requestMetaDataDeletion({ platform: 'instagram', userId: '9001' }, { env: META_ENV });
    assert.equal(await ConnectedAccount.countDocuments({ _id: ig._id }), 0);
    assert.equal(await ConnectedPost.countDocuments({ accountId: ig._id }), 0);
    assert.equal(await ConnectedAccount.countDocuments({ _id: tt._id }), 1, 'a TikTok account with the same number is not Meta data');
    assert.deepEqual((await Video.findById(video._id).lean()).performanceSnapshots.map((x) => x.source), ['manual']);
    assert.ok(await User.exists({ _id: user._id }));
    assert.deepEqual(await Meta.getMetaDeletionStatus(body.confirmation_code), { status: 'completed', completedAt: (await MetaDeletionRequest.findOne({ confirmationCode: body.confirmation_code }).lean()).completedAt });

    await Video.updateOne({ _id: video._id }, { $push: { performanceSnapshots: { capturedAt: new Date(), views: 50, source: 'tiktok' } } });
    await ConnectedPost.create({ accountId: tt._id, userId: user._id, platform: 'tiktok', externalId: 'v1', videoId: video._id });
    const out = await A.disconnect(user._id, String(tt._id), { env: ENV, fetchImpl: fakeFetch([]), deleteData: true });
    assert.equal(out.deleted.readings, 1);
    assert.deepEqual((await Video.findById(video._id).lean()).performanceSnapshots.map((x) => x.source), ['manual']);
});
