import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashRefreshToken, refreshTokenMatches, isHashedRefreshToken } from '../src/utils/refresh-token-hash.js';

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
