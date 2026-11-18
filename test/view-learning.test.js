import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb } from './helpers/test-db.js';
import {
    LEARNING, applyLearnedModel, capPerUser, correctionFor, fitLearnedModel, residualOf, scoreBandOf,
} from '../src/service/view-learning.js';
import { predictViewBand, displayViewBand } from '../src/service/view-prediction.service.js';
import { Video } from '../src/model/video.model.js';
import { PredictionModel } from '../src/model/prediction-model.model.js';
import {
    getLearnedModel, markLearningStale, resetLearningCache, toObservation,
} from '../src/service/view-learning.service.js';
import { isEnglishSmallTalk } from '../src/service/chat.service.js';

const DAY = 24 * 60 * 60 * 1000;
const t0 = Date.UTC(2026, 0, 1);
/** n observations, `users` creators, each missing by `factor` (actual = base x factor). */
const obs = (n, factor, { users = n, platform = 'tiktok', scoreBand = '55-64', followers = true, start = 0 } = {}) =>
    Array.from({ length: n }, (_, i) => ({
        userId: `u${i % users}`, at: new Date(t0 + (start + i) * DAY), platform, scoreBand, followers, residual: Math.log(factor),
    }));

test('no results yet: nothing learned, predictions unchanged', () => {
    const model = fitLearnedModel([]);
    assert.equal(model.observations, 0);
    assert.equal(model.enabled, false);
    const band = { low: 100, expected: 300, high: 900 };
    assert.deepEqual(applyLearnedModel(model, band, { platform: 'tiktok', viralityScore: 60, followers: 1000 }), { band, learning: null });
    assert.deepEqual(applyLearnedModel(null, band, {}), { band, learning: null });
});

test('consistent over-prediction is learned, and beats the base on the newest results', () => {
    const model = fitLearnedModel(obs(40, 0.2));
    assert.equal(model.observations, 40);
    assert.equal(model.enabled, true);
    const factor = Math.exp(correctionFor(model, { platform: 'tiktok', scoreBand: '55-64', followers: true }).mu);
    assert.ok(factor < 0.35 && factor > 0.19, `learned factor ${factor}`);
    assert.ok(model.metrics.modelTypicalMiss < model.metrics.baseTypicalMiss);
    assert.ok(model.metrics.modelWithin2x > model.metrics.baseWithin2x);

    const out = applyLearnedModel(model, { low: 300, expected: 1000, high: 3000 }, { platform: 'tiktok', viralityScore: 60, followers: 5000 });
    assert.ok(out.band.expected < 400 && out.band.expected > 180, `expected ${out.band.expected}`);
    assert.ok(out.band.low <= out.band.expected && out.band.expected <= out.band.high);
    assert.equal(out.learning.observations, 40);
});

test('little data moves predictions only a little (shrinkage)', () => {
    const one = fitLearnedModel(obs(1, 10));
    const f = Math.exp(correctionFor(one, { platform: 'tiktok', scoreBand: '55-64', followers: true }).mu);
    assert.ok(f > 1 && f < 1.5, `one result of 10x should move the prediction far less than 10x, got ${f}`);
    const many = fitLearnedModel(obs(60, 10, { users: 20 }));
    assert.ok(Math.exp(many.global.mu) > 4, 'with many results the correction approaches the real miss');
});

test('one creator cannot steer the model, and wild values are clipped', () => {
    const spam = obs(200, 1e6, { users: 1 }).map((o) => ({ ...o, userId: 'spammer' }));
    const honest = obs(30, 1, { users: 30, start: 300 });
    const { kept } = capPerUser([...spam, ...honest]);
    assert.equal(kept.filter((o) => o.userId === 'spammer').length, LEARNING.MAX_PER_USER);
    const model = fitLearnedModel([...spam, ...honest]);
    assert.ok(Math.exp(model.global.mu) < 10, `spam should be contained, got x${Math.exp(model.global.mu)}`);
});

test('segments learn separately: under-predicted TikTok, over-predicted Instagram', () => {
    const model = fitLearnedModel([...obs(30, 4, { platform: 'tiktok' }), ...obs(30, 0.25, { platform: 'instagram', start: 30 })]);
    const tiktok = Math.exp(correctionFor(model, { platform: 'tiktok', scoreBand: '55-64', followers: true }).mu);
    const insta = Math.exp(correctionFor(model, { platform: 'instagram', scoreBand: '55-64', followers: true }).mu);
    assert.ok(tiktok > 2 && insta < 0.5, `tiktok x${tiktok}, instagram x${insta}`);
    // An unseen segment falls back to its platform.
    const unseen = Math.exp(correctionFor(model, { platform: 'tiktok', scoreBand: '85+', followers: false }).mu);
    assert.ok(unseen > 1.5 && unseen <= tiktok, `unseen segment x${unseen}`);
});

test('a correction that would make predictions worse switches itself off', () => {
    // Older results said "predict higher"; the newest say the opposite, so what was learned fails the holdout.
    const model = fitLearnedModel([...obs(32, 8, { users: 32 }), ...obs(8, 0.125, { users: 8, start: 100 })]);
    assert.equal(model.enabled, false);
    const band = { low: 100, expected: 300, high: 900 };
    assert.equal(applyLearnedModel(model, band, { platform: 'tiktok', viralityScore: 60, followers: 1 }).learning, null);
});

test('an upward correction can lift the 5,000 cap for ordinary scores', () => {
    const model = fitLearnedModel(obs(40, 3));
    const out = applyLearnedModel(model, { low: 2000, expected: 4000, high: 5000 }, { platform: 'tiktok', viralityScore: 60, followers: 100000 });
    assert.ok(out.band.expected > 5000, `expected ${out.band.expected}`);
});

test('prediction keeps the base band, shows the learned one, and the stored learned band is displayed as made', async () => {
    const learned = { ...fitLearnedModel(obs(40, 0.5)), version: 7 };
    const views = await predictViewBand({
        viralityScore: 60, followers: 20000, platform: 'tiktok', modelBand: {}, learned, findRatios: async () => [],
    });
    assert.equal(views.method, 'followers');
    assert.ok(views.expected < views.base.expected);
    assert.equal(views.learning.version, 7);
    const stored = {
        viralityScore: 60, creatorFollowers: 20000, viewPredictionMethod: 'followers',
        predictedViewsLow: views.low, predictedViewsExpected: views.expected, predictedViewsHigh: views.high, viewLearning: views.learning,
    };
    assert.equal(displayViewBand(stored).expected, views.expected, 'not recomputed from followers');
    assert.equal(scoreBandOf(60), '55-64');
    assert.ok(Math.abs(residualOf(99, 9) - Math.log(10)) < 1e-9);
});

test('coach: canned English replies only for English small talk', () => {
    assert.equal(isEnglishSmallTalk('Thanks so much!'), true);
    assert.equal(isEnglishSmallTalk('hey there'), true);
    assert.equal(isEnglishSmallTalk('hola'), false);
    assert.equal(isEnglishSmallTalk('gracias!'), false);
    assert.equal(isEnglishSmallTalk('obrigado 🙏'), false);
    assert.equal(isEnglishSmallTalk('thanks, why did people leave at 0:07?'), false);
    assert.equal(isEnglishSmallTalk(''), false);
});

// ---- with the database: what counts as a result, and refitting when results change
let user;
before(async () => {
    await connectTestDb();
    await PredictionModel.deleteMany({});
    await Video.deleteMany({ filename: /^learn-test-/ });
    user = new mongoose.Types.ObjectId();
});
after(async () => {
    await Video.deleteMany({ filename: /^learn-test-/ });
    await PredictionModel.deleteMany({});
    resetLearningCache();
    await disconnectTestDb();
});

const makeVideo = (i, { actual, base, postedDaysAgo = 10, capturedDaysAgo = 1 }) => Video.create({
    filename: `learn-test-${i}.mp4`, fileSize: 1, uploadStatus: 'completed', analysisStatus: 'completed', uploader_id: new mongoose.Types.ObjectId(),
    viralityScore: 60, creatorPlatform: 'tiktok', creatorFollowers: 5000,
    predictedViewsLow: base / 3, predictedViewsExpected: base, predictedViewsHigh: base * 3, viewPredictionMethod: 'dataset',
    viewBase: { low: base / 3, expected: base, high: base * 3 },
    postedAt: new Date(Date.now() - postedDaysAgo * DAY),
    actualViews: actual, actualViewsReportedAt: new Date(Date.now() - capturedDaysAgo * DAY),
    performanceSnapshots: [{ capturedAt: new Date(Date.now() - capturedDaysAgo * DAY), views: actual, source: 'manual' }],
});

test('views logged in the first two days are not used; settled ones are', async () => {
    const fresh = (await makeVideo('fresh', { actual: 50, base: 1000, postedDaysAgo: 1.5, capturedDaysAgo: 0 })).toObject();
    assert.equal(toObservation(fresh), null);
    const settled = (await makeVideo('settled', { actual: 100, base: 1000, postedDaysAgo: 10, capturedDaysAgo: 2 })).toObject();
    const o = toObservation(settled);
    assert.ok(o && Math.abs(o.residual - residualOf(100, 1000)) < 1e-9);
    assert.equal(o.followers, true);
});

test('the model refits when results change and is reused when they do not', async () => {
    resetLearningCache();
    const first = await getLearnedModel();
    assert.ok(first.version >= 1);
    const again = await getLearnedModel({ now: Date.now() + 11 * 60 * 1000 });
    assert.equal(again.version, first.version, 'same results, same model');

    for (let i = 0; i < 25; i++) await makeVideo(`batch-${i}`, { actual: 200, base: 1000 });
    markLearningStale();
    const next = await getLearnedModel();
    assert.ok(next.version > first.version);
    assert.ok(next.observations >= 25);
    assert.ok(Math.exp(next.global.mu) < 0.6, `learned that predictions run high: x${Math.exp(next.global.mu)}`);
    void user;
});
