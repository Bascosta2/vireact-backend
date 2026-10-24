import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeAttribution, attributionEventProperties } from '../src/utils/attribution.js';

test('keeps only whitelisted string fields', () => {
    const result = sanitizeAttribution({
        utm_source: 'tiktok',
        utm_medium: 'paid',
        email: 'someone@example.invalid',
        $where: 'sleep(1000)',
        utm_campaign: { $ne: null },
        utm_term: 42,
        landing_path: '/pricing',
    });
    assert.deepEqual(Object.keys(result).sort(), ['captured_at', 'landing_path', 'utm_medium', 'utm_source']);
    assert.equal(result.utm_source, 'tiktok');
    assert.ok(result.captured_at instanceof Date);
});

test('keeps the ref parameter', () => {
    const result = sanitizeAttribution({ ref: 'library' });
    assert.equal(result.ref, 'library');
    assert.deepEqual(attributionEventProperties(result), { ref: 'library' });
});

test('returns null for empty, non-object, or array input', () => {
    assert.equal(sanitizeAttribution(null), null);
    assert.equal(sanitizeAttribution('utm_source=x'), null);
    assert.equal(sanitizeAttribution(['tiktok']), null);
    assert.equal(sanitizeAttribution({ utm_source: '   ' }), null);
    assert.equal(sanitizeAttribution({ foo: 'bar' }), null);
});

test('clips long values and strips control characters', () => {
    const result = sanitizeAttribution({ utm_source: `a\u0000b\nc${'x'.repeat(500)}` });
    assert.equal(result.utm_source.length, 200);
    assert.ok(result.utm_source.startsWith('abc'));
});

test('drops landing_path that is not a site-relative path', () => {
    const result = sanitizeAttribution({ utm_source: 'x', landing_path: 'https://evil.example/' });
    assert.equal(result.landing_path, undefined);
});

test('uses client captured_at only when it is a valid past date', () => {
    const past = '2026-01-02T03:04:05.000Z';
    assert.equal(sanitizeAttribution({ utm_source: 'x', captured_at: past }).captured_at.toISOString(), past);

    const future = new Date(Date.now() + 86_400_000).toISOString();
    assert.ok(sanitizeAttribution({ utm_source: 'x', captured_at: future }).captured_at.getTime() <= Date.now());
    assert.ok(sanitizeAttribution({ utm_source: 'x', captured_at: 'nope' }).captured_at instanceof Date);
});

test('event properties exclude captured_at and empty fields', () => {
    const props = attributionEventProperties(sanitizeAttribution({ utm_source: 'yt', referrer: 'youtube.com' }));
    assert.deepEqual(props, { utm_source: 'yt', referrer: 'youtube.com' });
    assert.deepEqual(attributionEventProperties(null), {});
});
