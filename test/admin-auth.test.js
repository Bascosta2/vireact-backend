import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { isValidAdminKey, adminAuth, ADMIN_RATE_LIMIT } from '../src/middleware/adminAuth.js';
import { signup, verifyEmail, login, logout, refreshToken, confirmEmailChange } from '../src/controller/auth.controller.js';
import { signToken, TOKEN_TYPE } from '../src/utils/jwt.js';
import { updateProfile, updatePassword } from '../src/controller/profile.controller.js';
import { maskEmail, buildEmailChangeConfirmEmail, buildEmailChangeNoticeEmail, EMAIL_CHANGE_TTL_MS } from '../src/service/auth.service.js';
import { createEarlyAccessService } from '../src/service/early-access.service.js';
import { EarlyAccess } from '../src/model/early-access.model.js';
import { AUTH_RATE_LIMITS } from '../src/constants.js';
import crypto from 'node:crypto';
import { User } from '../src/model/user.model.js';
import { Admin } from '../src/model/admin.model.js';
import { hashRefreshToken } from '../src/utils/refresh-token-hash.js';
import resend from '../src/lib/resend.js';
import { fakeRes } from './helpers/test-db.js';

const KEY = 'k'.repeat(48);

test('isValidAdminKey: exact match only, empty expected key never validates', () => {
    assert.ok(isValidAdminKey(KEY, KEY));
    assert.ok(isValidAdminKey(`  ${KEY} `, KEY));
    assert.ok(!isValidAdminKey(KEY + 'x', KEY));
    assert.ok(!isValidAdminKey('', KEY));
    assert.ok(!isValidAdminKey(undefined, KEY));
    assert.ok(!isValidAdminKey(['array'], KEY));
    assert.ok(!isValidAdminKey('', ''));
    assert.ok(!isValidAdminKey('anything', ''));
});

test('adminAuth middleware rejects a missing or wrong key with 401', () => {
    const prev = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = KEY;
    try {
        for (const headers of [{}, { 'x-admin-key': 'wrong' }]) {
            const res = fakeRes();
            let called = false;
            adminAuth({ headers }, res, () => { called = true; });
            assert.equal(res.statusCode, 401);
            assert.equal(called, false);
        }
        let called = false;
        adminAuth({ headers: { 'x-admin-key': KEY } }, fakeRes(), () => { called = true; });
        assert.ok(called);
    } finally {
        process.env.ADMIN_API_KEY = prev;
    }
});

test('POST /auth/signup with role=admin returns 404, even with a valid admin key', async () => {
    const prev = process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEY = KEY;
    try {
        for (const headers of [{}, { 'x-admin-key': 'wrong' }, { 'x-admin-key': KEY }]) {
            let err;
            const res = fakeRes();
            await signup(
                { body: { role: 'admin', name: 'x', email: 'x@example.invalid', password: 'pw-123456' }, headers },
                res,
                (e) => { err = e; }
            );
            assert.equal(err?.statusCode, 404);
            assert.equal(res.body, undefined);
        }
    } finally {
        process.env.ADMIN_API_KEY = prev;
    }
});

test('admin routes are rate limited to 30 requests per minute per IP', () => {
    assert.equal(ADMIN_RATE_LIMIT.windowMs, 60 * 1000);
    assert.equal(ADMIN_RATE_LIMIT.max, 30);
});

/** Replace User.findOne for one test and record every filter it receives (no database needed). */
const spyUserFindOne = () => {
    const calls = [];
    const original = User.findOne;
    User.findOne = (filter) => { calls.push(filter); throw new Error('findOne must not be reached'); };
    return { calls, restore: () => { User.findOne = original; } };
};

test('POST /auth/verify-email rejects an operator object or malformed token (body or query) with 400 before any query', async () => {
    const spy = spyUserFindOne();
    try {
        for (const token of [{ $ne: null }, { $gt: '' }, ['a'.repeat(64)], 'a'.repeat(63), 'A'.repeat(64)]) {
            for (const req of [{ body: { token }, query: {} }, { body: {}, query: { token } }]) {
                let err;
                const res = fakeRes();
                await verifyEmail(req, res, (e) => { err = e; });
                assert.equal(err?.statusCode, 400, `token ${JSON.stringify(token)}`);
                assert.equal(res.body, undefined);
            }
        }
        assert.deepEqual(spy.calls, []);
    } finally {
        spy.restore();
    }
});

test('user login rejects a non-string email or password with 400 before any query', async () => {
    const spy = spyUserFindOne();
    try {
        for (const [email, password] of [[{ $ne: null }, 'pw-123456'], ['a@example.invalid', { $ne: null }]]) {
            let err;
            const res = fakeRes();
            await login({ body: { role: 'user', email, password } }, res, (e) => { err = e; });
            assert.equal(err?.statusCode, 400);
            assert.equal(res.body, undefined);
        }
        assert.deepEqual(spy.calls, []);
    } finally {
        spy.restore();
    }
});

// Logout and refresh, with the database calls recorded instead of made.
const originalStatics = {
    User: { exists: User.exists, updateOne: User.updateOne, findById: User.findById },
    Admin: { exists: Admin.exists, updateOne: Admin.updateOne },
};
afterEach(() => {
    Object.assign(User, originalStatics.User);
    Object.assign(Admin, originalStatics.Admin);
});

/** Records every update and answers exists() from the given ids. */
const recordDb = ({ userIds = [], adminIds = [] } = {}) => {
    const calls = [];
    User.exists = async ({ _id }) => (userIds.includes(String(_id)) ? { _id } : null);
    Admin.exists = async ({ _id }) => (adminIds.includes(String(_id)) ? { _id } : null);
    User.updateOne = async (filter, update) => { calls.push(['User', filter, update]); return { modifiedCount: 1 }; };
    Admin.updateOne = async (filter, update) => { calls.push(['Admin', filter, update]); return { modifiedCount: 1 }; };
    return calls;
};

const runLogout = async (req) => {
    const res = fakeRes();
    let err;
    await logout({ body: {}, cookies: {}, user: null, ...req }, res, (e) => { err = e; });
    return { res, err };
};

const assertSignedOut = ({ res, err }) => {
    assert.equal(err, undefined);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.cleared.sort(), ['accessToken', 'refreshToken']);
};

test('logout: an admin is revoked server-side whatever role the body claims', async () => {
    const admin = new Admin({ name: 'A', email: 'a@example.invalid', password: 'x' });
    const cookie = signToken(TOKEN_TYPE.REFRESH, { _id: admin._id }, '30d');
    for (const body of [{}, { role: 'user' }, { role: 'admin' }, { role: 'nonsense' }]) {
        const calls = recordDb();
        const out = await runLogout({ body, user: admin, cookies: { refreshToken: cookie } });
        assertSignedOut(out);
        assert.equal(calls.length, 1, JSON.stringify(body));
        const [model, filter, update] = calls[0];
        assert.equal(model, 'Admin');
        assert.equal(String(filter._id), String(admin._id));
        assert.ok(filter.refreshToken.$in.includes(hashRefreshToken(cookie)), 'only the presented session');
        assert.deepEqual(update, { $set: { refreshToken: null } });
    }
});

test('logout: a user signs out this device only, even when the body says admin', async () => {
    const user = new User({ name: 'U', email: 'u@example.invalid', password: 'pw-123456' });
    const cookie = signToken(TOKEN_TYPE.REFRESH, { _id: user._id }, '30d');
    const calls = recordDb();
    const out = await runLogout({ body: { role: 'admin' }, user, cookies: { refreshToken: cookie } });
    assertSignedOut(out);
    assert.ok(calls.length > 0 && calls.every(([model]) => model === 'User'));
    const pull = calls.find(([, , update]) => update.$pull);
    assert.ok(pull[2].$pull.refreshSessions.hash.$in.includes(hashRefreshToken(cookie)), 'only this device is removed');
    assert.ok(!calls.some(([, , update]) => Array.isArray(update.$set?.refreshSessions)), 'other devices stay signed in');
});

test('logout with an expired access token: the refresh cookie (even expired) identifies the account to revoke', async () => {
    const adminId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const expired = (id) => signToken(TOKEN_TYPE.REFRESH, { _id: id }, -60);

    let calls = recordDb({ adminIds: [String(adminId)] });
    assertSignedOut(await runLogout({ cookies: { refreshToken: expired(adminId) } }));
    assert.deepEqual(calls.map(([model]) => model), ['Admin']);

    calls = recordDb({ userIds: [String(userId)] });
    assertSignedOut(await runLogout({ body: { role: 'admin' }, cookies: { refreshToken: expired(userId) } }));
    assert.ok(calls.length > 0 && calls.every(([model]) => model === 'User'));
});

test('logout with no session, a forged cookie, or an access token in the refresh cookie still clears cookies and revokes nothing', async () => {
    const accessAsRefresh = signToken(TOKEN_TYPE.ACCESS, { _id: 'x' }, '30m');
    for (const cookies of [{}, { refreshToken: 'not-a-jwt' }, { refreshToken: jwt.sign({ _id: 'x' }, 'wrong-secret') }, { refreshToken: accessAsRefresh }]) {
        const calls = recordDb({ userIds: ['x'], adminIds: ['x'] });
        assertSignedOut(await runLogout({ cookies }));
        assert.equal(calls.length, 0);
    }
});

test('logout with a valid access token but no refresh cookie clears cookies and revokes nothing (no all-devices sign-out)', async () => {
    const user = new User({ name: 'U', email: 'n@example.invalid', password: 'pw-123456' });
    const admin = new Admin({ name: 'A', email: 'n2@example.invalid', password: 'x' });
    for (const account of [user, admin]) {
        const calls = recordDb();
        assertSignedOut(await runLogout({ user: account, cookies: {} }));
        assert.equal(calls.length, 0);
    }
});

test('refresh: a token in the body is ignored; only the HttpOnly cookie is accepted', async () => {
    const user = new User({ name: 'U', email: 'r@example.invalid', password: 'pw-123456' });
    const res = fakeRes();
    let err;
    const bodyToken = signToken(TOKEN_TYPE.REFRESH, { _id: user._id }, '30d');
    await refreshToken({ body: { refreshToken: bodyToken }, cookies: {} }, res, (e) => { err = e; });
    assert.equal(err?.statusCode, 400);
    assert.equal(res.body, undefined);
    assert.deepEqual(res.cookies, {});
});

test('refresh: the new refresh token is only set as a cookie, never returned in the body', async () => {
    const user = new User({ name: 'U', email: 'r2@example.invalid', password: 'pw-123456' });
    user.generateAccessToken = () => 'new-access-token';
    user.generateRefreshToken = () => 'new-refresh-token';
    User.findById = () => ({ select: async () => user });
    recordDb();
    const res = fakeRes();
    let err;
    const cookie = signToken(TOKEN_TYPE.REFRESH, { _id: user._id }, '30d');
    await refreshToken({ body: {}, cookies: { refreshToken: cookie } }, res, (e) => { err = e; });
    assert.equal(err, undefined);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data, { accessToken: 'new-access-token' });
    assert.ok(!JSON.stringify(res.body).includes('new-refresh-token'));
    assert.equal(res.cookies.refreshToken, 'new-refresh-token');
    assert.equal(res.cookies.accessToken, 'new-access-token');
});
// Response contract the app builds against (verification-email-fixes). In-memory User stand-in, no database.

const HEX = (c) => c.repeat(64);

/** Swap the User statics these controllers use for one in-memory document. */
const withFakeUserModel = async (doc, fn) => {
    const original = { findOne: User.findOne, findById: User.findById, updateOne: User.updateOne };
    const matches = (filter) => Object.entries(filter).every(([key, value]) => (value === null ? doc[key] == null : String(doc[key]) === String(value)));
    const query = (found) => Object.assign(Promise.resolve(found), {
        select: () => Object.assign(Promise.resolve(found), {
            lean: async () => (found ? { _id: found._id, email: found.email, isEmailVerified: found.isEmailVerified } : null),
        }),
    });
    User.findOne = (filter) => query(matches(filter) ? doc : null);
    User.findById = (id) => query(String(id) === String(doc._id) ? doc : null);
    User.updateOne = async (filter, update) => {
        if (!matches(filter)) return { modifiedCount: 0 };
        Object.assign(doc, update.$set);
        for (const key of Object.keys(update.$unset || {})) delete doc[key];
        return { modifiedCount: 1 };
    };
    try {
        return await fn();
    } finally {
        Object.assign(User, original);
    }
};

/** Make Resend answer like it does when the sending domain is not verified (email down for everyone). */
const withEmailDown = async (fn) => {
    const original = resend.emails.send;
    const quiet = { error: console.error, warn: console.warn };
    resend.emails.send = async () => ({ data: null, error: { name: 'validation_error', message: 'The vireact.io domain is not verified.' } });
    console.error = () => {};
    console.warn = () => {};
    try {
        return await fn();
    } finally {
        resend.emails.send = original;
        Object.assign(console, quiet);
    }
};

const unverifiedDoc = (overrides = {}) => ({
    _id: 'u1', name: 'Pat', email: 'pat@example.invalid', password: 'hash', isEmailVerified: false,
    emailVerificationToken: HEX('a'), emailVerificationTokenExpiresAt: null, verificationEmailSentAt: null,
    comparePassword: async () => true,
    generateAccessToken: () => 'access',
    generateRefreshToken: () => 'refresh',
    save: async function () { return this; },
    ...overrides,
});

test('POST /auth/verify-email answers data.status verified, then already_verified for the same link', async () => {
    const doc = unverifiedDoc();
    await withFakeUserModel(doc, async () => {
        for (const expected of ['verified', 'already_verified']) {
            let err;
            const res = fakeRes();
            await verifyEmail({ query: { token: HEX('a') }, body: {} }, res, (e) => { err = e; });
            assert.equal(err, undefined);
            assert.equal(res.statusCode, 200);
            assert.equal(res.body.success, true);
            assert.equal(res.body.data.status, expected);
        }
    });
});

test('login of an unverified user while email is down: signed in, with isEmailVerified false and verificationEmail unavailable', async () => {
    await withEmailDown(() => withFakeUserModel(unverifiedDoc(), async () => {
        let err;
        const res = fakeRes();
        await login({ body: { role: 'user', email: 'pat@example.invalid', password: 'pw-123456' } }, res, (e) => { err = e; });
        assert.equal(err, undefined);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.data.user.isEmailVerified, false);
        assert.equal(res.body.data.verificationEmail, 'unavailable');
        assert.equal(res.body.data.accessToken, 'access');
    }));
});

test('signup reports the email outcome: verificationEmail (detail) next to verificationEmailSent (boolean)', async () => {
    const body = { role: 'user', name: 'Second', email: 'pat@example.invalid', password: 'pw-123456' };
    // Re-signup on an unverified address inside the 60 s cooldown: 429, nothing changes.
    await withFakeUserModel(unverifiedDoc({ verificationEmailSentAt: new Date() }), async () => {
        let err;
        await signup({ body }, fakeRes(), (e) => { err = e; });
        assert.equal(err?.statusCode, 429);
    });
    // Re-signup after the cooldown: pending, not signed in, and the existing account is not revealed.
    const sentBefore = { send: resend.emails.send };
    resend.emails.send = async () => ({ data: { id: 'test' }, error: null });
    try {
        await withFakeUserModel(unverifiedDoc(), async () => {
            const res = fakeRes();
            await signup({ body }, res, assert.ifError);
            assert.equal(res.statusCode, 201);
            assert.equal(res.body.data.verificationEmail, 'sent');
            assert.equal(res.body.data.verificationEmailSent, true);
            assert.equal(res.body.data.accessToken, undefined, 'not signed in');
            assert.deepEqual(res.body.data.user, { name: 'Second', email: 'pat@example.invalid', isEmailVerified: false });
            assert.equal(res.body.data.resignup, true);
        });
    } finally {
        resend.emails.send = sentBefore.send;
    }
    // Re-signup while email is down: still never signed in to someone else's account.
    await withEmailDown(() => withFakeUserModel(unverifiedDoc(), async () => {
        const res = fakeRes();
        await signup({ body }, res, assert.ifError);
        assert.equal(res.body.data.verificationEmail, 'unavailable');
        assert.equal(res.body.data.resignup, true);
        assert.equal(res.body.data.accessToken, undefined);
        assert.deepEqual(res.cookies, {});
    }));
    // Brand-new account while email is down: signed in, still unverified, and the app is told why.
    const save = User.prototype.save;
    User.prototype.save = async function () { return this; };
    try {
        await withEmailDown(() => withFakeUserModel(unverifiedDoc({ email: 'someone-else@example.invalid' }), async () => {
            User.findById = () => Promise.resolve({ _id: 'new', generateAccessToken: () => 'access', generateRefreshToken: () => 'refresh' });
            const res = fakeRes();
            await signup({ body: { ...body, email: 'new@example.invalid' } }, res, assert.ifError);
            assert.equal(res.statusCode, 201);
            assert.equal(res.body.data.verificationEmail, 'unavailable');
            assert.equal(res.body.data.verificationEmailSent, false);
            assert.equal(res.body.data.user.isEmailVerified, false);
            assert.equal(res.body.data.accessToken, 'access');
            assert.equal(res.body.data.resignup, false);
        }));
    } finally {
        User.prototype.save = save;
    }
});

test('signup ignores a client-supplied provider: email + password accounts are always local', async () => {
    const save = User.prototype.save;
    const saved = [];
    User.prototype.save = async function () { saved.push(this.provider); return this; };
    try {
        await withEmailDown(() => withFakeUserModel(unverifiedDoc({ email: 'someone-else@example.invalid' }), async () => {
            User.findById = () => Promise.resolve({ _id: 'new', generateAccessToken: () => 'access', generateRefreshToken: () => 'refresh' });
            for (const provider of ['google', 'tiktok', { $ne: null }]) {
                const body = { role: 'user', name: 'New', email: 'new@example.invalid', password: 'pw-123456', provider };
                await signup({ body }, fakeRes(), assert.ifError);
            }
        }));
        assert.deepEqual(saved, ['local', 'local', 'local']);
    } finally {
        User.prototype.save = save;
    }
});

test('signup rejects non-text fields with 400', async () => {
    for (const body of [{ name: { $ne: null }, email: 'a@example.invalid', password: 'pw-123456' }, { name: 'A', email: ['a@example.invalid'], password: 'pw-123456' }]) {
        let err;
        await signup({ body: { role: 'user', ...body } }, fakeRes(), (e) => { err = e; });
        assert.equal(err?.statusCode, 400);
    }
});

test('requireAdminUser: only admin and super-admin roles pass; no user is 401; others 403', async () => {
    const { requireAdminUser } = await import('../src/middleware/auth.js');
    const run = (user) => { let err; let called = false; requireAdminUser({ user }, fakeRes(), (e) => { err = e; called = !e; }); return { err, called }; };
    assert.equal(run(undefined).err.statusCode, 401);
    assert.equal(run({ role: 'user' }).err.statusCode, 403);
    assert.equal(run({}).err.statusCode, 403);
    assert.ok(run({ role: 'admin' }).called);
    assert.ok(run({ role: 'super-admin' }).called);
});

test('POST /auth/verify-email after competing signups answers verified_set_password with a resetToken, once', async () => {
    const doc = unverifiedDoc({ competingSignupAt: new Date(), passwordResetTokenHash: null });
    const sentBefore = resend.emails.send;
    resend.emails.send = async () => ({ data: { id: 'test' }, error: null });
    try {
        await withFakeUserModel(doc, async () => {
            const res = fakeRes();
            await verifyEmail({ query: { token: HEX('a') }, body: {} }, res, assert.ifError);
            assert.equal(res.body.data.status, 'verified_set_password');
            assert.match(res.body.data.resetToken, /^[a-f0-9]{64}$/);
            assert.equal(doc.password, undefined);

            const again = fakeRes();
            await verifyEmail({ query: { token: HEX('a') }, body: {} }, again, assert.ifError);
            assert.deepEqual(again.body.data, { status: 'already_verified' });
        });
    } finally {
        resend.emails.send = sentBefore;
    }
});

// Email changes (security fix): a new email is pending until the new inbox confirms it. No database.

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Does an in-memory doc match a Mongo filter? Supports equality, null, $ne, $gt, $in, $nin. */
const matchesFilter = (doc, filter) => Object.entries(filter).every(([key, cond]) => {
    const value = doc[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
        if ('$ne' in cond) return String(value) !== String(cond.$ne);
        if ('$gt' in cond) return value != null && value > cond.$gt;
        if ('$in' in cond) return cond.$in.map(String).includes(String(value));
        if ('$nin' in cond) return !cond.$nin.map(String).includes(String(value));
        throw new Error(`fake User: unsupported filter ${JSON.stringify(cond)}`);
    }
    return cond === null ? value == null : String(value) === String(cond);
});

/** Swap User statics for several in-memory documents; records every filter User.findOne receives. */
const withFakeUsers = async (docs, fn) => {
    const original = { findOne: User.findOne, findById: User.findById, updateOne: User.updateOne };
    const findOneFilters = [];
    const query = (found) => {
        const q = Object.assign(Promise.resolve(found), {
            select: () => q,
            collation: () => q,
            lean: async () => (found ? { ...found } : null),
        });
        return q;
    };
    User.findOne = (filter) => {
        findOneFilters.push(filter);
        return query(docs.find((d) => matchesFilter(d, filter)) ?? null);
    };
    User.findById = (id) => query(docs.find((d) => String(d._id) === String(id)) ?? null);
    User.updateOne = async (filter, update) => {
        const doc = docs.find((d) => matchesFilter(d, filter));
        if (!doc) return { modifiedCount: 0 };
        Object.assign(doc, update.$set);
        for (const key of Object.keys(update.$unset || {})) delete doc[key];
        for (const [key, cond] of Object.entries(update.$pull || {})) {
            doc[key] = (doc[key] || []).filter((item) => !matchesFilter(item, cond));
        }
        return { modifiedCount: 1 };
    };
    try {
        return await fn({ findOneFilters });
    } finally {
        Object.assign(User, original);
    }
};

/** Capture outgoing emails instead of sending them. */
const withSentEmails = async (fn) => {
    const original = resend.emails.send;
    const sent = [];
    resend.emails.send = async (message) => { sent.push(message); return { data: { id: 'test' }, error: null }; };
    try {
        return await fn(sent);
    } finally {
        resend.emails.send = original;
    }
};

const localUser = (overrides = {}) => ({
    _id: 'owner1', name: 'Victim', email: 'owner@example.invalid', password: 'hash', provider: 'local',
    isEmailVerified: true, pendingEmail: null, emailChangeTokenHash: null, emailChangeExpires: null,
    refreshToken: 'h-current', refreshSessions: [{ hash: 'h-current' }, { hash: 'h-other' }],
    comparePassword: async (candidate) => candidate === 'right-password',
    save: async function () { return this; },
    ...overrides,
});

const callUpdateProfile = async (body, userId = 'owner1') => {
    let err;
    const res = fakeRes();
    await updateProfile({ user: { _id: userId }, body }, res, (e) => { err = e; });
    return { err, res };
};

const confirmTokenFrom = (message) => message.text.match(/token=([a-f0-9]{64})/)?.[1];

test('email change emails: masked address, escaped HTML, plain-text part, 24 hour link', () => {
    assert.equal(maskEmail('jane.doe@gmail.com'), 'j***@g***.com');
    assert.equal(maskEmail('a@b'), 'a***@b***');
    assert.equal(EMAIL_CHANGE_TTL_MS, 24 * 60 * 60 * 1000);

    const confirm = buildEmailChangeConfirmEmail('https://vireact.io/confirm-email-change?token=x&"<y>');
    assert.match(confirm.html, /token=x&amp;&quot;&lt;y&gt;/);
    assert.match(confirm.text, /token=x&"<y>/);
    assert.match(confirm.text, /24 hours/);

    for (const completed of [false, true]) {
        const notice = buildEmailChangeNoticeEmail({ maskedNewEmail: maskEmail('attacker@evil.example'), completed });
        assert.ok(!`${notice.html}${notice.text}`.includes('attacker@evil.example'));
        assert.match(notice.text, /a\*\*\*@e\*\*\*\.example/);
    }
});

test('PATCH /profile with a new email keeps the old email, needs the current password, and emails both inboxes', async () => {
    const doc = localUser();
    await withSentEmails(async (sent) => {
        await withFakeUsers([doc], async () => {
            const missing = await callUpdateProfile({ name: 'Victim', email: 'victim@gmail.com' });
            assert.equal(missing.err?.statusCode, 400);
            const wrong = await callUpdateProfile({ name: 'Victim', email: 'victim@gmail.com', currentPassword: 'nope' });
            assert.equal(wrong.err?.statusCode, 401);
            assert.equal(sent.length, 0);
            assert.equal(doc.pendingEmail, null);

            const { err, res } = await callUpdateProfile({ name: 'Renamed', email: ' Victim@Gmail.com ', currentPassword: 'right-password' });
            assert.ifError(err);
            assert.equal(doc.email, 'owner@example.invalid', 'stored email must not change before confirmation');
            assert.equal(doc.isEmailVerified, true);
            assert.equal(doc.name, 'Renamed');
            assert.equal(doc.pendingEmail, 'victim@gmail.com');
            assert.equal(res.body.data.emailChange.pendingEmail, 'victim@gmail.com');
            assert.equal(res.body.data.user.email, 'owner@example.invalid');
            const ttl = doc.emailChangeExpires.getTime() - Date.now();
            assert.ok(ttl > EMAIL_CHANGE_TTL_MS - 60_000 && ttl <= EMAIL_CHANGE_TTL_MS);

            const [confirm, notice] = sent;
            assert.equal(confirm.to, 'victim@gmail.com');
            const token = confirmTokenFrom(confirm);
            assert.ok(token);
            assert.equal(doc.emailChangeTokenHash, sha256(token), 'only the hash is stored');
            assert.equal(notice.to, 'owner@example.invalid');
            assert.ok(!notice.text.includes('victim@gmail.com'));
        });
    });
});

test('PATCH /profile: Google and password-less accounts cannot change email; a used address is 409; only cancelEmailChange cancels', async () => {
    const google = localUser({ _id: 'g1', provider: 'google', password: undefined });
    const linked = localUser({ _id: 'l1', email: 'l1@example.invalid', password: undefined, googleId: 'google-9' });
    const taken = localUser({ _id: 'other', email: 'taken@example.invalid' });
    const pending = localUser({ _id: 'p1', email: 'p1@example.invalid', pendingEmail: 'next@example.invalid', emailChangeTokenHash: 'x', emailChangeExpires: new Date(Date.now() + 1000) });
    await withSentEmails(async (sent) => {
        await withFakeUsers([google, linked, taken, pending, localUser()], async () => {
            assert.equal((await callUpdateProfile({ name: 'G', email: 'new@example.invalid' }, 'g1')).err?.statusCode, 403);

            const noPassword = await callUpdateProfile({ name: 'L', email: 'new@example.invalid' }, 'l1');
            assert.equal(noPassword.err?.statusCode, 403);
            assert.equal(noPassword.err?.data?.code, 'SET_PASSWORD_FIRST');
            assert.equal(linked.pendingEmail, null);

            assert.equal((await callUpdateProfile({ name: 'V', email: 'taken@example.invalid', currentPassword: 'right-password' })).err?.statusCode, 409);

            const nameOnly = await callUpdateProfile({ name: 'P2', email: 'P1@example.invalid' }, 'p1');
            assert.ifError(nameOnly.err);
            assert.equal(nameOnly.res.body.data.emailChange, null);
            assert.equal(pending.name, 'P2');
            assert.equal(pending.pendingEmail, 'next@example.invalid', 'a name-only save keeps the pending change');

            const { err } = await callUpdateProfile({ name: 'P2', email: 'p1@example.invalid', cancelEmailChange: true }, 'p1');
            assert.ifError(err);
            assert.equal(pending.pendingEmail, null);
            assert.equal(pending.emailChangeTokenHash, null);
            assert.equal(sent.length, 0);
        });
    });
});

test('POST /auth/confirm-email-change switches the email once, signs out every device and tells the old inbox (masked)', async () => {
    const doc = localUser();
    await withSentEmails(async (sent) => {
        await withFakeUsers([doc], async () => {
            await callUpdateProfile({ name: 'Victim', email: 'new@example.invalid', currentPassword: 'right-password' });
            const token = confirmTokenFrom(sent[0]);
            sent.length = 0;

            const res = fakeRes();
            await confirmEmailChange({ body: { token } }, res, assert.ifError);
            assert.equal(res.body.data.email, 'new@example.invalid');
            assert.deepEqual(res.cleared.sort(), ['accessToken', 'refreshToken']);
            assert.equal(doc.email, 'new@example.invalid');
            assert.equal(doc.isEmailVerified, true);
            assert.equal(doc.pendingEmail, null);
            assert.equal(doc.emailChangeTokenHash, null);
            assert.deepEqual(doc.refreshSessions, []);
            assert.equal(doc.refreshToken, undefined);
            assert.equal(sent.length, 1);
            assert.equal(sent[0].to, 'owner@example.invalid');
            assert.ok(!sent[0].text.includes('new@example.invalid'));

            let err;
            await confirmEmailChange({ body: { token } }, fakeRes(), (e) => { err = e; });
            assert.equal(err?.statusCode, 400, 'a link works once');
        });
    });
});

test('POST /auth/confirm-email-change: malformed tokens fail before any query; expired links fail; a taken address is 409', async () => {
    const spy = spyUserFindOne();
    try {
        for (const token of [{ $ne: null }, ['a'.repeat(64)], 'a'.repeat(63), undefined]) {
            let err;
            await confirmEmailChange({ body: { token } }, fakeRes(), (e) => { err = e; });
            assert.equal(err?.statusCode, 400);
        }
        assert.deepEqual(spy.calls, []);
    } finally {
        spy.restore();
    }

    const expired = localUser({ pendingEmail: 'new@example.invalid', emailChangeTokenHash: sha256(HEX('b')), emailChangeExpires: new Date(Date.now() - 1000) });
    await withFakeUsers([expired], async () => {
        let err;
        await confirmEmailChange({ body: { token: HEX('b') } }, fakeRes(), (e) => { err = e; });
        assert.equal(err?.statusCode, 400);
        assert.equal(expired.email, 'owner@example.invalid');
    });

    const racer = localUser({ pendingEmail: 'new@example.invalid', emailChangeTokenHash: sha256(HEX('c')), emailChangeExpires: new Date(Date.now() + 60_000) });
    const squatter = localUser({ _id: 'squatter', email: 'new@example.invalid' });
    await withFakeUsers([racer, squatter], async () => {
        let err;
        await confirmEmailChange({ body: { token: HEX('c') } }, fakeRes(), (e) => { err = e; });
        assert.equal(err?.statusCode, 409);
        assert.equal(racer.email, 'owner@example.invalid');
        assert.equal(racer.pendingEmail, null);
    });
});

test('Continue with Google never matches a pending email, and taking over an unverified account drops its devices', async () => {
    const profile = (email) => ({ id: 'google-123', emails: [{ value: email, verified: true }], displayName: 'G', photos: [] });

    const attacker = localUser({ _id: 'attacker', email: 'attacker@example.invalid', pendingEmail: 'victim@gmail.com' });
    const createdBefore = User.prototype.save;
    User.prototype.save = async function () { return this; };
    try {
        await withFakeUsers([attacker], async ({ findOneFilters }) => {
            const user = await User.findOrCreateByGoogleProfile(profile('victim@gmail.com'));
            assert.notEqual(String(user._id), 'attacker');
            assert.equal(attacker.googleId, undefined);
            assert.ok(findOneFilters.every((f) => !('pendingEmail' in f)));
        });
    } finally {
        User.prototype.save = createdBefore;
    }

    const squatter = localUser({ _id: 'squat', email: 'victim@gmail.com', isEmailVerified: false, save: async function () { return this; } });
    await withFakeUsers([squatter], async () => {
        const user = await User.findOrCreateByGoogleProfile(profile('victim@gmail.com'));
        assert.equal(String(user._id), 'squat');
        assert.equal(squatter.password, undefined);
        assert.deepEqual(squatter.refreshSessions, []);
        assert.equal(squatter.refreshToken, undefined);
        assert.equal(squatter.isEmailVerified, true);
    });
});

test('PATCH /profile/password keeps this device, signs out the others, cancels a pending email change', async () => {
    const doc = localUser({ pendingEmail: 'x@example.invalid', emailChangeTokenHash: 'h', emailChangeExpires: new Date(Date.now() + 1000) });
    const { hashRefreshToken } = await import('../src/utils/refresh-token-hash.js');
    await withFakeUsers([doc], async () => {
        // Sessions are stored as hashes of the refresh tokens; this device presents 'this-device' in its cookie.
        doc.refreshSessions = [{ hash: hashRefreshToken('this-device') }, { hash: hashRefreshToken('laptop') }];
        doc.refreshToken = hashRefreshToken('laptop');
        const res = fakeRes();
        await updatePassword({
            user: { _id: 'owner1' },
            cookies: { refreshToken: 'this-device' },
            body: { currentPassword: 'right-password', newPassword: 'new-password-1', confirmPassword: 'new-password-1' },
        }, res, assert.ifError);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(doc.refreshSessions, [{ hash: hashRefreshToken('this-device') }]);
        assert.equal(doc.refreshToken, undefined);
        assert.equal(doc.pendingEmail, null);
        assert.equal(doc.emailChangeTokenHash, null);
    });
});

test('profile and confirm endpoints are rate limited; unexpected profile errors return a generic message', async () => {
    assert.equal(AUTH_RATE_LIMITS['/api/v1/auth/confirm-email-change'].max, 20);
    const { default: profileRoutes } = await import('../src/route/profile.route.js');
    const limited = profileRoutes.stack
        .filter((layer) => layer.route?.methods?.patch)
        .map((layer) => [layer.route.path, layer.route.stack.length]);
    assert.deepEqual(limited.filter(([path]) => path !== '/notification-preferences'), [['/', 2], ['/password', 2]]);

    const quiet = console.error;
    console.error = () => {};
    const original = User.findById;
    User.findById = () => { throw new Error('connection to db-internal-host:27017 refused'); };
    try {
        const { err } = await callUpdateProfile({ name: 'A', email: 'a@example.invalid' });
        assert.equal(err?.statusCode, 500);
        assert.equal(err?.message, 'Failed to update user profile.');
    } finally {
        User.findById = original;
        console.error = quiet;
    }
});

test('early access rejects operator objects and bad formats before any query, and hides internal errors', async () => {
    const calls = [];
    const original = { findOne: EarlyAccess.findOne, save: EarlyAccess.prototype.save };
    EarlyAccess.findOne = async (filter) => { calls.push(filter); return null; };
    const base = { name: 'Pat', email: 'pat@example.invalid', contentGoalNote: 'grow' };
    try {
        for (const body of [
            { ...base, email: { $regex: '^a' } },
            { ...base, phone: { $regex: '^\\+1' } },
            { ...base, phone: ['+15551234567'] },
            { ...base, email: 'not-an-email' },
            { ...base, phone: 'call me' },
            { ...base, name: { $ne: null } },
        ]) {
            await assert.rejects(createEarlyAccessService(body), (e) => e.statusCode === 400, JSON.stringify(body));
        }
        assert.deepEqual(calls, []);

        EarlyAccess.prototype.save = async function () { return this; };
        const saved = await createEarlyAccessService({ ...base, email: ' Pat@Example.invalid ', phone: '+1 (555) 123-4567' });
        assert.equal(saved.email, 'pat@example.invalid');
        assert.deepEqual(calls, [{ email: 'pat@example.invalid' }, { phone: '+1 (555) 123-4567' }]);

        const quiet = console.error;
        console.error = () => {};
        EarlyAccess.prototype.save = async () => { throw new Error('E_INTERNAL: replica set host-7 down'); };
        try {
            await assert.rejects(createEarlyAccessService({ ...base, email: 'other@example.invalid' }), (e) => e.statusCode === 500 && e.message === 'Failed to create early access');
        } finally {
            console.error = quiet;
        }
    } finally {
        EarlyAccess.findOne = original.findOne;
        EarlyAccess.prototype.save = original.save;
    }
});
