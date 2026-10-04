import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, disconnectTestDb, fakeRes } from './helpers/test-db.js';
import { User } from '../src/model/user.model.js';
import { Admin } from '../src/model/admin.model.js';
import { generateAccessToken, refreshTokenService } from '../src/service/auth.service.js';
import { loginAdmin } from '../src/controller/auth.controller.js';
import { convertLegacyRefreshTokens } from '../src/service/legacy-refresh-tokens.js';
import { isHashedRefreshToken } from '../src/utils/refresh-token-hash.js';

let db;
before(async () => { db = await connectTestDb(); });
after(async () => { await disconnectTestDb(); });

const newUser = (suffix) =>
    User.create({ name: 'Test', email: `refresh-${suffix}-${Date.now()}@example.invalid`, password: 'pw-123456', isEmailVerified: true });

test('login stores only a hash of the refresh token', async () => {
    const user = await newUser('hash');
    const { refreshToken } = await generateAccessToken(user._id, User, 'User');
    const stored = (await User.findById(user._id).select('+refreshToken').lean()).refreshToken;
    assert.ok(isHashedRefreshToken(stored));
    assert.ok(!stored.includes(refreshToken));
    assert.ok(stored.startsWith(process.env.REFRESH_TOKEN_PEPPER ? 'h1:' : 'h0:'));
});

test('refresh rotates the token and rejects replay of the old one with 401', async () => {
    const user = await newUser('rotate');
    const first = await generateAccessToken(user._id, User, 'User');
    await new Promise((r) => setTimeout(r, 1100)); // JWT iat granularity is 1s; ensure a distinct token
    const second = await refreshTokenService(first.refreshToken);
    assert.ok(second.accessToken && second.refreshToken);
    assert.notEqual(second.refreshToken, first.refreshToken);
    await assert.rejects(refreshTokenService(first.refreshToken), (e) => e.statusCode === 401);
    const stored = (await User.findById(user._id).lean()).refreshToken;
    assert.ok(isHashedRefreshToken(stored));
});

test('a legacy plaintext token still refreshes once and is replaced by a hash', async () => {
    const user = await newUser('legacy');
    const raw = user.generateRefreshToken();
    await User.updateOne({ _id: user._id }, { $set: { refreshToken: raw } });
    const out = await refreshTokenService(raw);
    assert.ok(out.refreshToken);
    assert.ok(isHashedRefreshToken((await User.findById(user._id).lean()).refreshToken));
});

test('admin login never returns the refresh token in the body or the admin object', async () => {
    const email = `admin-${Date.now()}@example.invalid`;
    await Admin.create({ name: 'Admin', email, password: 'pw-123456' });
    const res = fakeRes();
    let err;
    await loginAdmin({ body: { email, password: 'pw-123456' } }, res, (e) => { err = e; });
    assert.equal(err, undefined);
    assert.equal(res.statusCode, 200);
    assert.ok(res.cookies.refreshToken, 'cookie still set');
    assert.equal(res.body.refreshToken, undefined);
    assert.equal(res.body.admin.refreshToken, undefined);
    assert.equal(res.body.admin.password, undefined);
    const stored = (await Admin.findOne({ email }).lean()).refreshToken;
    assert.ok(isHashedRefreshToken(stored));
});

test('legacy conversion: dry run counts only, apply hashes plaintext and leaves hashes alone', async () => {
    await db.collection('users').deleteMany({});
    await db.collection('admins').deleteMany({});
    await db.collection('users').insertMany([
        { email: 'a@example.invalid', refreshToken: 'plain.token.one' },
        { email: 'b@example.invalid', refreshToken: 'plain.token.two' },
        { email: 'c@example.invalid', refreshToken: 'h1:' + 'f'.repeat(64) },
        { email: 'd@example.invalid' },
    ]);
    await db.collection('admins').insertOne({ email: 'e@example.invalid', refreshToken: 'plain.admin' });

    const dry = await convertLegacyRefreshTokens(db, { apply: false });
    assert.deepEqual(dry.map((r) => [r.collection, r.withToken, r.plaintext, r.converted]), [['users', 3, 2, 0], ['admins', 1, 1, 0]]);
    assert.equal(await db.collection('users').countDocuments({ refreshToken: 'plain.token.one' }), 1);

    const applied = await convertLegacyRefreshTokens(db, { apply: true, pepper: 'p'.repeat(32) });
    assert.deepEqual(applied.map((r) => [r.collection, r.plaintext, r.converted]), [['users', 2, 2], ['admins', 1, 1]]);
    const tokens = (await db.collection('users').find({ refreshToken: { $exists: true } }).toArray()).map((d) => d.refreshToken);
    assert.ok(tokens.every(isHashedRefreshToken));
    assert.ok(tokens.includes('h1:' + 'f'.repeat(64)));

    const again = await convertLegacyRefreshTokens(db, { apply: true });
    assert.deepEqual(again.map((r) => r.plaintext), [0, 0]);
});
