import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.OWNER_SIGNIN_LIMIT = '1000';
process.env.ADMIN_API_KEY = 'owner-test-admin-key-0123456789abcdef';
process.env.ADMIN_SESSION_SECRET = 'owner-test-session-secret-0123456789abcdef0123';
console.warn = () => {};
console.log = () => {};

const { connectTestDb, disconnectTestDb } = await import('./helpers/test-db.js');
const { OwnerSession, OwnerAudit } = await import('../src/model/owner-security.model.js');
const { GLOBAL_FAILURE_LIMIT } = await import('../src/service/owner-auth.service.js');
const { User } = await import('../src/model/user.model.js');
const { Video } = await import('../src/model/video.model.js');
const { Chat } = await import('../src/model/chat.model.js');

const KEY = process.env.ADMIN_API_KEY;
let server;
let base;

before(async () => {
    await connectTestDb();
    const express = (await import('express')).default;
    const cors = (await import('cors')).default;
    const cookieParser = (await import('cookie-parser')).default;
    const { stripSameOriginHeader } = await import('../src/middleware/same-origin.js');
    const ownerRoutes = (await import('../src/route/owner.routes.js')).default;
    const adminUiRoutes = (await import('../src/route/admin-ui.routes.js')).default;
    const { errorHandler } = await import('../src/middleware/errorHandler.js');
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(stripSameOriginHeader);
    app.use(cors({
        origin: (origin, cb) => (!origin || origin === 'https://www.vireact.io' ? cb(null, true) : cb(new Error('Not allowed by CORS'))),
        credentials: true,
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-admin-key'],
    }));
    app.use('/admin', adminUiRoutes);
    app.use('/api/v1/owner', ownerRoutes);
    app.use(errorHandler);
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
    await Promise.all([OwnerSession.deleteMany({}), OwnerAudit.deleteMany({})]);
});
after(async () => {
    await new Promise((r) => server.close(r));
    await Promise.all([OwnerSession.deleteMany({}), OwnerAudit.deleteMany({})]);
    await disconnectTestDb();
});

const H = { 'X-Vireact-Owner': '1', 'Content-Type': 'application/json' };
const call = (path, { method = 'GET', body, headers = H, cookie } = {}) => fetch(`${base}/api/v1/owner${path}`, {
    method, headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
});
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie') });
const signInFresh = async () => {
    const login = await json(await call('/session/login', { method: 'POST', body: { key: KEY } }));
    assert.equal(login.status, 200, JSON.stringify(login.body));
    return login.cookie.split(';')[0];
};

test('the page holds no data and is locked down', async () => {
    const res = await fetch(`${base}/admin/videos`);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const html = await res.text();
    assert.doesNotMatch(html, /<script>(?!<\/script>)/, 'no inline script');
});

test('the API refuses other sites and requests without the console header', async () => {
    assert.equal((await call('/session', { headers: {} })).status, 403);
    assert.equal((await call('/session', { headers: { ...H, Origin: 'https://www.vireact.io' } })).status, 403);
    assert.equal((await call('/session', { headers: { ...H, 'Sec-Fetch-Site': 'same-site' } })).status, 403);
    const ok = await json(await call('/session'));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.configured, true);
    assert.doesNotMatch(JSON.stringify(ok.body), /owner-test-admin-key|owner-test-session-secret/, 'no secrets reach the page');
});

test('sign-in needs the admin key; data needs the session; cookie is httpOnly and same-site only', async () => {
    assert.equal((await call('/videos')).status, 401);
    assert.equal((await call('/overview', { cookie: 'vx_owner=forged-session-id' })).status, 401, 'a made-up cookie gets nothing');
    const bad = await json(await call('/session/login', { method: 'POST', body: { key: 'wrong' } }));
    assert.equal(bad.status, 401);
    assert.equal(bad.cookie, null);
    assert.ok(await OwnerAudit.exists({ action: 'login', ok: false }));
    assert.equal((await call('/session/login', { method: 'POST', body: {} })).status, 401);
    const login = await json(await call('/session/login', { method: 'POST', body: { key: KEY } }));
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.match(login.cookie, /vx_owner=/);
    assert.match(login.cookie, /HttpOnly/i);
    assert.match(login.cookie, /SameSite=Strict/i);
    assert.doesNotMatch(JSON.stringify(login.body), /owner-test-admin-key/);
    const cookie = login.cookie.split(';')[0];
    assert.equal((await json(await call('/videos', { cookie }))).status, 200);
    assert.equal((await call('/videos', { cookie, headers: { ...H, Origin: 'https://www.vireact.io' } })).status, 403);
    const stored = await OwnerSession.findOne({}).sort({ createdAt: -1 }).lean();
    assert.notEqual(stored.sidHash, cookie.split('=')[1], 'only a keyed hash of the session id is stored');
    assert.equal((await call('/session/code', { method: 'POST', body: { key: KEY } })).status, 401, 'the SMS step is gone');
    await OwnerAudit.deleteMany({ ok: false });
});

test('one video shows input and outputs, never password or tokens, and the view is logged', async () => {
    const cookie = await signInFresh();
    const user = await User.create({ name: 'Creator', email: `owner-test-${Date.now()}@example.invalid`, password: 'pw-123456', isEmailVerified: true, refreshToken: 'secret-refresh' });
    const video = await Video.create({
        filename: 'my clip.mp4', fileSize: 1000, uploadStatus: 'completed', analysisStatus: 'completed', uploader_id: user._id, viralityScore: 72,
        analysis: [{ feature: 'hook', score: 70, feedback: 'Strong open' }],
        scriptSuggestions: { generatedAt: new Date(), generationCount: 1, version: 2, targetSeconds: 20, options: [{ id: 'script_1', title: 'Score first', hookLine: 'Hi', beats: [], cta: '', whyItWorks: '', angle: '' }] },
    });
    await Chat.create({ videoId: video._id, userId: user._id, messages: [{ text: '<img src=x onerror=alert(1)>', isUser: true }, { text: 'Cut the pause at 0:07.', isUser: false }] });

    const list = await json(await call(`/videos?q=${encodeURIComponent(user.email)}`, { cookie }));
    assert.equal(list.body.data.rows.length, 1);
    const detail = await json(await call(`/videos/${video._id}`, { cookie }));
    assert.equal(detail.status, 200);
    assert.doesNotMatch(JSON.stringify(detail.body), /secret-refresh|pw-123456|"password"|refreshToken|passwordReset|emailVerificationToken/);
    assert.equal(detail.body.data.chat.messages.length, 2);
    assert.ok(await OwnerAudit.exists({ action: 'view_video', videoId: String(video._id) }));
    const userDetail = await json(await call(`/users/${user._id}`, { cookie }));
    assert.doesNotMatch(JSON.stringify(userDetail.body), /secret-refresh|"password"|refreshToken/);
    assert.equal((await call('/videos/not-an-id', { cookie })).status, 404);
    assert.equal((await call('/overview', { cookie })).status, 200);
    assert.equal((await call('/audit', { cookie })).status, 200);
    const learning = await json(await call('/learning', { cookie }));
    assert.equal(learning.status, 200);
    assert.equal(learning.body.data.reportCard.ownerCases.length, 2);
    assert.equal((await call('/learning')).status, 401, 'learning data needs the session too');
});

test('sessions end after 30 minutes idle and on sign-out', async () => {
    const cookie = await signInFresh();
    await OwnerSession.updateMany({ revokedAt: null }, { $set: { lastSeenAt: new Date(Date.now() - 31 * 60 * 1000) } });
    assert.equal((await call('/videos', { cookie })).status, 401, 'idle session is closed');
    const c = await signInFresh();
    assert.equal((await call('/overview', { cookie: c })).status, 200);
    assert.equal((await call('/session/logout', { method: 'POST', cookie: c })).status, 200);
    assert.equal((await call('/overview', { cookie: c })).status, 401);
});

test('too many failed attempts lock sign-in for everyone', async () => {
    await OwnerAudit.insertMany(Array.from({ length: GLOBAL_FAILURE_LIMIT }, () => ({ action: 'login', ok: false, detail: 'bad code' })));
    assert.equal((await call('/session/login', { method: 'POST', body: { key: KEY } })).status, 429, 'even the right key waits out the lock');
    await OwnerAudit.deleteMany({ ok: false });
});

test('switched off (fails closed) until every setting is present; names only are reported', async () => {
    const saved = process.env.ADMIN_SESSION_SECRET;
    process.env.ADMIN_SESSION_SECRET = 'too-short';
    try {
        const s = await json(await call('/session'));
        assert.equal(s.body.data.configured, false);
        assert.deepEqual(s.body.data.missing, ['ADMIN_SESSION_SECRET']);
        assert.doesNotMatch(JSON.stringify(s.body), /too-short|owner-test-admin-key/);
        assert.equal((await call('/session/login', { method: 'POST', body: { key: KEY } })).status, 503);
    } finally {
        process.env.ADMIN_SESSION_SECRET = saved;
    }
});
