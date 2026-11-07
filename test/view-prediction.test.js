import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    predictViewBand,
    followerBand,
    datasetBand,
    normalizeFollowers,
    normalizePlatform,
    MIN_COMPARABLES,
    displayViewBand,
} from '../src/service/view-prediction.service.js';

const noRatios = async () => [];

test('no follower count: keeps the strict score ceiling (no viral-skewed dataset numbers)', async () => {
    const band = await predictViewBand({ viralityScore: 43, followers: null, modelBand: { low: 40000, expected: 75000, high: 110000 }, findRatios: async () => { throw new Error('must not query'); } });
    assert.deepEqual(band, { low: 20, expected: 100, high: 400, method: 'score', comparables: 0 });
});

test('small account: follower estimate never drops below what an unknown account would get', async () => {
    const band = await predictViewBand({ viralityScore: 40, followers: 200, modelBand: {}, findRatios: noRatios });
    assert.equal(band.method, 'followers');
    assert.equal(band.expected, 100);
});

test('large account: same weak video gets a range that scales with followers', async () => {
    const band = await predictViewBand({ viralityScore: 40, followers: 2000000, modelBand: {}, findRatios: noRatios });
    assert.equal(band.method, 'followers');
    assert.equal(band.expected, 800); // 0.04% of 2M
    assert.ok(band.low <= band.expected && band.expected <= band.high);
    assert.equal(band.high, 2400);
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

test('recalibration: the owner test case (predicted ~157K, got 1.7K) now lands near the real result', async () => {
    // A 200K-follower account with a good but not standout video (score 80).
    const band = await predictViewBand({ viralityScore: 80, followers: 200000, modelBand: {}, findRatios: noRatios });
    assert.equal(band.expected, 1200);
    assert.ok(band.high <= 5000, `high ${band.high}`);
    assert.ok(band.low <= 1700 && 1700 <= band.high, 'real result inside the range');
});

test('nothing above 5,000 views unless the overall score is 85+', async () => {
    for (const score of [30, 55, 70, 84]) {
        const followers = await predictViewBand({ viralityScore: score, followers: 5000000, modelBand: {}, findRatios: noRatios });
        const comparables = await predictViewBand({ viralityScore: score, followers: 5000000, modelBand: {}, findRatios: async () => Array(10).fill(0.5) });
        const model = await predictViewBand({ viralityScore: score, followers: null, modelBand: { low: 90000, expected: 150000, high: 400000 } });
        for (const band of [followers, comparables, model]) assert.ok(band.high <= 5000, `score ${score}: ${JSON.stringify(band)}`);
    }
    const standout = await predictViewBand({ viralityScore: 90, followers: 1000000, modelBand: {}, findRatios: noRatios });
    assert.ok(standout.expected > 5000, 'a standout video from a big account can exceed 5K');
});

test('stored reports made under the old rules are corrected when shown', () => {
    const old = { viralityScore: 80, creatorFollowers: 200000, viewPredictionMethod: 'followers', predictedViewsLow: 15000, predictedViewsExpected: 60000, predictedViewsHigh: 157000 };
    const shown = displayViewBand(old);
    assert.equal(shown.expected, 1200);
    assert.ok(shown.high <= 5000);
    const oldScore = displayViewBand({ viralityScore: 60, predictedViewsLow: 20000, predictedViewsExpected: 75000, predictedViewsHigh: 120000 });
    assert.deepEqual([oldScore.low, oldScore.expected, oldScore.high], [80, 300, 1200]);
    const oldDataset = displayViewBand({ viralityScore: 70, viewPredictionMethod: 'dataset', predictedViewsLow: 9000, predictedViewsExpected: 30000, predictedViewsHigh: 90000 });
    assert.ok(oldDataset.high <= 5000);
});
