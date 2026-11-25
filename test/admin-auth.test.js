import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { isValidAdminKey, adminAuth, ADMIN_RATE_LIMIT } from '../src/middleware/adminAuth.js';
import { signup, verifyEmail, login, logout, refreshToken } from '../src/controller/auth.controller.js';
import { REFRESH_TOKEN_SECRET } from '../src/config/index.js';
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
    const cookie = jwt.sign({ _id: admin._id }, REFRESH_TOKEN_SECRET, { expiresIn: '30d' });
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
    const cookie = jwt.sign({ _id: user._id }, REFRESH_TOKEN_SECRET, { expiresIn: '30d' });
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
    const expired = (id) => jwt.sign({ _id: id, exp: Math.floor(Date.now() / 1000) - 60 }, REFRESH_TOKEN_SECRET);

    let calls = recordDb({ adminIds: [String(adminId)] });
    assertSignedOut(await runLogout({ cookies: { refreshToken: expired(adminId) } }));
    assert.deepEqual(calls.map(([model]) => model), ['Admin']);

    calls = recordDb({ userIds: [String(userId)] });
    assertSignedOut(await runLogout({ body: { role: 'admin' }, cookies: { refreshToken: expired(userId) } }));
    assert.ok(calls.length > 0 && calls.every(([model]) => model === 'User'));
});

test('logout with no session, or a forged cookie, still clears cookies and revokes nothing', async () => {
    for (const cookies of [{}, { refreshToken: 'not-a-jwt' }, { refreshToken: jwt.sign({ _id: 'x' }, 'wrong-secret') }]) {
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
    const bodyToken = jwt.sign({ _id: user._id }, REFRESH_TOKEN_SECRET, { expiresIn: '30d' });
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
    const cookie = jwt.sign({ _id: user._id }, REFRESH_TOKEN_SECRET, { expiresIn: '30d' });
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
    const matches = (filter) => Object.entries(filter).every(([key, value]) => String(doc[key]) === String(value));
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
        });
    } finally {
        resend.emails.send = sentBefore.send;
    }
    // Re-signup while email is down: still never signed in to someone else's account.
    await withEmailDown(() => withFakeUserModel(unverifiedDoc(), async () => {
        const res = fakeRes();
        await signup({ body }, res, assert.ifError);
        assert.equal(res.body.data.verificationEmail, 'unavailable');
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
        }));
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
