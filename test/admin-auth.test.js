import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidAdminKey, adminAuth, ADMIN_RATE_LIMIT } from '../src/middleware/adminAuth.js';
import { signup, verifyEmail, login } from '../src/controller/auth.controller.js';
import { User } from '../src/model/user.model.js';
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
