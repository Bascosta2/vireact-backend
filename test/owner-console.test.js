import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
process.env.OWNER_SIGNIN_LIMIT = '1000';
process.env.ADMIN_API_KEY = 'owner-test-admin-key-0123456789abcdef';
process.env.ADMIN_SESSION_SECRET = 'owner-test-session-secret-0123456789abcdef0123';
process.env.ADMIN_OWNER_PHONE = '+15550001234';
process.env.TWILIO_ACCOUNT_SID = `AC${'1'.repeat(32)}`;
process.env.TWILIO_AUTH_TOKEN = 'test-token-0123456789abcdef';
process.env.TWILIO_VERIFY_SERVICE_SID = `VA${'2'.repeat(32)}`;
console.warn = () => {};
console.log = () => {};

const { connectTestDb, disconnectTestDb } = await import('./helpers/test-db.js');
const { OwnerSession, OwnerAudit } = await import('../src/model/owner-security.model.js');
const { GLOBAL_FAILURE_LIMIT, SMS_SEND_LIMIT, maskPhone, ownerPhone } = await import('../src/service/owner-auth.service.js');
const { setVerifyClientForTests } = await import('../src/lib/twilio-verify.js');
const { User } = await import('../src/model/user.model.js');
const { Video } = await import('../src/model/video.model.js');
const { Chat } = await import('../src/model/chat.model.js');

const KEY = process.env.ADMIN_API_KEY;
let server;
let base;

/** Fake Twilio Verify: remembers who was texted and approves only the last code sent, once. */
const sms = { sent: [], code: null, fail: false };
setVerifyClientForTests({
    async send(to) {
        if (sms.fail) return false;
        sms.sent.push(to);
        sms.code = String(100000 + sms.sent.length);
        return true;
    },
    async check(to, code) {
        const ok = to === process.env.ADMIN_OWNER_PHONE && code === sms.code;
        if (ok) sms.code = null; // single use
        return ok;
    },
});

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
    setVerifyClientForTests(null);
    await new Promise((r) => server.close(r));
    await Promise.all([OwnerSession.deleteMany({}), OwnerAudit.deleteMany({})]);
    await disconnectTestDb();
});
beforeEach(() => { sms.fail = false; });

const H = { 'X-Vireact-Owner': '1', 'Content-Type': 'application/json' };
const call = (path, { method = 'GET', body, headers = H, cookie } = {}) => fetch(`${base}/api/v1/owner${path}`, {
    method, headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
});
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get('set-cookie') });
const clearSends = () => OwnerAudit.deleteMany({ action: 'sms_send' });
const signInFresh = async () => {
    await clearSends();
    assert.equal((await call('/session/code', { method: 'POST', body: { key: KEY } })).status, 200);
    const login = await json(await call('/session/login', { method: 'POST', body: { key: KEY, code: sms.code } }));
    assert.equal(login.status, 200, JSON.stringify(login.body));
    return login.cookie.split(';')[0];
};

test('phone setting: E.164 only, shown masked', () => {
    assert.equal(ownerPhone(), '+15550001234');
    assert.equal(maskPhone('+15550001234'), '•••-•••-1234');
    const saved = process.env.ADMIN_OWNER_PHONE;
    process.env.ADMIN_OWNER_PHONE = '(561) 702-0000';
    assert.equal(ownerPhone(), null, 'needs the +country code');
    process.env.ADMIN_OWNER_PHONE = '+1 561-702-0000';
    assert.equal(ownerPhone(), '+15617020000', 'spaces and dashes are fine');
    process.env.ADMIN_OWNER_PHONE = saved;
});

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
    assert.equal(ok.body.data.phoneHint, '•••-•••-1234');
    assert.doesNotMatch(JSON.stringify(ok.body), /5550001234/, 'the full number is never sent to the page');
});

test('no text is sent without the admin key, and codes only go to the configured phone', async () => {
    const before = sms.sent.length;
    const bad = await json(await call('/session/code', { method: 'POST', body: { key: 'nope' } }));
    assert.equal(bad.status, 401);
    assert.equal(sms.sent.length, before, 'wrong key: no text');
    assert.ok(await OwnerAudit.exists({ action: 'sms_send', ok: false }));

    const sent = await json(await call('/session/code', { method: 'POST', body: { key: KEY, phone: '+19995550000', to: '+19995550000' } }));
    assert.equal(sent.status, 200);
    assert.equal(sent.body.data.sentTo, '•••-•••-1234');
    assert.equal(sms.sent.at(-1), '+15550001234', 'a number in the request is ignored');
});

test('sign-in needs the key and the texted code; codes work once; data needs the session', async () => {
    assert.equal((await call('/videos')).status, 401);
    await clearSends();
    await call('/session/code', { method: 'POST', body: { key: KEY } });
    const code = sms.code;
    assert.equal((await call('/session/login', { method: 'POST', body: { key: 'wrong', code } })).status, 401);
    assert.equal((await call('/session/login', { method: 'POST', body: { key: KEY, code: '000000' } })).status, 401);
    const login = await json(await call('/session/login', { method: 'POST', body: { key: KEY, code } }));
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.match(login.cookie, /vx_owner=/);
    assert.match(login.cookie, /HttpOnly/i);
    assert.match(login.cookie, /SameSite=Strict/i);
    const cookie = login.cookie.split(';')[0];
    assert.equal((await call('/session/login', { method: 'POST', body: { key: KEY, code } })).status, 401, 'same code twice');
    assert.equal((await json(await call('/videos', { cookie }))).status, 200);
    assert.equal((await call('/videos', { cookie, headers: { ...H, Origin: 'https://www.vireact.io' } })).status, 403);
});

test('texts are capped at 5 per 15 minutes, and provider failures are reported', async () => {
    await clearSends();
    for (let i = 0; i < SMS_SEND_LIMIT; i++) assert.equal((await call('/session/code', { method: 'POST', body: { key: KEY } })).status, 200);
    const capped = await json(await call('/session/code', { method: 'POST', body: { key: KEY } }));
    assert.equal(capped.status, 429);
    await clearSends();
    sms.fail = true;
    assert.equal((await call('/session/code', { method: 'POST', body: { key: KEY } })).status, 502);
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
    const before = sms.sent.length;
    assert.equal((await call('/session/code', { method: 'POST', body: { key: KEY } })).status, 429);
    assert.equal(sms.sent.length, before, 'no text while locked');
    assert.equal((await call('/session/login', { method: 'POST', body: { key: KEY, code: '123456' } })).status, 429);
    await OwnerAudit.deleteMany({ ok: false });
});

test('switched off (fails closed) until every setting is present; names only are reported', async () => {
    const saved = process.env.TWILIO_VERIFY_SERVICE_SID;
    delete process.env.TWILIO_VERIFY_SERVICE_SID;
    try {
        const s = await json(await call('/session'));
        assert.equal(s.body.data.configured, false);
        assert.ok(s.body.data.missing.some((m) => m.includes('TWILIO_VERIFY_SERVICE_SID')));
        assert.doesNotMatch(JSON.stringify(s.body), /test-token|owner-test-admin-key/);
        assert.equal((await call('/session/code', { method: 'POST', body: { key: KEY } })).status, 503);
        assert.equal((await call('/session/login', { method: 'POST', body: { key: KEY, code: '123456' } })).status, 503);
    } finally {
        process.env.TWILIO_VERIFY_SERVICE_SID = saved;
    }
});
