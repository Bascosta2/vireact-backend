import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { isValidAdminKey, adminAuth, ADMIN_RATE_LIMIT } from '../src/middleware/adminAuth.js';
import { signup, logout, refreshToken } from '../src/controller/auth.controller.js';
import { REFRESH_TOKEN_SECRET } from '../src/config/index.js';
import { User } from '../src/model/user.model.js';
import { Admin } from '../src/model/admin.model.js';
import { hashRefreshToken } from '../src/utils/refresh-token-hash.js';
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
