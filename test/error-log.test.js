import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessage, normalizeRoute, fingerprintFor, recordError, onNewError } from '../src/service/error-log.service.js';

console.warn = () => {};

test('the same bug with different ids, numbers and values groups into one fingerprint', () => {
    const a = fingerprintFor({ source: 'server', route: 'GET /api/v1/videos/6731a0b2c3d4e5f6a7b8c9d0/feedback', message: 'Cannot read properties of undefined (reading "score") at 42' });
    const b = fingerprintFor({ source: 'server', route: 'GET /api/v1/videos/6731a0b2c3d4e5f6a7b8c9ff/feedback?x=1', message: 'Cannot read properties of undefined (reading "hook") at 77' });
    assert.equal(a, b);
    assert.notEqual(a, fingerprintFor({ source: 'client', route: 'GET /api/v1/videos/x/feedback', message: 'other' }));
    assert.equal(normalizeRoute('/api/v1/videos/6731a0b2c3d4e5f6a7b8c9d0/scripts?y=2'), '/api/v1/videos/:id/scripts');
    assert.equal(normalizeMessage('Timeout after 30000ms calling https://api.example.com/x'), 'Timeout after <n>ms calling <url>');
});

/** In-memory stand-in for the ErrorEvent model (only what recordError uses). */
const fakeModel = () => {
    const rows = new Map();
    return {
        rows,
        findOneAndUpdate: async (filter, update) => {
            const key = `${filter.fingerprint}|${filter.day}`;
            const before = rows.get(key) ? { ...rows.get(key) } : null;
            const row = rows.get(key) || { ...filter, ...update.$setOnInsert, count: 0, userIds: [] };
            row.count += update.$inc.count;
            row.lastSeenAt = update.$set.lastSeenAt;
            if (update.$push?.userIds) row.userIds = [...row.userIds, ...update.$push.userIds.$each].slice(-20);
            rows.set(key, row);
            return before;
        },
        exists: async (filter) => [...rows.values()].some((r) => r.fingerprint === filter.fingerprint && r.day !== filter.day.$ne),
    };
};

test('repeats are counted on one row; only a never-seen error triggers the new-error alert', async () => {
    const model = fakeModel();
    const alerts = [];
    onNewError((event) => alerts.push(event));
    const day1 = Date.parse('2026-11-06T10:00:00Z');
    const event = { source: 'server', route: 'POST /api/v1/chat/:id', message: 'OpenAI timeout', userId: 'u1' };

    const first = await recordError(event, { model, now: day1 });
    const second = await recordError({ ...event, userId: 'u2' }, { model, now: day1 + 1000 });
    assert.equal(first.isNew, true);
    assert.equal(second.isNew, false);
    assert.equal(model.rows.size, 1);
    const row = [...model.rows.values()][0];
    assert.equal(row.count, 2);
    assert.deepEqual(row.userIds, ['u1', 'u2']);

    // Next day: a new row for the day, but not a new kind of error, so no second alert.
    const nextDay = await recordError(event, { model, now: day1 + 24 * 60 * 60 * 1000 });
    assert.equal(nextDay.isNew, false);
    assert.equal(model.rows.size, 2);
    await new Promise((r) => setImmediate(r));
    assert.equal(alerts.length, 1);
    onNewError(null);
});

test('recording never throws, even when the store fails', async () => {
    const broken = { findOneAndUpdate: async () => { throw new Error('db down'); } };
    assert.equal(await recordError({ source: 'server', message: 'x' }, { model: broken }), null);
    assert.equal(await recordError({ source: 'server' }, { model: broken }), null, 'no message: ignored');
});

test('client error intake always answers 204 and ignores empty reports', async () => {
    const { postClientError } = await import('../src/controller/client-error.controller.js');
    const res = { code: null, status(c) { this.code = c; return this; }, end() { return this; } };
    postClientError({ body: { message: 'TypeError: x is undefined', kind: 'unhandled', route: '/videos' }, headers: {} }, res);
    assert.equal(res.code, 204);
    postClientError({ body: 'not json', headers: { authorization: 'Bearer garbage' } }, res);
    assert.equal(res.code, 204);
});
