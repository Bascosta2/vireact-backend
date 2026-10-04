import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Runs in a child process with POSTHOG_KEY blanked so no event can reach PostHog.
const runWithoutKey = (code) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        env: { ...process.env, POSTHOG_KEY: '' },
        encoding: 'utf8',
    });

test('server analytics is a no-op without POSTHOG_KEY', () => {
    const result = runWithoutKey(`
        const a = await import('./src/lib/analytics.js');
        const out = {
            enabled: a.isServerAnalyticsEnabled(),
            captured: a.captureServerEvent('user-1', 'user_signed_up', { method: 'email' }),
        };
        await a.shutdownAnalytics();
        console.log(JSON.stringify(out));
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').pop()), { enabled: false, captured: false });
});

test('captureServerEvent ignores calls without a distinct id or event', async () => {
    const result = runWithoutKey(`
        const a = await import('./src/lib/analytics.js');
        console.log(JSON.stringify([a.captureServerEvent(null, 'x'), a.captureServerEvent('u', '')]));
    `);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').pop()), [false, false]);
});
