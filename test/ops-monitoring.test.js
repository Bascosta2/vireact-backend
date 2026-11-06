import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldSendAlert, alertFailure, captureError, initErrorTracking } from '../src/service/ops-monitoring.service.js';

console.warn = () => {};

test('alert throttle: once per video per 30 minutes, at most 20 per hour overall', () => {
    const t0 = Date.parse('2026-11-06T12:00:00Z');
    assert.equal(shouldSendAlert('video-a', t0), true);
    assert.equal(shouldSendAlert('video-a', t0 + 60 * 1000), false, 'same video within 30 minutes');
    assert.equal(shouldSendAlert('video-a', t0 + 31 * 60 * 1000), true);
    let sent = 2;
    for (let i = 0; i < 30; i++) if (shouldSendAlert(`v${i}`, t0 + 32 * 60 * 1000)) sent++;
    assert.equal(sent, 20, 'hourly cap');
    assert.equal(shouldSendAlert('later', t0 + 2 * 60 * 60 * 1000), true, 'cap resets after an hour');
});

test('without SENTRY_DSN or OPS_ALERT_EMAIL, monitoring is a silent no-op', async () => {
    delete process.env.SENTRY_DSN;
    delete process.env.OPS_ALERT_EMAIL;
    assert.equal(await initErrorTracking(), false);
    assert.doesNotThrow(() => captureError(new Error('x'), { stage: 'test' }));
    await alertFailure({ stage: 'analysis', videoId: 'v1', error: new Error('boom') });
});
