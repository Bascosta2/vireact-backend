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
    viewDrivers,
} from '../src/service/view-prediction.service.js';
import { contentSignals, editEnergy } from '../src/service/view-signals.js';

const noRatios = async () => [];
const ordered = (b) => b.low <= b.expected && b.expected <= b.high;

/** A stored-video-like object with feature scores and scenes. */
const videoLike = ({ pacing = 60, audio = 60, hook = 60, caption = 60, sceneSec = null, scenes = 0, sfx = 0, offCenter = 0, duration = 24 } = {}) => {
    const count = scenes || (sceneSec ? Math.round(duration / sceneSec) : 0);
    const len = count ? duration / count : 0;
    return {
        duration,
        analysis: [
            { feature: 'pacing', score: pacing }, { feature: 'audio', score: audio },
            { feature: 'hook', score: hook }, { feature: 'caption', score: caption },
        ],
        scenes: Array.from({ length: count }, (_, i) => ({
            sceneNumber: i + 1, startTime: i * len, endTime: (i + 1) * len,
            audioSummary: i < sfx ? 'Upbeat music with a whoosh sound effect on the cut' : 'Voiceover',
            visualDescription: i < offCenter ? 'Creator is off-center, partially out of frame' : 'Creator centered, talking to camera',
        })),
    };
};
const fastEdit = videoLike({ pacing: 82, audio: 80, hook: 72, sceneSec: 1.6, sfx: 8 });
const slowEdit = videoLike({ pacing: 38, audio: 50, hook: 42, caption: 38, sceneSec: 8, offCenter: 2 });
const predict = (o) => predictViewBand({ modelBand: {}, findRatios: noRatios, ...o });

test('the reported case: 9K followers and an engaging video is no longer told ~300 views', async () => {
    const band = await predict({ viralityScore: 62, followers: 9000 });
    assert.equal(band.method, 'followers');
    assert.ok(band.expected >= 900 && band.expected <= 1500, `expected ${band.expected}`);
    assert.ok(band.high >= 3000, `high ${band.high}`);
    assert.ok(ordered(band));
});

test('fast cuts and sound effects predict far more than slow, off-center, unclear edits', async () => {
    const fast = await predict({ viralityScore: 70, followers: 9000, signals: contentSignals(fastEdit) });
    const slow = await predict({ viralityScore: 70, followers: 9000, signals: contentSignals(slowEdit) });
    assert.ok(fast.expected > 3.5 * slow.expected, `fast ${fast.expected} vs slow ${slow.expected}`);
    assert.ok(fast.high > fast.expected * 4, 'strong energetic videos get a wide upside');
    const { boosts, drags } = editEnergy(contentSignals(fastEdit));
    assert.ok(boosts.includes('fast cuts') && boosts.includes('sound effects'));
    assert.ok(editEnergy(contentSignals(slowEdit)).drags.includes('slow cuts'));
    assert.ok(editEnergy(contentSignals(slowEdit)).drags.includes('off-center framing'));
    assert.equal(drags.length, 0);
});

test('still harsh on weak videos: low score, slow cuts, off-center', async () => {
    const weak = await predict({ viralityScore: 42, followers: 9000, signals: contentSignals(slowEdit) });
    assert.ok(weak.expected < 200, `expected ${weak.expected}`);
    assert.ok(weak.high < 700, `high ${weak.high}`);
});

test('more followers and a higher score both mean more views', async () => {
    const at = (score, followers) => predict({ viralityScore: score, followers });
    const small = await at(60, 1000);
    const mid = await at(60, 50000);
    const big = await at(60, 1000000);
    assert.ok(small.expected < mid.expected && mid.expected < big.expected);
    const weak = await at(45, 20000);
    const avg = await at(60, 20000);
    const strong = await at(85, 20000);
    assert.ok(weak.expected < avg.expected && avg.expected < strong.expected);
    assert.ok(strong.expected > 3 * avg.expected && avg.expected > 2 * weak.expected, 'quality moves predictions a lot');
});

test("the owner's real case still lands inside the range (200K followers, score 80, got 1.7K)", async () => {
    const band = await predict({ viralityScore: 80, followers: 200000 });
    assert.ok(band.low <= 1700 && 1700 <= band.high, JSON.stringify(band));
});

test('no follower count: a small-account estimate; the AI model band is ignored', async () => {
    const band = await predictViewBand({
        viralityScore: 43, followers: null, modelBand: { low: 40000, expected: 75000, high: 110000 },
        findRatios: async () => { throw new Error('must not query'); },
    });
    assert.equal(band.method, 'score');
    assert.ok(band.expected > 100 && band.expected < 260, `expected ${band.expected}`);
    assert.deepEqual(band.base, { low: band.low, expected: band.expected, high: band.high });
    assert.equal(band.learning, null);
});

test('unknown account size keeps a 25K cap below score 85; known big accounts are not capped', async () => {
    const unknown = await predict({ viralityScore: 84, followers: null, signals: contentSignals(fastEdit) });
    assert.ok(unknown.high <= 25000, `high ${unknown.high}`);
    const big = await predict({ viralityScore: 75, followers: 5000000, signals: contentSignals(fastEdit) });
    assert.ok(big.expected > 25000, `expected ${big.expected}`);
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
    assert.equal(band.expected, 550); // median 5.5% of 10,000, neutral edit
    const energetic = await predictViewBand({ viralityScore: 60, followers: 10000, modelBand: {}, signals: contentSignals(fastEdit), findRatios: async () => ratios });
    assert.ok(energetic.expected > 550, 'the edit still moves comparable-based predictions');
});

test('too few comparables falls back to the reach model', async () => {
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
    assert.ok(ordered(followerBand({ viralityScore: 90, followers: 1000 })));
    assert.ok(ordered(datasetBand({ ratios: [0.1, 0.2, 0.3], followers: 100, viralityScore: 50 })));
});

test('stored reports are shown with the current model (no reprocessing needed)', () => {
    const old = { viralityScore: 62, creatorFollowers: 9000, viewPredictionMethod: 'followers', predictedViewsLow: 80, predictedViewsExpected: 300, predictedViewsHigh: 1200 };
    const shown = displayViewBand(old);
    assert.ok(shown.expected >= 900, `the 9K report now shows ${shown.expected}`);
    const withEdit = displayViewBand({ ...old, ...fastEdit });
    assert.ok(withEdit.expected > shown.expected * 1.5, 'stored scenes and scores count when shown');
    const noFollowers = displayViewBand({ viralityScore: 60, predictedViewsLow: 20000, predictedViewsExpected: 75000, predictedViewsHigh: 120000 });
    assert.ok(noFollowers.expected > 400 && noFollowers.expected < 900, `expected ${noFollowers.expected}`);
    const oldDataset = displayViewBand({ viralityScore: 70, viewPredictionMethod: 'dataset', predictedViewsLow: 9000, predictedViewsExpected: 30000, predictedViewsHigh: 90000 });
    assert.ok(oldDataset.high <= 25000);
    assert.deepEqual(displayViewBand({ viralityScore: 60 }), { low: null, expected: null, high: null }, 'never predicted: nothing shown');
    assert.deepEqual(viewDrivers({ ...fastEdit }).drags, []);
});
