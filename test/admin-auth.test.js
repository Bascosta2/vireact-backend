import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidAdminKey, adminAuth, ADMIN_RATE_LIMIT } from '../src/middleware/adminAuth.js';
import { signup, verifyEmail, login } from '../src/controller/auth.controller.js';
import { User } from '../src/model/user.model.js';
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
