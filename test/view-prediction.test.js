import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    predictViewBand,
    followerBand,
    datasetBand,
    normalizeFollowers,
    normalizePlatform,
    MIN_COMPARABLES,
} from '../src/service/view-prediction.service.js';

const noRatios = async () => [];

test('no follower count: keeps the strict score ceiling (no viral-skewed dataset numbers)', async () => {
    const band = await predictViewBand({ viralityScore: 43, followers: null, modelBand: { low: 40000, expected: 75000, high: 110000 }, findRatios: async () => { throw new Error('must not query'); } });
    assert.deepEqual(band, { low: 30, expected: 200, high: 1200, method: 'score', comparables: 0 });
});

test('small account: follower estimate never drops below what an unknown account would get', async () => {
    const band = await predictViewBand({ viralityScore: 40, followers: 200, modelBand: {}, findRatios: noRatios });
    assert.equal(band.method, 'followers');
    assert.equal(band.expected, 200);
});

test('large account: same weak video gets a range that scales with followers', async () => {
    const band = await predictViewBand({ viralityScore: 40, followers: 200000, modelBand: {}, findRatios: noRatios });
    assert.equal(band.method, 'followers');
    assert.equal(band.expected, 4000);
    assert.ok(band.low <= band.expected && band.expected <= band.high);
    assert.equal(band.high, 16000);
});

test('enough comparable real results: band comes from their views per follower', async () => {
    const ratios = Array.from({ length: MIN_COMPARABLES + 2 }, (_, i) => 0.01 * (i + 1)); // 1%..10%
    const band = await predictViewBand({ viralityScore: 60, followers: 10000, platform: 'tiktok', modelBand: {}, findRatios: async (q) => {
        assert.equal(q.platform, 'tiktok');
        return ratios;
    } });
    assert.equal(band.method, 'dataset');
    assert.equal(band.comparables, ratios.length);
    assert.ok(band.low < band.expected && band.expected < band.high);
    assert.equal(band.expected, 550); // median 5.5% of 10,000
});

test('too few comparables falls back to the follower estimate', async () => {
    const band = await predictViewBand({ viralityScore: 60, followers: 10000, modelBand: {}, findRatios: async () => [0.5, 0.6] });
    assert.equal(band.method, 'followers');
    assert.equal(band.comparables, 2);
});

test('input cleaning for followers and platform', () => {
    assert.equal(normalizeFollowers('12,500'), 12500);
    assert.equal(normalizeFollowers(''), null);
    assert.equal(normalizeFollowers(-5), null);
    assert.equal(normalizeFollowers('abc'), null);
    assert.equal(normalizePlatform('TikTok'), 'tiktok');
    assert.equal(normalizePlatform('myspace'), null);
    const fb = followerBand({ viralityScore: 90, followers: 1000 });
    assert.ok(fb.low <= fb.expected && fb.expected <= fb.high);
    const db = datasetBand({ ratios: [0.1, 0.2, 0.3], followers: 100, viralityScore: 50 });
    assert.ok(db.low <= db.expected && db.expected <= db.high);
});
