import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashRefreshToken, refreshTokenMatches, isHashedRefreshToken } from '../src/utils/refresh-token-hash.js';
import { verifyEmailService, resetPasswordService, loginAdminService, isEmailLinkToken } from '../src/service/auth.service.js';
import { User } from '../src/model/user.model.js';
import { Admin } from '../src/model/admin.model.js';

const TOKEN = 'header.payload.signature';
const PEPPER = 'a'.repeat(32);

test('peppered hash is h1, deterministic, and never contains the token', () => {
    const h = hashRefreshToken(TOKEN, PEPPER);
    assert.match(h, /^h1:[0-9a-f]{64}$/);
    assert.equal(h, hashRefreshToken(TOKEN, PEPPER));
    assert.ok(!h.includes(TOKEN));
    assert.ok(isHashedRefreshToken(h));
});

test('without a pepper the hash falls back to h0', () => {
    assert.match(hashRefreshToken(TOKEN, ''), /^h0:[0-9a-f]{64}$/);
});

test('matching: h1 needs the same pepper, h0 works with or without one', () => {
    const h1 = hashRefreshToken(TOKEN, PEPPER);
    assert.ok(refreshTokenMatches(h1, TOKEN, PEPPER));
    assert.ok(!refreshTokenMatches(h1, TOKEN, 'b'.repeat(32)));
    assert.ok(!refreshTokenMatches(h1, TOKEN, ''));
    assert.ok(!refreshTokenMatches(h1, 'other.token', PEPPER));

    const h0 = hashRefreshToken(TOKEN, '');
    assert.ok(refreshTokenMatches(h0, TOKEN, ''));
    assert.ok(refreshTokenMatches(h0, TOKEN, PEPPER));
});

test('legacy plaintext tokens still match exactly once stored', () => {
    assert.ok(!isHashedRefreshToken(TOKEN));
    assert.ok(refreshTokenMatches(TOKEN, TOKEN, PEPPER));
    assert.ok(!refreshTokenMatches(TOKEN, TOKEN + 'x', PEPPER));
});

test('empty values never match', () => {
    assert.ok(!refreshTokenMatches('', TOKEN, PEPPER));
    assert.ok(!refreshTokenMatches(null, TOKEN, PEPPER));
    assert.ok(!refreshTokenMatches(hashRefreshToken(TOKEN, PEPPER), '', PEPPER));
    assert.throws(() => hashRefreshToken('', PEPPER));
});


// Emailed-link tokens and login fields: request values must never reach a Mongo filter as operators.

/** Replace Model.findOne for one test and record every filter it receives (no database needed). */
const spyFindOne = (model) => {
    const calls = [];
    const original = model.findOne;
    model.findOne = (filter) => { calls.push(filter); throw new Error('findOne must not be reached'); };
    return { calls, restore: () => { model.findOne = original; } };
};

const NON_TOKEN_VALUES = [
    { $ne: null },
    { $gt: '' },
    { $regex: '.*' },
    ['a'.repeat(64)],
    123,
    true,
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    'g'.repeat(64),
    ` ${'a'.repeat(64)}`,
];

test('isEmailLinkToken accepts only a 64-char lowercase hex string', () => {
    assert.ok(isEmailLinkToken('0123456789abcdef'.repeat(4)));
    for (const value of [...NON_TOKEN_VALUES, '', null, undefined]) {
        assert.equal(isEmailLinkToken(value), false, `accepted ${JSON.stringify(value)}`);
    }
});

test('verifyEmailService rejects operator objects and malformed tokens with 400 before any query', async () => {
    const spy = spyFindOne(User);
    try {
        for (const token of NON_TOKEN_VALUES) {
            await assert.rejects(verifyEmailService(token), (e) => e.statusCode === 400, `token ${JSON.stringify(token)}`);
        }
        assert.deepEqual(spy.calls, []);
    } finally {
        spy.restore();
    }
});

test('reset-password keeps rejecting non-hex tokens before any query', async () => {
    const spy = spyFindOne(User);
    try {
        for (const token of NON_TOKEN_VALUES) {
            await assert.rejects(resetPasswordService(token, 'new-password-1'), (e) => e.statusCode === 400);
        }
        assert.deepEqual(spy.calls, []);
    } finally {
        spy.restore();
    }
});

test('admin login rejects a non-string email or password with 400 before any query', async () => {
    const spy = spyFindOne(Admin);
    try {
        for (const [email, password] of [[{ $ne: null }, 'pw-123456'], ['a@example.invalid', { $ne: null }], [['a@example.invalid'], 'pw-123456']]) {
            await assert.rejects(loginAdminService(email, password), (e) => e.statusCode === 400);
        }
        assert.deepEqual(spy.calls, []);
    } finally {
        spy.restore();
    }
});
