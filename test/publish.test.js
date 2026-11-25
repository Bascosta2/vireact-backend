import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Publishing engine (scheduled posting). No database: pure functions, an in-memory repo for the job, and
 * fake platform answers shaped like the official docs. (accounts.test.js needs MongoDB in its before hook.)
 */

process.env.NODE_ENV = 'test';
console.warn = () => {};
console.log = () => {};
console.error = () => {};

const A = await import('../src/service/accounts/accounts.service.js');
const { tiktok, TIKTOK_SCOPES } = await import('../src/service/accounts/providers/tiktok.js');
const { youtube } = await import('../src/service/accounts/providers/youtube.js');
const { hasPublishingAccess } = await import('../src/config/flags.js');
const S = await import('../src/service/publish/publish.service.js');
const J = await import('../src/service/publish/publish-job.js');
const { PublishError, transient, permanent } = await import('../src/service/publish/publishers/index.js');
const TT = await import('../src/service/publish/publishers/tiktok.js');
const IG = await import('../src/service/publish/publishers/instagram.js');
const YT = await import('../src/service/publish/publishers/youtube.js');
const FB = await import('../src/service/publish/publishers/facebook.js');

const USER = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const PROJECT = 'cccccccccccccccccccccccc';
const ENV = { AWS_S3_BUCKET_NAME: 'vireact-media', BACKEND_URL: 'https://api.example.test/' };
const MB = 1024 * 1024;

/** Fake platform: first matching [method, urlPart] route answers; records every request. */
const fakeFetch = (routes) => {
    const calls = [];
    const fn = async (url, init = {}) => {
        const method = init.method ?? 'GET';
        calls.push({ url: String(url), method, init });
        for (const [m, part, reply] of routes) {
            if (m === method && String(url).includes(part)) {
                const r = typeof reply === 'function' ? reply(String(url), init, calls) : reply;
                const status = r?.__status ?? 200;
                const headers = r?.__headers ?? {};
                const body = r?.__body !== undefined ? r.__body : r;
                return { status, ok: status < 300, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (body == null ? '' : JSON.stringify(body)) };
            }
        }
        return { status: 404, ok: false, headers: { get: () => null }, text: async () => JSON.stringify({ error: { message: `no route for ${method} ${url}` } }) };
    };
    fn.calls = calls;
    return fn;
};

const media = (sizeBytes = 3 * MB) => ({
    sizeBytes, contentType: 'video/mp4', durationSec: null, reads: [],
    signedUrl: async () => 'https://vireact-media.s3.us-east-1.amazonaws.com/editor/renders/x.mp4?X-Amz-Signature=abc',
    async readRange(start, end) { this.reads.push([start, end]); return Buffer.alloc(end - start + 1); },
    async openStream(offset) { this.reads.push([offset, 'stream']); return Buffer.alloc(sizeBytes - offset); },
});
const noSave = async () => {};
/** A creator's TikTok Direct Post choices as stored on the target (the API's `tiktok` object). */
const TIKTOK_SETTINGS = Object.freeze({ privacyLevel: 'SELF_ONLY', allowComment: false, allowDuet: false, allowStitch: false, commercial: { enabled: false, yourBrand: false, brandedContent: false }, musicConfirmed: true });

// ---- opt-in publish scopes

test('publish scopes are a separate opt-in: the normal sign-in URL stays read-only', () => {
    const normal = new URL(tiktok.authUrl({ state: 's', redirectUri: 'https://cb', codeChallenge: 'c', env: { TIKTOK_CLIENT_KEY: 'k' } }));
    assert.equal(normal.searchParams.get('scope'), TIKTOK_SCOPES.join(','));
    const withPublish = new URL(A.withExtraScopes(normal.toString(), A.PUBLISH_SCOPES.tiktok));
    assert.deepEqual(withPublish.searchParams.get('scope').split(','), [...TIKTOK_SCOPES, 'video.upload', 'video.publish']);
    const yt = new URL(A.withExtraScopes(youtube.authUrl({ state: 's', redirectUri: 'https://cb', codeChallenge: 'c', env: { YOUTUBE_CLIENT_ID: 'i' } }), A.PUBLISH_SCOPES.youtube));
    assert.ok(yt.searchParams.get('scope').split(' ').includes('https://www.googleapis.com/auth/youtube.upload'), 'Google scopes stay space-separated');
    assert.ok(A.PUBLISH_SCOPES.instagram.includes('instagram_business_content_publish'));
    assert.ok(A.PUBLISH_SCOPES.facebook.includes('pages_manage_posts'));
});

test('publishing beta gate: off by default, beta emails, or everyone', () => {
    const saved = { e: process.env.PUBLISHING_ENABLED, b: process.env.PUBLISHING_BETA_EMAILS };
    process.env.PUBLISHING_ENABLED = '';
    process.env.PUBLISHING_BETA_EMAILS = 'Owner@Example.com';
    assert.equal(hasPublishingAccess({ email: 'owner@example.com' }), true);
    assert.equal(hasPublishingAccess({ email: 'someone@example.com' }), false);
    process.env.PUBLISHING_BETA_EMAILS = '';
    assert.equal(hasPublishingAccess({ email: 'owner@example.com' }), false);
    process.env.PUBLISHING_ENABLED = 'true';
    assert.equal(hasPublishingAccess({ email: 'someone@example.com' }), true);
    Object.assign(process.env, { PUBLISHING_ENABLED: saved.e ?? '', PUBLISHING_BETA_EMAILS: saved.b ?? '' });
});

test('capabilities: canPublish only with the platform posting scope, or in dry-run', () => {
    const acct = (scopes, status = 'active') => ({ _id: 'a1', status, tokens: { scopes } });
    assert.deepEqual(S.platformCapability({ platform: 'youtube', account: acct(['https://www.googleapis.com/auth/youtube.upload']) }), { platform: 'youtube', connected: true, canPublish: true });
    const readOnly = S.platformCapability({ platform: 'instagram', account: acct(['instagram_business_basic']) });
    assert.equal(readOnly.canPublish, false);
    assert.match(readOnly.reason, /allow posting/);
    assert.equal(S.platformCapability({ platform: 'tiktok', account: acct(['video.upload']) }).canPublish, true, 'TikTok drafts count');
    assert.equal(S.platformCapability({ platform: 'tiktok', account: null }).connected, false);
    assert.match(S.platformCapability({ platform: 'tiktok', account: acct(['video.publish'], 'needs_reauth') }).reason, /Reconnect/);
    const fb = S.platformCapability({ platform: 'facebook', account: null, providerAvailable: false });
    assert.deepEqual([fb.connected, fb.canPublish], [false, false]);
    assert.match(fb.reason, /not available yet/);
    assert.equal(S.platformCapability({ platform: 'facebook', account: null, providerAvailable: false, dryRun: true }).canPublish, false, 'no provider: refused even in test mode');
    assert.equal(S.platformCapability({ platform: 'facebook', account: null, providerAvailable: true, dryRun: true }).canPublish, true);
});

// ---- ownership

test('mediaUrl must be the user\'s own object in our bucket; never an arbitrary URL', () => {
    const key = `editor/renders/${USER}/${PROJECT}/r1.mp4`;
    assert.equal(S.keyFromMediaUrl(`https://vireact-media.s3.us-east-1.amazonaws.com/${key}?X-Amz-Signature=x`, ENV), key);
    assert.equal(S.keyFromMediaUrl(`https://s3.us-east-1.amazonaws.com/vireact-media/${key}`, ENV), key);
    assert.equal(S.keyFromMediaUrl(`s3://vireact-media/${key}`, ENV), key);
    assert.equal(S.keyFromMediaUrl(`https://evil.example/${key}`, ENV), null);
    assert.equal(S.keyFromMediaUrl(`https://vireact-media.s3.amazonaws.com.evil.example/${key}`, ENV), null);
    assert.equal(S.keyFromMediaUrl(`https://other-bucket.s3.amazonaws.com/${key}`, ENV), null);
    assert.equal(S.keyFromMediaUrl(`http://vireact-media.s3.amazonaws.com/${key}`, ENV), null);
    const dotted = S.keyFromMediaUrl(`https://vireact-media.s3.amazonaws.com/editor/renders/${USER}/%2E%2E/x.mp4`, ENV);
    assert.equal(S.ownsKey(USER, dotted), false, 'dot segments cannot reach another folder');
    assert.equal(S.keyFromMediaUrl('s3://vireact-media/editor/renders/a%2F..%2Fb', ENV), null, 'encoded traversal is refused');
    assert.equal(S.ownsKey(USER, key), true);
    assert.equal(S.ownsKey(OTHER, key), false);
    assert.equal(S.ownsKey(USER, `editor/frames/${USER}/${PROJECT}/a.jpg`), false, 'only exports and uploads');
});

test('resolveMedia: exactly one source, own project with a finished export, object must exist', async () => {
    const storageImpl = { head: async (k) => (k.includes('missing') ? null : { sizeBytes: 5 * MB, contentType: 'video/mp4' }) };
    const project = { _id: PROJECT, userId: USER, renders: [{ status: 'done', key: `editor/renders/${USER}/${PROJECT}/a.mp4` }, { status: 'rendering', key: 'x' }] };
    const findProject = async (id) => (id === PROJECT ? project : null);
    const ok = await S.resolveMedia(USER, { projectId: PROJECT }, { findProject, storageImpl, env: ENV });
    assert.deepEqual(ok, { projectId: PROJECT, media: { key: `editor/renders/${USER}/${PROJECT}/a.mp4`, sizeBytes: 5 * MB, contentType: 'video/mp4' } });
    await assert.rejects(S.resolveMedia(USER, {}, { findProject, storageImpl, env: ENV }), { statusCode: 400 });
    await assert.rejects(S.resolveMedia(USER, { projectId: PROJECT, mediaUrl: 's3://vireact-media/x' }, { findProject, storageImpl, env: ENV }), { statusCode: 400 });
    await assert.rejects(S.resolveMedia(OTHER, { projectId: PROJECT }, { findProject, storageImpl, env: ENV }), { statusCode: 404 }, 'someone else\'s project');
    await assert.rejects(S.resolveMedia(USER, { projectId: PROJECT }, { findProject: async () => ({ ...project, renders: [] }), storageImpl, env: ENV }), /no finished export/);
    await assert.rejects(S.resolveMedia(USER, { mediaUrl: `s3://vireact-media/editor/renders/${OTHER}/${PROJECT}/a.mp4` }, { storageImpl, env: ENV }), /your own/);
    await assert.rejects(S.resolveMedia(USER, { mediaUrl: `s3://vireact-media/editor/renders/${USER}/${PROJECT}/missing.mp4` }, { storageImpl, env: ENV }), /could not find/);
    const byUrl = await S.resolveMedia(USER, { mediaUrl: `https://vireact-media.s3.amazonaws.com/editor/sources/${USER}/${PROJECT}/source.mp4?sig=1` }, { storageImpl, env: ENV });
    assert.equal(byUrl.projectId, null);
});

test('validation: platforms, caption, time, and per-platform mode rules', () => {
    const now = Date.parse('2026-11-23T12:00:00Z');
    assert.deepEqual(S.validatePlatforms(['TikTok', 'tiktok', 'youtube']), ['tiktok', 'youtube']);
    assert.throws(() => S.validatePlatforms([]), { statusCode: 400 });
    assert.throws(() => S.validatePlatforms(['myspace']), /not supported/);
    assert.throws(() => S.validateCaption('x'.repeat(2201)), /2200/);
    assert.throws(() => S.validateCaption(Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' '), ['instagram']), /30 hashtags/);
    assert.equal(S.validateScheduledAt('2026-11-23T11:58:00Z', now).getTime(), now, 'a moment ago means now');
    assert.throws(() => S.validateScheduledAt('2026-11-23T11:00:00Z', now), /already passed/);
    assert.throws(() => S.validateScheduledAt('not a date', now), { statusCode: 400 });
    const yes = { canPublish: true };
    const accounts = { tiktok: { _id: 't1', tokens: { scopes: ['video.upload'] } }, instagram: { _id: 'i1', tokens: { scopes: ['instagram_business_content_publish'] } } };
    assert.throws(() => S.buildTargets({ platforms: ['instagram'], mode: 'draft', accounts, capabilities: { instagram: yes } }), /does not support saving drafts/);
    assert.throws(() => S.buildTargets({ platforms: ['tiktok'], mode: 'publish', accounts, capabilities: { tiktok: yes } }), /drafts only/);
    assert.throws(() => S.buildTargets({ platforms: ['youtube'], mode: 'publish', accounts, capabilities: { youtube: { canPublish: false, reason: 'Connect YouTube first.' } } }), /Connect YouTube first/);
    const [t] = S.buildTargets({ platforms: ['tiktok'], mode: 'draft', accounts, capabilities: { tiktok: yes } });
    assert.deepEqual(t, { platform: 'tiktok', accountId: 't1', status: 'pending', attempts: 0, state: {} });
    assert.equal(S.buildTargets({ platforms: ['youtube'], mode: 'publish', accounts: {}, capabilities: { youtube: yes }, dryRun: true })[0].accountId, null);
});

test('public post shape follows the contract and omits empty optional fields', async () => {
    const p = await S.toPublicPost({
        _id: 'p1', projectId: null, media: { key: 'k' }, caption: 'hi', scheduledAt: new Date(0), status: 'partially_published', mode: 'publish',
        targets: [{ platform: 'youtube', status: 'published', externalId: 'v1', url: 'https://www.youtube.com/watch?v=v1', error: null, state: { uploadUri: 'secret' } }, { platform: 'tiktok', status: 'failed', error: 'TikTok said no.' }],
        createdAt: new Date(0), updatedAt: new Date(0), lockedUntil: null,
    }, { storageImpl: { presignDownload: async (k) => `https://signed/${k}` } });
    assert.deepEqual(Object.keys(p), ['id', 'mediaUrl', 'caption', 'scheduledAt', 'status', 'mode', 'targets', 'createdAt', 'updatedAt']);
    assert.equal(p.mediaUrl, 'https://signed/k');
    assert.deepEqual(p.targets, [{ platform: 'youtube', status: 'published', externalId: 'v1', url: 'https://www.youtube.com/watch?v=v1' }, { platform: 'tiktok', status: 'failed', error: 'TikTok said no.' }]);
});

// ---- queue and state transitions

test('scheduling payload: signed run endpoint, notBefore at scheduledAt, capped delay, dedup id', () => {
    const now = Date.parse('2026-11-23T12:00:00Z');
    const at = Date.parse('2026-11-24T09:30:00Z');
    const m = J.buildRunMessage({ postId: 'p1', version: 2, at, now, env: ENV });
    assert.deepEqual(m, { url: 'https://api.example.test/api/v1/posts/jobs/run', body: { postId: 'p1', version: 2 }, notBefore: at / 1000, retries: 3, deduplicationId: `post-p1-v2-${at / 1000}` });
    const far = J.buildRunMessage({ postId: 'p1', at: now + 30 * 86400000, now, env: ENV });
    assert.equal(far.notBefore, (now + 7 * 86400000) / 1000, 'longer than the queue allows: hop');
    assert.equal(J.buildRunMessage({ postId: 'p1', at: now - 1000, now, env: ENV }).notBefore, now / 1000);
    assert.throws(() => J.buildRunMessage({ postId: 'p1', at, now, env: {} }), /BACKEND_URL/);
});

test('state transitions: published, waiting, retry with backoff, give up, permanent, reauth', () => {
    const now = 1_000_000;
    const t = { platform: 'youtube', status: 'pending', attempts: 0, state: {} };
    const done = J.applyOutcome(t, { type: 'published', externalId: 'v1', url: 'u', state: {} }, now);
    assert.deepEqual([done.status, done.externalId, done.error], ['published', 'v1', null]);
    assert.equal(J.applyOutcome(done, { type: 'error', error: permanent('x') }, now).status, 'published', 'published is final');
    const wait = J.applyOutcome(t, { type: 'waiting', state: { c: 1 }, retryInSec: 60 }, now);
    assert.deepEqual([wait.status, wait.nextAttemptAt.getTime(), wait.state.waitStartedAt], ['publishing', now + 60_000, now]);
    const tooLong = J.applyOutcome(wait, { type: 'waiting', state: wait.state, retryInSec: 60 }, now + J.MAX_WAIT_MS + 1);
    assert.equal(tooLong.status, 'failed');
    let r = t;
    for (let i = 1; i < J.MAX_ATTEMPTS; i++) {
        r = J.applyOutcome(r, { type: 'error', error: transient('YouTube had a temporary problem. We will try again shortly.') }, now);
        assert.deepEqual([r.status, r.attempts, r.nextAttemptAt.getTime()], ['publishing', i, now + J.BACKOFF_SEC[i - 1] * 1000]);
    }
    r = J.applyOutcome(r, { type: 'error', error: transient('YouTube had a temporary problem. We will try again shortly.') }, now);
    assert.equal(r.status, 'failed');
    assert.equal(r.error, 'YouTube had a temporary problem. We tried 5 times and stopped. Schedule the post again to retry.');
    const reset = J.applyOutcome({ ...t, state: { uploadUri: 'x' } }, { type: 'error', error: transient('expired', { resetState: true }) }, now);
    assert.deepEqual(reset.state, {});
    assert.equal(J.applyOutcome(t, { type: 'error', error: new PublishError('Reconnect.', { reauth: true, retry: true }) }, now).status, 'failed');
    const st = (s) => ({ status: s });
    assert.equal(J.aggregateStatus([st('published'), st('published')]), 'published');
    assert.equal(J.aggregateStatus([st('published'), st('failed')]), 'partially_published');
    assert.equal(J.aggregateStatus([st('failed'), st('failed')]), 'failed');
    assert.equal(J.aggregateStatus([st('published'), st('publishing')]), 'publishing');
    assert.equal(J.aggregateStatus([st('cancelled')]), 'cancelled');
});

/** In-memory stand-in for mongoRepo. */
const memoryRepo = (post) => {
    const db = { post: structuredClone(post), reauth: [] };
    const own = (token) => { if (db.post.lockToken !== token) throw new J.LeaseLostError(); };
    return {
        db,
        async claim(id, now, token) {
            const p = db.post;
            if (!['scheduled', 'publishing'].includes(p.status) || new Date(p.scheduledAt).getTime() > now + J.DUE_SLACK_MS) return null;
            if (p.lockedUntil && new Date(p.lockedUntil).getTime() > now) return null;
            Object.assign(p, { status: 'publishing', lockedUntil: new Date(now + J.LEASE_MS), lockToken: token });
            return structuredClone(p);
        },
        get: async () => structuredClone(db.post),
        renew: async (id, token, until) => { own(token); db.post.lockedUntil = new Date(until); },
        saveTargetState: async (id, token, i, state) => { own(token); db.post.targets[i].state = structuredClone(state); },
        saveTarget: async (id, token, i, t) => { own(token); db.post.targets[i] = structuredClone(t); },
        finish: async (id, token, patch) => { own(token); Object.assign(db.post, patch, { lockedUntil: null, lockToken: null }); },
        findOwner: async () => ({ email: 'owner@example.com' }),
        findAccount: async (aid) => ({ _id: aid, platform: aid, status: 'active', externalId: `ext-${aid}`, tokens: { scopes: ['video.publish', 'video.upload', 'https://www.googleapis.com/auth/youtube.upload', 'instagram_business_content_publish', 'pages_manage_posts'] } }),
        markReauth: async (aid) => { db.reauth.push(aid); },
    };
};

const basePost = (platforms, extra = {}) => ({
    _id: 'post1', userId: USER, media: { key: 'k', sizeBytes: MB }, caption: 'hello', mode: 'publish', status: 'scheduled', scheduleVersion: 1,
    scheduledAt: new Date(1_000_000), lockedUntil: null, queueMessageId: null,
    targets: platforms.map((p) => ({ platform: p, accountId: p, status: 'pending', attempts: 0, state: {} })), ...extra,
});

test('job: dry-run publishes every target without platform calls', async () => {
    const repo = memoryRepo(basePost(['tiktok', 'instagram', 'youtube', 'facebook']));
    const out = await J.runPublishJob('post1', { repo, hasAccess: () => true, dryRun: true, clock: () => 1_000_000, media: () => media(), schedule: async () => assert.fail('nothing to schedule') });
    assert.equal(out.status, 'published');
    assert.ok(repo.db.post.targets.every((t) => t.status === 'published' && t.externalId.startsWith('dry-run-')));
    assert.equal(repo.db.post.lockedUntil, null);
});

test('job: idempotent (a published target is never sent again), retries transient errors, queues the next pass', async () => {
    const repo = memoryRepo(basePost(['youtube', 'tiktok']));
    const calls = { youtube: 0, tiktok: 0 };
    const publishers = {
        youtube: { requiredScopes: () => [], step: async () => { calls.youtube += 1; return { status: 'published', externalId: 'v1', url: 'u' }; } },
        tiktok: { requiredScopes: () => [], step: async () => { calls.tiktok += 1; if (calls.tiktok === 1) throw transient('TikTok had a temporary problem.'); return { status: 'published', externalId: 't1', url: null }; } },
    };
    const queued = [];
    let now = 1_000_000;
    const deps = { repo, hasAccess: () => true, dryRun: false, publishers, accessToken: async () => 'tok', media: () => media(), clock: () => now, schedule: async (m) => { queued.push(m); return `msg-${queued.length}`; } };
    const first = await J.runPublishJob('post1', deps);
    assert.equal(first.status, 'publishing');
    assert.deepEqual(repo.db.post.targets.map((t) => t.status), ['published', 'publishing']);
    assert.equal(queued[0].at, now + 60_000, 'retry in 1 minute');
    assert.equal(repo.db.post.queueMessageId, 'msg-1');
    // A duplicate delivery before the retry is due changes nothing and calls nobody.
    await J.runPublishJob('post1', deps);
    assert.deepEqual(calls, { youtube: 1, tiktok: 1 });
    now += 61_000;
    const second = await J.runPublishJob('post1', deps);
    assert.equal(second.status, 'published');
    assert.deepEqual(calls, { youtube: 1, tiktok: 2 });
    await J.runPublishJob('post1', deps);
    assert.deepEqual(calls, { youtube: 1, tiktok: 2 }, 'a finished post is never run again');
});

test('job: locked, not yet due, stale message, reconnect and missing permission', async () => {
    const queued = [];
    const schedule = async (m) => { queued.push(m); return 'm'; };
    const locked = memoryRepo(basePost(['youtube'], { status: 'publishing', lockedUntil: new Date(1_500_000) }));
    assert.deepEqual(await J.runPublishJob('post1', { repo: locked, hasAccess: () => true, clock: () => 1_000_000, schedule }), { deferred: 'locked' });
    assert.equal(queued.at(-1).at, 1_530_000);
    const later = memoryRepo(basePost(['youtube'], { scheduledAt: new Date(9_000_000_000), scheduleVersion: 3 }));
    assert.deepEqual(await J.runPublishJob('post1', { repo: later, hasAccess: () => true, clock: () => 1_000_000, schedule, version: 3 }), { deferred: 'not_due' });
    assert.equal(queued.at(-1).at, 9_000_000_000);
    assert.deepEqual(await J.runPublishJob('post1', { repo: later, hasAccess: () => true, clock: () => 1_000_000, schedule, version: 2 }), { skipped: 'stale' });
    const cancelled = memoryRepo(basePost(['youtube'], { status: 'cancelled' }));
    assert.deepEqual(await J.runPublishJob('post1', { repo: cancelled, hasAccess: () => true, clock: () => 1_000_000, schedule }), { skipped: 'cancelled' });

    const reauthRepo = memoryRepo(basePost(['youtube', 'instagram']));
    reauthRepo.findAccount = async (aid) => ({ _id: aid, status: 'active', tokens: { scopes: aid === 'youtube' ? ['https://www.googleapis.com/auth/youtube.upload'] : ['instagram_business_basic'] } });
    const err = Object.assign(new Error('expired'), { reauth: true });
    const out = await J.runPublishJob('post1', { repo: reauthRepo, hasAccess: () => true, dryRun: false, clock: () => 1_000_000, schedule, media: () => media(), accessToken: async () => { throw err; } });
    assert.equal(out.status, 'failed');
    assert.match(reauthRepo.db.post.targets[0].error, /Reconnect your YouTube account/);
    assert.match(reauthRepo.db.post.targets[1].error, /permission to post/);
    assert.deepEqual(reauthRepo.db.reauth, [], 'the account itself is not touched unless the platform refused the token mid-step');
});

// ---- publishers: request building against documented shapes

test('TikTok: chunk plan follows the media transfer rules', () => {
    assert.deepEqual(TT.tiktokChunkPlan(3 * MB), { chunkSize: 3 * MB, totalChunkCount: 1, ranges: [[0, 3 * MB - 1]] });
    const big = TT.tiktokChunkPlan(105 * MB + 7);
    assert.equal(big.chunkSize, 10 * MB);
    assert.equal(big.totalChunkCount, 10);
    assert.deepEqual(big.ranges.at(-1), [90 * MB, 105 * MB + 6], 'last chunk absorbs the remainder');
    assert.ok(big.ranges.at(-1)[1] - big.ranges.at(-1)[0] + 1 <= 128 * MB);
    assert.throws(() => TT.tiktokChunkPlan(0), PublishError);
});

test('TikTok: direct post sends the creator\'s own choices; draft goes to the inbox; full flow', async () => {
    const creator = { privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'], comment_disabled: true };
    const direct = TT.buildTikTokInit({ mode: 'publish', caption: 'hi', sizeBytes: MB, creator, settings: TIKTOK_SETTINGS, env: {} });
    assert.equal(direct.url, 'https://open.tiktokapis.com/v2/post/publish/video/init/');
    assert.deepEqual(direct.body.post_info, { title: 'hi', privacy_level: 'SELF_ONLY', disable_comment: true, disable_duet: true, disable_stitch: true, brand_content_toggle: false, brand_organic_toggle: false });
    assert.deepEqual(direct.body.source_info, { source: 'FILE_UPLOAD', video_size: MB, chunk_size: MB, total_chunk_count: 1 });
    const chosen = { ...TIKTOK_SETTINGS, privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: true, allowStitch: false, commercial: { enabled: true, yourBrand: true, brandedContent: true } };
    assert.deepEqual(TT.buildTikTokInit({ mode: 'publish', sizeBytes: MB, creator: { privacy_level_options: ['PUBLIC_TO_EVERYONE'] }, settings: chosen, env: { TIKTOK_DIRECT_POST_AUDITED: 'true' } }).body.post_info,
        { title: '', privacy_level: 'PUBLIC_TO_EVERYONE', disable_comment: false, disable_duet: false, disable_stitch: true, brand_content_toggle: true, brand_organic_toggle: true });
    assert.throws(() => TT.buildTikTokInit({ mode: 'publish', sizeBytes: MB, creator, settings: chosen, env: {} }), (e) => e.retry === false && /"Only me" until TikTok approves/.test(e.message), 'unaudited: refused, never downgraded');
    const draft = TT.buildTikTokInit({ mode: 'draft', sizeBytes: MB, env: {} });
    assert.equal(draft.url, 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/');
    assert.equal(draft.body.post_info, undefined);

    const f = fakeFetch([
        ['POST', '/creator_info/query/', { data: creator, error: { code: 'ok' } }],
        ['POST', '/video/init/', { data: { publish_id: 'pub1', upload_url: 'https://open-upload.tiktokapis.com/video/?upload_id=1' }, error: { code: 'ok' } }],
        ['PUT', 'open-upload.tiktokapis.com', { __status: 201, __body: null }],
        ['POST', '/status/fetch/', { data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [7300] }, error: { code: 'ok' } }],
    ]);
    const saved = [];
    const m = media(MB);
    const r = await TT.tiktokPublisher.step({ post: { mode: 'publish', caption: 'hi' }, target: { state: {}, tiktok: TIKTOK_SETTINGS }, account: { handle: 'maker' }, access: 'tok', media: m, env: {}, fetchImpl: f, save: async (s) => saved.push({ ...s }) });
    assert.deepEqual(r, { status: 'published', externalId: '7300', url: 'https://www.tiktok.com/@maker/video/7300', state: { publishId: 'pub1', uploaded: true } });
    const put = f.calls.find((c) => c.method === 'PUT');
    assert.equal(put.init.headers['Content-Range'], `bytes 0-${MB - 1}/${MB}`);
    assert.equal(f.calls[0].init.headers.Authorization, 'Bearer tok');
    assert.deepEqual(saved.map((s) => s.uploaded), [false, true], 'progress saved before and after the upload');

    // Resume: an uploaded publish is only polled, never initialised again.
    const poll = fakeFetch([['POST', '/status/fetch/', { data: { status: 'PROCESSING_UPLOAD' }, error: { code: 'ok' } }]]);
    const w = await TT.tiktokPublisher.step({ post: { mode: 'publish' }, target: { state: { publishId: 'pub1', uploaded: true } }, access: 'tok', media: m, fetchImpl: poll, save: noSave });
    assert.equal(w.status, 'waiting');
    assert.equal(poll.calls.length, 1);
});

test('TikTok: refusals become plain-English errors', async () => {
    const run = (reply) => TT.tiktokPublisher.step({ post: { mode: 'publish' }, target: { state: {}, tiktok: TIKTOK_SETTINGS }, access: 'tok', media: media(), env: {}, fetchImpl: fakeFetch([['POST', '/creator_info/', { data: { privacy_level_options: ['SELF_ONLY'] }, error: { code: 'ok' } }], ['POST', '/video/init/', reply]]), save: noSave });
    await assert.rejects(run({ __status: 403, __body: { error: { code: 'unaudited_client_can_only_post_to_private_accounts' } } }), (e) => e.retry === false && /private accounts/.test(e.message));
    await assert.rejects(run({ __status: 429, __body: { error: { code: 'rate_limit_exceeded' } } }), (e) => e.retry === true);
    await assert.rejects(run({ __status: 401, __body: { error: { code: 'access_token_invalid' } } }), (e) => e.reauth === true);
    const failed = fakeFetch([['POST', '/status/fetch/', { data: { status: 'FAILED', fail_reason: 'duration_check_failed' }, error: { code: 'ok' } }]]);
    await assert.rejects(TT.tiktokPublisher.step({ post: { mode: 'draft' }, target: { state: { publishId: 'p', uploaded: true } }, access: 't', media: media(), fetchImpl: failed, save: noSave }), /too long or too short/);
});

test('Instagram: Reels container, wait for FINISHED, media_publish, permalink', async () => {
    const req = IG.buildReelContainer({ igUserId: '1784', videoUrl: 'https://signed', caption: 'hi', access: 'tok', env: {} });
    assert.equal(req.url, 'https://graph.instagram.com/v25.0/1784/media');
    assert.deepEqual(req.form, { media_type: 'REELS', video_url: 'https://signed', caption: 'hi', share_to_feed: 'true', access_token: 'tok' });
    const account = { externalId: '1784' };
    const post = { mode: 'publish', caption: 'hi' };
    const f1 = fakeFetch([['POST', '/1784/media', { id: 'c9' }]]);
    const s1 = await IG.instagramPublisher.step({ post, target: { state: {} }, account, access: 'tok', media: media(), env: {}, fetchImpl: f1, save: noSave });
    assert.deepEqual([s1.status, s1.state.containerId], ['waiting', 'c9']);
    assert.match(new URLSearchParams(f1.calls[0].init.body).get('video_url'), /^https:\/\/vireact-media/);
    const f2 = fakeFetch([
        ['GET', '/c9?fields=status_code', { status_code: 'FINISHED' }],
        ['POST', '/1784/media_publish', { id: 'm1' }],
        ['GET', '/m1?fields=permalink', { permalink: 'https://www.instagram.com/reel/abc/' }],
    ]);
    const saved = [];
    const s2 = await IG.instagramPublisher.step({ post, target: { state: s1.state }, account, access: 'tok', media: media(), env: {}, fetchImpl: f2, save: async (s) => saved.push({ ...s }) });
    assert.deepEqual([s2.status, s2.externalId, s2.url], ['published', 'm1', 'https://www.instagram.com/reel/abc/']);
    assert.equal(saved[0].publishRequested, true, 'marked before publishing so a crash cannot publish twice');
    const limit = fakeFetch([['GET', '/c9?', { status_code: 'FINISHED' }], ['POST', '/media_publish', { __status: 400, __body: { error: { code: 9, error_subcode: 2207042, message: 'limit' } } }]]);
    await assert.rejects(IG.instagramPublisher.step({ post, target: { state: { containerId: 'c9' } }, account, access: 'tok', media: media(), env: {}, fetchImpl: limit, save: noSave }), /limit of posts made by apps/);
    const expired = fakeFetch([['GET', '/c9?', { status_code: 'EXPIRED' }]]);
    await assert.rejects(IG.instagramPublisher.step({ post, target: { state: { containerId: 'c9' } }, account, access: 'tok', media: media(), env: {}, fetchImpl: expired, save: noSave }), (e) => e.retry && e.resetState);
});

test('YouTube: resumable session, 256 KB-multiple chunks, 308 continue, resume after interruption', async () => {
    assert.equal(YT.YOUTUBE_CHUNK % (256 * 1024), 0);
    const meta = YT.buildYouTubeMetadata({ caption: '\nMy <best> clip\n#shorts more', mode: 'draft' });
    assert.deepEqual(meta, { snippet: { title: 'My best clip', description: 'My best clip\n#shorts more', categoryId: '22' }, status: { privacyStatus: 'private', selfDeclaredMadeForKids: false } });
    assert.equal(YT.buildYouTubeMetadata({ caption: 'x'.repeat(300), mode: 'publish' }).snippet.title.length, 100);
    assert.equal(YT.nextOffset('bytes=0-999'), 1000);

    const size = YT.YOUTUBE_CHUNK + 1000;
    const f = fakeFetch([
        ['POST', 'uploadType=resumable', { __status: 200, __headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=S1' }, __body: null }],
        ['PUT', 'upload_id=S1', (url, init) => (init.headers['Content-Range'].startsWith('bytes 0-')
            ? { __status: 308, __headers: { range: `bytes=0-${YT.YOUTUBE_CHUNK - 1}` }, __body: null }
            : { __status: 201, __body: { id: 'vid1' } })],
    ]);
    const m = media(size);
    const r = await YT.youtubePublisher.step({ post: { mode: 'publish', caption: 'Hi' }, target: { state: {} }, access: 'tok', media: m, fetchImpl: f, save: noSave });
    assert.deepEqual([r.status, r.externalId, r.url], ['published', 'vid1', 'https://www.youtube.com/watch?v=vid1']);
    assert.equal(f.calls[0].init.headers['X-Upload-Content-Length'], String(size));
    assert.equal(JSON.parse(f.calls[0].init.body).status.privacyStatus, 'public');
    assert.deepEqual(f.calls.slice(1).map((c) => c.init.headers['Content-Range']), [`bytes 0-${YT.YOUTUBE_CHUNK - 1}/${size}`, `bytes ${YT.YOUTUBE_CHUNK}-${size - 1}/${size}`]);

    const resume = fakeFetch([['PUT', 'upload_id=S1', (url, init) => (init.headers['Content-Range'] === `bytes */${size}`
        ? { __status: 308, __headers: { range: `bytes=0-${YT.YOUTUBE_CHUNK - 1}` }, __body: null }
        : { __status: 200, __body: { id: 'vid1' } })]]);
    const m2 = media(size);
    const r2 = await YT.youtubePublisher.step({ post: { mode: 'publish' }, target: { state: { uploadUri: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=S1' } }, access: 'tok', media: m2, fetchImpl: resume, save: noSave });
    assert.equal(r2.externalId, 'vid1');
    assert.deepEqual(m2.reads, [[YT.YOUTUBE_CHUNK, size - 1]], 'only the missing bytes are sent');
    const quota = fakeFetch([['POST', 'uploadType=resumable', { __status: 403, __body: { error: { errors: [{ reason: 'quotaExceeded' }] } } }]]);
    await assert.rejects(YT.youtubePublisher.step({ post: { mode: 'publish' }, target: { state: {} }, access: 't', media: media(), fetchImpl: quota, save: noSave }), (e) => e.retry && e.retryAfterSec >= 3600);
});

test('Facebook: Page Reel start, upload with the Page token, finish as PUBLISHED or DRAFT', async () => {
    const fin = FB.buildReelFinish({ pageId: 'pg1', videoId: 'v7', caption: 'hi', mode: 'draft', access: 'ptok', env: {} });
    assert.equal(fin.url, 'https://graph.facebook.com/v25.0/pg1/video_reels');
    assert.deepEqual(fin.form, { upload_phase: 'finish', video_id: 'v7', video_state: 'DRAFT', description: 'hi', access_token: 'ptok' });
    const f = fakeFetch([
        ['POST', '/pg1/video_reels', (url, init) => (new URLSearchParams(init.body).get('upload_phase') === 'start' ? { video_id: 'v7', upload_url: 'https://rupload.facebook.com/video-upload/v25.0/v7' } : { success: true })],
        ['POST', 'rupload.facebook.com', { success: true }],
    ]);
    const provider = { pages: async ({ access }) => (access === 'utok' ? [{ id: 'pg1', access_token: 'ptok' }, { id: 'pg2', access_token: 'other' }] : []) };
    const r = await FB.facebookPublisher.step({ post: { mode: 'publish', caption: 'hi' }, target: { pageId: 'pg1', state: {} }, account: { externalId: 'fbuser' }, access: 'utok', provider, media: media(), env: {}, fetchImpl: f, save: noSave });
    assert.deepEqual([r.status, r.externalId, r.url], ['published', 'v7', 'https://www.facebook.com/reel/v7']);
    const up = f.calls.find((c) => c.url.includes('rupload'));
    assert.deepEqual([up.init.headers.Authorization, up.init.headers.offset, up.init.headers.file_size], ['OAuth ptok', '0', String(3 * MB)]);
    assert.equal(new URLSearchParams(f.calls.at(-1).init.body).get('video_state'), 'PUBLISHED');
    const bad = fakeFetch([['POST', '/pg1/video_reels', { __status: 400, __body: { error: { code: 1363040, message: 'aspect' } } }]]);
    const fb = (target, fetchImpl, extra = {}) => FB.facebookPublisher.step({ post: { mode: 'publish' }, target, account: { externalId: 'fbuser' }, access: 'utok', provider, media: media(), env: {}, fetchImpl, save: noSave, ...extra });
    await assert.rejects(fb({ pageId: 'pg1', state: { videoId: 'v7', uploaded: true } }, bad), /vertical 9:16/);
    const expiredToken = fakeFetch([['POST', '/video_reels', { __status: 400, __body: { error: { code: 190, message: 'expired' } } }]]);
    await assert.rejects(fb({ pageId: 'pg1', state: {} }, expiredToken), (e) => e.reauth === true);
    // Never the login's own id, never without a Page, never without the provider.
    await assert.rejects(fb({ pageId: null, state: {} }, f), /No Facebook Page was chosen/);
    await assert.rejects(fb({ pageId: 'pg9', state: {} }, f), /can no longer post to that Facebook Page/);
    await assert.rejects(fb({ pageId: 'pg1', state: {} }, f, { provider: null }), /not available yet/);
    // Resume: a failed status check retries later instead of resending from byte 0.
    const statusDown = fakeFetch([['GET', '/v7?fields=status', { __status: 503, __body: { error: { code: 2, message: 'down' } } }], ['POST', 'rupload', () => assert.fail('must not upload blindly')]]);
    await assert.rejects(fb({ pageId: 'pg1', state: { videoId: 'v7', uploadStarted: true, uploaded: false } }, statusDown), (e) => e.retry === true);
    const half = fakeFetch([['GET', '/v7?fields=status', { status: { uploading_phase: { status: 'in_progress', bytes_transfered: MB } } }], ['POST', 'rupload', { success: true }], ['POST', '/pg1/video_reels', { success: true }]]);
    const m = media();
    await fb({ pageId: 'pg1', state: { videoId: 'v7', uploadStarted: true, uploaded: false } }, half, { media: m });
    assert.deepEqual(m.reads, [[MB, 'stream']]);
    assert.equal(half.calls.find((c) => c.url.includes('rupload')).init.headers.offset, String(MB));
});

test('Facebook Page choice at create time: requested Page must be shared; one Page is the default', async () => {
    const two = { pages: async () => [{ id: '111', name: 'A', access_token: 'a' }, { id: '222', name: 'B', access_token: 'b' }] };
    const one = { pages: async () => [{ id: '111', access_token: 'a' }] };
    const accessToken = async () => 'utok';
    const account = { _id: 'f1' };
    assert.equal(await S.resolveFacebookPage({ account, pageId: '222', provider: two, accessToken }), '222');
    assert.equal(await S.resolveFacebookPage({ account, provider: one, accessToken }), '111');
    await assert.rejects(S.resolveFacebookPage({ account, provider: two, accessToken }), (e) => e.statusCode === 400 && e.data.code === 'FACEBOOK_PAGE_REQUIRED' && e.data.pages.length === 2);
    await assert.rejects(S.resolveFacebookPage({ account, pageId: '333', provider: two, accessToken }), /not shared/);
    await assert.rejects(S.resolveFacebookPage({ account, provider: null, accessToken }), /not available yet/);
    const [t] = S.buildTargets({ platforms: ['facebook'], mode: 'publish', accounts: { facebook: { _id: 'f1', tokens: { scopes: ['pages_manage_posts'] } } }, capabilities: { facebook: { canPublish: true } }, pageId: '111' });
    assert.equal(t.pageId, '111');
});

test('TikTok: a stopped upload is checked before starting again, so it can never post twice', async () => {
    const run = (statusReply) => {
        const f = fakeFetch([
            ['POST', '/status/fetch/', statusReply],
            ['POST', '/creator_info/', { data: { privacy_level_options: ['SELF_ONLY'] }, error: { code: 'ok' } }],
            ['POST', '/video/init/', { data: { publish_id: 'pub2', upload_url: 'https://open-upload.tiktokapis.com/u' }, error: { code: 'ok' } }],
            ['PUT', 'open-upload', { __status: 201, __body: null }],
        ]);
        return TT.tiktokPublisher.step({ post: { mode: 'publish' }, target: { state: { publishId: 'pub1', uploaded: false }, tiktok: TIKTOK_SETTINGS }, access: 't', media: media(MB), env: {}, fetchImpl: f, save: noSave }).then((r) => ({ r, f }));
    };
    const received = await run({ data: { status: 'PROCESSING_UPLOAD', uploaded_bytes: MB }, error: { code: 'ok' } });
    assert.equal(received.f.calls.filter((c) => c.url.includes('/init/')).length, 0, 'all bytes arrived: only poll');
    assert.equal(received.r.state.publishId, 'pub1');
    const partial = await run({ data: { status: 'PROCESSING_UPLOAD', uploaded_bytes: 10 }, error: { code: 'ok' } });
    assert.equal(partial.f.calls.filter((c) => c.url.includes('/video/init/')).length, 1, 'incomplete upload: start again');
});

test('job: test posts stay simulated, a stale pass cannot overwrite a newer one, kill switch cancels', async () => {
    const calls = [];
    const live = { youtube: { requiredScopes: () => [], step: async () => { calls.push('live'); return { status: 'published', externalId: 'real' }; } } };
    const stored = memoryRepo(basePost(['youtube'], { dryRun: true }));
    await J.runPublishJob('post1', { repo: stored, hasAccess: () => true, publishers: live, accessToken: async () => 't', media: () => media(), clock: () => 1_000_000, schedule: async () => 'm' });
    assert.deepEqual(calls, [], 'created in test mode: never sent live');
    assert.match(stored.db.post.targets[0].externalId, /^dry-run-/);

    const raced = memoryRepo(basePost(['youtube']));
    const slow = { youtube: { requiredScopes: () => [], step: async () => { raced.db.post.lockToken = 'someone-else'; return { status: 'published', externalId: 'x' }; } } };
    const out = await J.runPublishJob('post1', { repo: raced, hasAccess: () => true, dryRun: false, publishers: slow, accessToken: async () => 't', media: () => media(), clock: () => 1_000_000, schedule: async () => 'm' });
    assert.deepEqual(out, { skipped: 'lease_lost' });
    assert.equal(raced.db.post.targets[0].status, 'pending', 'the stale pass wrote nothing');

    const off = memoryRepo(basePost(['youtube', 'tiktok']));
    const r = await J.runPublishJob('post1', { repo: off, hasAccess: () => false, publishers: live, clock: () => 1_000_000, schedule: async () => 'm' });
    assert.equal(r.status, 'cancelled');
    assert.ok(off.db.post.targets.every((t) => t.status === 'cancelled' && /turned off/.test(t.error)));
    assert.deepEqual(calls, []);
});

test('Instagram polling stops after about 5 minutes; YouTube upload without an id asks for a manual check', async () => {
    const t = { platform: 'instagram', status: 'publishing', state: { containerId: 'c', waitStartedAt: 0 } };
    const late = J.applyOutcome(t, { type: 'waiting', state: t.state, retryInSec: 60, maxWaitMs: IG.INSTAGRAM_MAX_WAIT_MS }, IG.INSTAGRAM_MAX_WAIT_MS + 1);
    assert.equal(late.status, 'failed');
    assert.match(late.error, /after 6 minutes/);
    const noId = fakeFetch([['PUT', 'upload_id=S1', { __status: 200, __body: {} }]]);
    await assert.rejects(YT.youtubePublisher.step({ post: { mode: 'publish' }, target: { state: { uploadUri: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=S1' } }, access: 't', media: media(), fetchImpl: noId, save: noSave }),
        (e) => e.retry === false && /YouTube Studio/.test(e.message));
});

// ---- TikTok Direct Post: content sharing guidelines

const CREATOR = Object.freeze({
    creator_nickname: 'Maker', creator_avatar_url: 'https://p16.tiktokcdn.com/a.jpg', creator_username: 'maker',
    privacy_level_options: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
    comment_disabled: false, duet_disabled: true, stitch_disabled: true, max_video_post_duration_sec: 60,
});
const tiktokAccount = (scopes = ['video.publish', 'video.upload'], status = 'active') => ({ _id: 'tt1', platform: 'tiktok', status, tokens: { scopes } });

test('TikTok creator info: the contract shape, and a plain reason whenever the creator cannot post', async () => {
    S.clearCreatorInfoCache();
    assert.deepEqual(TT.creatorInfoView(CREATOR), {
        nickname: 'Maker', avatarUrl: 'https://p16.tiktokcdn.com/a.jpg', privacyLevelOptions: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
        commentDisabled: false, duetDisabled: true, stitchDisabled: true, maxVideoPostDurationSec: 60, canPost: true,
    });
    assert.equal(TT.creatorInfoView({}).canPost, false);
    assert.match(TT.creatorInfoView({}).reason, /privacy options/);

    const load = (opts) => S.loadTikTokCreator({ providerAvailable: true, accessToken: async () => 'tok', ...opts });
    assert.match((await load({ account: null })).view.reason, /Connect your TikTok account/);
    assert.match((await load({ account: tiktokAccount(['video.publish'], 'needs_reauth') })).view.reason, /Reconnect your TikTok/);
    const draftsOnly = await load({ account: tiktokAccount(['video.upload']) });
    assert.equal(draftsOnly.view.canPost, false);
    assert.match(draftsOnly.view.reason, /allow posting.*Save as draft/);
    assert.match((await load({ account: tiktokAccount(), providerAvailable: false })).view.reason, /not available yet/);
    for (const [code, re] of [['spam_risk_too_many_posts', /daily posting limit/], ['spam_risk_user_banned_from_posting', /not letting this account post/], ['reached_active_user_cap', /daily limit for posting apps/]]) {
        const r = await load({ account: tiktokAccount(), cache: new Map(), fetchImpl: fakeFetch([['POST', '/creator_info/query/', { data: {}, error: { code } }]]) });
        assert.equal(r.view.canPost, false, code);
        assert.match(r.view.reason, re);
        assert.equal(r.creator, null);
    }
    assert.match((await load({ account: tiktokAccount(), cache: new Map(), fetchImpl: fakeFetch([['POST', '/creator_info/', { __status: 401, __body: { error: { code: 'access_token_invalid' } } }]]) })).view.reason, /Reconnect/);
    assert.match((await load({ account: tiktokAccount(), cache: new Map(), fetchImpl: async () => { throw new Error('ECONNRESET'); } })).view.reason, /did not answer/);
    const refused = await load({ account: tiktokAccount(), accessToken: async () => { throw Object.assign(new Error('x'), { reauth: true }); } });
    assert.match(refused.view.reason, /Reconnect/);

    // Fresh: reused for at most 30 s, then TikTok is asked again.
    const cache = new Map();
    const f = fakeFetch([['POST', '/creator_info/query/', { data: CREATOR, error: { code: 'ok' } }]]);
    const first = await load({ account: tiktokAccount(), cache, fetchImpl: f, now: 0 });
    assert.equal(first.view.canPost, true);
    assert.equal(first.creator.max_video_post_duration_sec, 60);
    await load({ account: tiktokAccount(), cache, fetchImpl: f, now: S.CREATOR_INFO_TTL_MS - 1 });
    assert.equal(f.calls.length, 1);
    await load({ account: tiktokAccount(), cache, fetchImpl: f, now: S.CREATOR_INFO_TTL_MS });
    assert.equal(f.calls.length, 2);
    assert.ok(S.CREATOR_INFO_TTL_MS <= 60_000);

    // Test mode: simulated creator, nothing sent to TikTok.
    const sim = await load({ account: null, dryRun: true, fetchImpl: async () => assert.fail('no TikTok call in test mode') });
    assert.equal(sim.view.canPost, true);
    assert.ok(sim.view.privacyLevelOptions.includes('SELF_ONLY'));
});

test('TikTok settings: every guideline rule is checked, with the field and a plain reason', () => {
    const audited = { TIKTOK_DIRECT_POST_AUDITED: 'true' };
    const v = (input, opts = {}) => S.validateTikTokSettings(input, CREATOR, { env: audited, ...opts });
    const ok = { privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: false, allowStitch: false, commercial: { enabled: false, yourBrand: true, brandedContent: false }, musicConfirmed: true };
    assert.deepEqual(v(ok), { ...ok, commercial: { enabled: false, yourBrand: false, brandedContent: false } }, 'disclosure off clears its boxes');
    const fails = (input, field, re, opts) => assert.throws(() => v(input, opts), (e) => e.statusCode === 400 && e.data?.field === field && re.test(e.message));
    fails(undefined, 'tiktok', /Choose your TikTok settings/);
    fails({ ...ok, privacyLevel: undefined }, 'tiktok.privacyLevel', /who can watch/, undefined);
    fails({ ...ok, privacyLevel: 'FOLLOWER_OF_CREATOR' }, 'tiktok.privacyLevel', /Everyone, Friends, Only me/);
    fails(ok, 'tiktok.privacyLevel', /can only be "Only me"/, { env: {} });
    assert.equal(v({ ...ok, privacyLevel: 'SELF_ONLY' }, { env: {} }).privacyLevel, 'SELF_ONLY', 'unaudited: Only me is allowed');
    fails({ ...ok, allowComment: undefined }, 'tiktok.allowComment', /allow comments/);
    fails({ ...ok, allowDuet: true }, 'tiktok.allowDuet', /turned duets off/);
    fails({ ...ok, allowStitch: true }, 'tiktok.allowStitch', /turned stitches off/);
    fails({ ...ok, commercial: undefined }, 'tiktok.commercial', /promotes a brand/);
    fails({ ...ok, commercial: { enabled: true, yourBrand: false, brandedContent: false } }, 'tiktok.commercial', /yourself, a third party, or both/);
    fails({ ...ok, privacyLevel: 'SELF_ONLY', commercial: { enabled: true, yourBrand: false, brandedContent: true } }, 'tiktok.commercial.brandedContent', /cannot be set to private/);
    assert.equal(v({ ...ok, commercial: { enabled: true, yourBrand: true, brandedContent: false }, privacyLevel: 'SELF_ONLY' }).commercial.yourBrand, true, 'your brand may be Only me');
    fails({ ...ok, musicConfirmed: 'yes' }, 'tiktok.musicConfirmed', /Music Usage Confirmation\.$/);
    fails({ ...ok, musicConfirmed: false, commercial: { enabled: true, yourBrand: false, brandedContent: true } }, 'tiktok.musicConfirmed', /Branded Content Policy and Music Usage/);
    fails(ok, 'media', /up to 60 seconds, and this one is 61/, { durationSec: 60.4 + 0.2 });
    assert.equal(v(ok, { durationSec: 60 }).privacyLevel, 'PUBLIC_TO_EVERYONE');
});

test('TikTok settings at create: required for Direct Post, refused when the creator cannot post, stamped when agreed', async () => {
    const media = { key: 'k', durationSec: 30 };
    const loadCreator = async () => ({ view: TT.creatorInfoView(CREATOR), creator: CREATOR });
    await assert.rejects(S.checkTikTokSettings({ userId: USER, input: undefined, media, now: 0, loadCreator }), (e) => e.statusCode === 400 && e.data.field === 'tiktok');
    const cannot = async () => ({ view: { canPost: false, reason: 'Your TikTok account reached its daily posting limit. Try again tomorrow.' }, creator: null });
    await assert.rejects(S.checkTikTokSettings({ userId: USER, input: TIKTOK_SETTINGS, media, now: 0, loadCreator: cannot }), (e) => e.statusCode === 400 && e.data.code === 'TIKTOK_CANNOT_POST' && /daily posting limit/.test(e.message));
    const saved = await S.checkTikTokSettings({ userId: USER, input: TIKTOK_SETTINGS, media, now: 5000, loadCreator });
    assert.deepEqual(saved, { ...TIKTOK_SETTINGS, confirmedAt: new Date(5000) });

    // Length comes from the export or the upload it was made from.
    const project = { source: { key: `editor/sources/${USER}/${PROJECT}/s.mp4`, durationSec: 95 }, renders: [{ key: `editor/renders/${USER}/${PROJECT}/r.mp4`, durationSec: 42.5 }, { key: `editor/renders/${USER}/${PROJECT}/old.mp4` }] };
    const findProject = async (id) => (id === PROJECT ? project : null);
    assert.equal(await S.mediaDurationSec(USER, `editor/renders/${USER}/${PROJECT}/r.mp4`, { findProject }), 42.5);
    assert.equal(await S.mediaDurationSec(USER, `editor/sources/${USER}/${PROJECT}/s.mp4`, { findProject }), 95);
    assert.equal(await S.mediaDurationSec(USER, `editor/renders/${USER}/${PROJECT}/old.mp4`, { findProject }), null, 'older exports: unknown');
    assert.equal(await S.mediaDurationSec(OTHER, `editor/renders/${USER}/${PROJECT}/r.mp4`, { findProject }), null);

    const p = await S.toPublicPost({ _id: 'p1', media: { key: 'k' }, targets: [{ platform: 'tiktok', status: 'pending', tiktok: { ...TIKTOK_SETTINGS, confirmedAt: new Date(0) } }, { platform: 'youtube', status: 'pending' }] }, { storageImpl: { presignDownload: async () => 'u' } });
    assert.deepEqual(p.targets[0], { platform: 'tiktok', tiktok: TIKTOK_SETTINGS, status: 'pending' }, 'targets echo the settings');
    assert.equal(p.targets[1].tiktok, undefined);
});

test('TikTok at publish time: fresh creator info; a privacy choice no longer offered fails, never changes', async () => {
    const run = (creatorReply, target = { platform: 'tiktok', accountId: 'tiktok', status: 'pending', attempts: 0, state: {}, tiktok: { ...TIKTOK_SETTINGS, privacyLevel: 'MUTUAL_FOLLOW_FRIENDS' } }) => {
        const repo = memoryRepo({ ...basePost(['tiktok']), targets: [target] });
        const f = fakeFetch([
            ['POST', '/creator_info/query/', creatorReply],
            ['POST', '/video/init/', { data: { publish_id: 'pub1', upload_url: 'https://open-upload.tiktokapis.com/u' }, error: { code: 'ok' } }],
            ['PUT', 'open-upload', { __status: 201, __body: null }],
            ['POST', '/status/fetch/', { data: { status: 'PROCESSING_UPLOAD' }, error: { code: 'ok' } }],
        ]);
        return J.runPublishJob('post1', { repo, hasAccess: () => true, dryRun: false, env: {}, clock: () => 1_000_000, media: () => media(MB), accessToken: async () => 'tok', fetchImpl: f, schedule: async () => 'm1' }).then((out) => ({ out, repo, f }));
    };
    const gone = await run({ data: { ...CREATOR, privacy_level_options: ['FOLLOWER_OF_CREATOR', 'SELF_ONLY'] }, error: { code: 'ok' } });
    assert.equal(gone.repo.db.post.targets[0].status, 'failed');
    assert.match(gone.repo.db.post.targets[0].error, /no longer offers the privacy setting you chose \("Friends"\).*never change/);
    assert.equal(gone.f.calls.filter((c) => c.url.includes('/video/init/')).length, 0, 'nothing sent');
    assert.equal(gone.out.status, 'failed');

    const capped = await run({ data: {}, error: { code: 'spam_risk_too_many_posts' } });
    assert.equal(capped.repo.db.post.targets[0].status, 'failed');
    assert.match(capped.repo.db.post.targets[0].error, /daily posting limit/);

    const missing = await run({ data: CREATOR, error: { code: 'ok' } }, { platform: 'tiktok', accountId: 'tiktok', status: 'pending', attempts: 0, state: {} });
    assert.match(missing.repo.db.post.targets[0].error, /no privacy choice/);
    assert.equal(missing.f.calls.length, 0, 'a post without the creator\'s choices never reaches TikTok');

    const okRun = await run({ data: CREATOR, error: { code: 'ok' } }, { platform: 'tiktok', accountId: 'tiktok', status: 'pending', attempts: 0, state: {}, tiktok: { ...TIKTOK_SETTINGS, allowComment: true } });
    const init = okRun.f.calls.find((c) => c.url.includes('/video/init/'));
    const info = JSON.parse(init.init.body).post_info;
    assert.deepEqual([info.privacy_level, info.disable_comment, info.disable_duet, info.brand_content_toggle, info.brand_organic_toggle], ['SELF_ONLY', false, true, false, false]);
    assert.equal(okRun.repo.db.post.targets[0].status, 'publishing');
    assert.deepEqual(okRun.repo.db.post.targets[0].tiktok, { ...TIKTOK_SETTINGS, allowComment: true }, 'settings survive the pass');
});

test('TikTok length: unknown length is read once from the file and stored; a video whose length cannot be read is refused', async () => {
    const loadCreator = async () => ({ view: TT.creatorInfoView(CREATOR), creator: CREATOR });
    const probes = [];
    const probeDuration = async (key) => { probes.push(key); return 42; };
    const known = { key: 'k', durationSec: 30 };
    await S.checkTikTokSettings({ userId: USER, input: TIKTOK_SETTINGS, media: known, now: 0, loadCreator, probeDuration });
    assert.equal(probes.length, 0, 'a stored length is used as is');
    const unknown = { key: 'k', durationSec: null };
    await S.checkTikTokSettings({ userId: USER, input: TIKTOK_SETTINGS, media: unknown, now: 0, loadCreator, probeDuration });
    assert.deepEqual([probes, unknown.durationSec], [['k'], 42], 'read once and kept on the post\'s media');
    const tooLong = { key: 'k', durationSec: null };
    await assert.rejects(S.checkTikTokSettings({ userId: USER, input: TIKTOK_SETTINGS, media: tooLong, now: 0, loadCreator, probeDuration: async () => Number(CREATOR.max_video_post_duration_sec) + 5 }),
        (e) => e.statusCode === 400 && e.data.field === 'media' && /Trim it/.test(e.message));
    await assert.rejects(S.checkTikTokSettings({ userId: USER, input: TIKTOK_SETTINGS, media: { key: 'k', durationSec: null }, now: 0, loadCreator, probeDuration: async () => null }),
        (e) => e.statusCode === 400 && e.data.field === 'media' && /could not check how long this video is/.test(e.message));

    // The probe: a short-lived signed URL, headers only, video containers only, no other protocols.
    let args;
    const storageImpl = { presignDownload: async (key, opts) => `https://vireact-media.s3.amazonaws.com/${key}?ttl=${opts.expiresIn}` };
    assert.equal(await S.probeMediaDurationSec('editor/renders/x.mp4', { storageImpl, ffprobeImpl: async (a) => { args = a; return { stdout: '61.250000\n' }; } }), 61.25);
    assert.equal(args.at(-1), 'https://vireact-media.s3.amazonaws.com/editor/renders/x.mp4?ttl=300');
    assert.deepEqual(args.slice(1, 7), ['error', '-protocol_whitelist', 'https,tls,tcp', '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm', '-show_entries']);
    assert.equal(await S.probeMediaDurationSec('k', { storageImpl, ffprobeImpl: async () => ({ stdout: 'N/A\n' }) }), null);
    assert.equal(await S.probeMediaDurationSec('k', { storageImpl, ffprobeImpl: async () => { throw new Error('ffprobe exited with 1'); } }), null);
});

test('TikTok edits: any change to a Direct Post needs the TikTok settings again, re-checked and re-stamped', async () => {
    const editing = (body, mode = 'publish', platforms = ['tiktok', 'youtube']) => S.tiktokInputForUpdate({ mode, platforms, body });
    const asksAgain = (e) => e.statusCode === 400 && e.data.field === 'tiktok' && /again/.test(e.message);
    assert.throws(() => editing({ caption: 'new caption' }), asksAgain, 'caption only');
    assert.throws(() => editing({ scheduledAt: '2030-01-01T00:00:00Z' }), asksAgain, 'time only');
    assert.throws(() => editing({ platforms: ['tiktok'] }), asksAgain);
    assert.throws(() => editing({ caption: 'x', tiktok: null }), asksAgain);
    assert.deepEqual(editing({ caption: 'x', tiktok: TIKTOK_SETTINGS }), TIKTOK_SETTINGS);
    assert.equal(editing({}), null, 'nothing to change');
    assert.equal(editing({ caption: 'x' }, 'draft'), null, 'drafts are finished in the TikTok app');
    assert.equal(editing({ caption: 'x' }, 'publish', ['youtube']), null, 'TikTok removed');

    // Caption-only PATCH of a stored post: fresh (test-mode) creator_info, new consent time, nothing else lost.
    const { ScheduledPost } = await import('../src/model/scheduled-post.model.js');
    const { ConnectedAccount } = await import('../src/model/connected-account.model.js');
    const stored = {
        _id: '0123456789abcdef01234567', userId: USER, status: 'scheduled', mode: 'publish', dryRun: true, scheduleVersion: 1, caption: 'old',
        scheduledAt: new Date('2030-01-01T00:00:00Z'), media: { key: 'k', durationSec: 30 },
        targets: [{ platform: 'tiktok', accountId: 'acc', status: 'pending', tiktok: { ...TIKTOK_SETTINGS, confirmedAt: new Date(0) } }],
    };
    let saved = null;
    ScheduledPost.findOne = () => ({ lean: async () => stored });
    ScheduledPost.findOneAndUpdate = async (filter, update) => { saved = update.$set; return { ...stored, ...update.$set }; };
    ConnectedAccount.findOne = () => ({ lean: async () => null });
    try {
        await assert.rejects(S.updateScheduledPost(USER, stored._id, { caption: 'new' }, { now: 9000, dryRun: true }), asksAgain);
        assert.equal(saved, null, 'nothing saved without the settings');
        await S.updateScheduledPost(USER, stored._id, { caption: 'new', tiktok: { ...TIKTOK_SETTINGS, allowComment: true } }, { now: 9000, dryRun: true });
        assert.equal(saved.caption, 'new');
        assert.deepEqual(saved.targets[0].tiktok, { ...TIKTOK_SETTINGS, allowComment: true, confirmedAt: new Date(9000) });
        assert.equal(saved.targets[0].status, 'pending');
        await assert.rejects(S.updateScheduledPost(USER, stored._id, { caption: 'new', tiktok: { ...TIKTOK_SETTINGS, privacyLevel: 'FOLLOWER_OF_CREATOR' } }, { now: 9000, dryRun: true }),
            (e) => e.statusCode === 400 && e.data.field === 'tiktok.privacyLevel', 'checked against the creator\'s options today');
    } finally {
        delete ScheduledPost.findOne;
        delete ScheduledPost.findOneAndUpdate;
        delete ConnectedAccount.findOne;
    }
});
