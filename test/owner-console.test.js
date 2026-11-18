import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.OWNER_SIGNIN_LIMIT = '1000';
process.env.ADMIN_API_KEY = 'owner-test-admin-key-0123456789abcdef';
process.env.ADMIN_SESSION_SECRET = 'owner-test-session-secret-0123456789abcdef0123';
delete process.env.ADMIN_TOTP_RESET;
console.warn = () => {};
console.log = () => {};

const { connectTestDb, disconnectTestDb } = await import('./helpers/test-db.js');
const { OwnerSecurity, OwnerSession, OwnerAudit } = await import('../src/model/owner-security.model.js');
const { totpCode, base32Decode, base32Encode, verifyTotp, GLOBAL_FAILURE_LIMIT } = await import('../src/service/owner-auth.service.js');
const { User } = await import('../src/model/user.model.js');
const { Video } = await import('../src/model/video.model.js');
const { Chat } = await import('../src/model/chat.model.js');

const KEY = process.env.ADMIN_API_KEY;
let server;
let base;

// Same middleware order as src/app.js (importing app.js opens extra connections).
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
});
after(async () => {
    await new Promise((r) => server.close(r));
    await Promise.all([OwnerSecurity.deleteMany({}), OwnerSession.deleteMany({}), OwnerAudit.deleteMany({})]);
    await disconnectTestDb();
});
beforeEach(() => { delete process.env.ADMIN_TOTP_RESET; });

const H = { 'X-Vireact-Owner': '1', 'Content-Type': 'application/json' };
const call = (path, { method = 'GET', body, headers = H, cookie } = {}) => fetch(`${base}/api/v1/owner${path}`, {
    method, headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
});
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie') });
const nowCode = (secretB32, offsetSteps = 0) => totpCode(base32Decode(secretB32), Math.floor(Date.now() / 30000) + offsetSteps);

test('TOTP matches the RFC 6238 test vector and base32 round-trips', () => {
    const secret = Buffer.from('12345678901234567890');
    assert.equal(totpCode(secret, 1), '287082'); // RFC 6238, T = 59 s, last 6 digits of 94287082
    assert.equal(totpCode(secret, 37037036), '081804'); // T = 1111111109
    assert.deepEqual(base32Decode(base32Encode(secret)), secret);
    assert.equal(verifyTotp(secret, '287082', { now: 59 * 1000 }), 1);
    assert.equal(verifyTotp(secret, '287082', { now: 59 * 1000, afterCounter: 1 }), null, 'a used step is refused');
    assert.equal(verifyTotp(secret, '12345', { now: 59 * 1000 }), null);
});

test('the page holds no data and is locked down', async () => {
    const res = await fetch(`${base}/admin/videos`);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('x-robots-tag'), /noindex/);
    const html = await res.text();
    assert.doesNotMatch(html, /<script>(?!<\/script>)/, 'no inline script');
    assert.equal((await fetch(`${base}/admin/videos/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/admin/videos/hls.js`)).status, 200);
});

test('the API refuses other sites and requests without the console header', async () => {
    assert.equal((await call('/session', { headers: {} })).status, 403, 'no console header');
    assert.equal((await call('/session', { headers: { ...H, Origin: 'https://www.vireact.io' } })).status, 403, 'the web app origin is not allowed here');
    assert.equal((await call('/session', { headers: { ...H, 'Sec-Fetch-Site': 'same-site' } })).status, 403);
    const ok = await json(await call('/session'));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.configured, true);
});

let secretB32;
let cookie;

test('setup: wrong key refused and logged; key + code links one authenticator, then setup closes', async () => {
    const bad = await json(await call('/session/enroll/start', { method: 'POST', body: { key: 'nope' } }));
    assert.equal(bad.status, 401);
    assert.ok(await OwnerAudit.exists({ action: 'enroll_start', ok: false }));

    const start = await json(await call('/session/enroll/start', { method: 'POST', body: { key: KEY } }));
    assert.equal(start.status, 200);
    secretB32 = start.body.data.secret;
    assert.match(start.body.data.otpauthUrl, /^otpauth:\/\/totp\//);
    const stored = await OwnerSecurity.findById('owner').lean();
    assert.ok(stored.pendingTotp?.data && !JSON.stringify(stored).includes(secretB32), 'secret stored encrypted only');

    assert.equal((await call('/session/enroll/confirm', { method: 'POST', body: { key: KEY, code: '000000' } })).status, 401);
    const confirm = await json(await call('/session/enroll/confirm', { method: 'POST', body: { key: KEY, code: nowCode(secretB32) } }));
    assert.equal(confirm.status, 200);

    const again = await json(await call('/session/enroll/start', { method: 'POST', body: { key: KEY } }));
    assert.equal(again.status, 409, 'a second authenticator cannot be added');
    const status = await json(await call('/session'));
    assert.deepEqual([status.body.data.enrolled, status.body.data.setupOpen, status.body.data.signedIn], [true, false, false]);
});

test('sign-in needs both factors; data needs the session', async () => {
    assert.equal((await call('/videos')).status, 401, 'no session, no data');
    assert.equal((await call('/session/login', { method: 'POST', body: { key: 'wrong', code: nowCode(secretB32, 1) } })).status, 401);
    assert.equal((await call('/session/login', { method: 'POST', body: { key: KEY, code: '123456' } })).status, 401);

    // The setup code's step is used; take the next one.
    const login = await json(await call('/session/login', { method: 'POST', body: { key: KEY, code: nowCode(secretB32, 1) } }));
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.match(login.cookie, /vx_owner=/);
    assert.match(login.cookie, /HttpOnly/i);
    assert.match(login.cookie, /SameSite=Strict/i);
    cookie = login.cookie.split(';')[0];

    const reuse = await call('/session/login', { method: 'POST', body: { key: KEY, code: nowCode(secretB32, 1) } });
    assert.equal(reuse.status, 401, 'the same code cannot open a second session');

    const list = await json(await call('/videos', { cookie }));
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.data.rows));
    assert.equal((await call('/videos', { cookie, headers: { ...H, Origin: 'https://www.vireact.io' } })).status, 403, 'a valid cookie does not help another site');
});

test('one video shows input and outputs, never password or tokens, and the view is logged', async () => {
    const user = await User.create({ name: 'Creator', email: `owner-test-${Date.now()}@example.invalid`, password: 'pw-123456', isEmailVerified: true, refreshToken: 'secret-refresh' });
    const video = await Video.create({
        filename: 'my clip.mp4', fileSize: 1000, uploadStatus: 'completed', analysisStatus: 'completed', uploader_id: user._id, viralityScore: 72,
        analysis: [{ feature: 'hook', score: 70, feedback: 'Strong open' }],
        scriptSuggestions: { generatedAt: new Date(), generationCount: 1, version: 2, targetSeconds: 20, options: [{ id: 'script_1', title: 'Score first', hookLine: 'Hi', beats: [], cta: '', whyItWorks: '', angle: '' }] },
    });
    await Chat.create({ videoId: video._id, userId: user._id, messages: [{ text: '<img src=x onerror=alert(1)>', isUser: true }, { text: 'Cut the pause at 0:07.', isUser: false }] });

    const list = await json(await call(`/videos?q=${encodeURIComponent(user.email)}`, { cookie }));
    assert.equal(list.body.data.rows.length, 1);
    assert.equal(list.body.data.rows[0].chat.fromUser, 1);

    const detail = await json(await call(`/videos/${video._id}`, { cookie }));
    assert.equal(detail.status, 200);
    const text = JSON.stringify(detail.body);
    assert.doesNotMatch(text, /secret-refresh|pw-123456|"password"|refreshToken|passwordReset|emailVerificationToken/);
    assert.equal(detail.body.data.chat.messages.length, 2);
    assert.equal(detail.body.data.video.scriptSuggestions.options[0].title, 'Score first');
    assert.ok(await OwnerAudit.exists({ action: 'view_video', videoId: String(video._id) }));

    const userDetail = await json(await call(`/users/${user._id}`, { cookie }));
    assert.equal(userDetail.status, 200);
    assert.doesNotMatch(JSON.stringify(userDetail.body), /secret-refresh|"password"|refreshToken/);
    assert.equal((await call('/videos/not-an-id', { cookie })).status, 404);
    assert.equal((await call('/overview', { cookie })).status, 200);
    assert.equal((await call('/audit', { cookie })).status, 200);
});

test('sessions end after 30 minutes idle and on sign-out', async () => {
    await OwnerSession.updateMany({ revokedAt: null }, { $set: { lastSeenAt: new Date(Date.now() - 31 * 60 * 1000) } });
    assert.equal((await call('/videos', { cookie })).status, 401, 'idle session is closed');

    // Every code in this 30 s window is used by now; forget that so a fresh sign-in is possible.
    await OwnerSecurity.updateOne({ _id: 'owner' }, { $set: { lastTotpCounter: 0 } });
    const fresh = await json(await call('/session/login', { method: 'POST', body: { key: KEY, code: nowCode(secretB32, 0) } }));
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    const c = fresh.cookie.split(';')[0];
    assert.equal((await call('/overview', { cookie: c })).status, 200);
    assert.equal((await call('/session/logout', { method: 'POST', cookie: c })).status, 200);
    assert.equal((await call('/overview', { cookie: c })).status, 401, 'signed out on the server');
});

test('too many failed attempts lock sign-in for everyone', async () => {
    await OwnerAudit.insertMany(Array.from({ length: GLOBAL_FAILURE_LIMIT }, () => ({ action: 'login', ok: false, detail: 'bad code' })));
    const locked = await json(await call('/session/login', { method: 'POST', body: { key: KEY, code: '111111' } }));
    assert.equal(locked.status, 429);
    assert.equal(locked.body.data?.code ?? locked.body.code ?? 'OWNER_LOCKED', 'OWNER_LOCKED');
    await OwnerAudit.deleteMany({ ok: false });
});

test('a lost phone can be replaced only when ADMIN_TOTP_RESET=true', async () => {
    process.env.ADMIN_TOTP_RESET = 'true';
    const start = await json(await call('/session/enroll/start', { method: 'POST', body: { key: KEY } }));
    assert.equal(start.status, 200);
});

test('switched off without ADMIN_SESSION_SECRET', async () => {
    const saved = process.env.ADMIN_SESSION_SECRET;
    process.env.ADMIN_SESSION_SECRET = 'short';
    try {
        const s = await json(await call('/session'));
        assert.equal(s.body.data.configured, false);
        assert.equal((await call('/session/login', { method: 'POST', body: { key: KEY, code: '123456' } })).status, 503);
    } finally {
        process.env.ADMIN_SESSION_SECRET = saved;
    }
});
