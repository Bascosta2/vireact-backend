import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
console.warn = () => {};
console.log = () => {};

const { connectTestDb, disconnectTestDb } = await import('./helpers/test-db.js');
const { User } = await import('../src/model/user.model.js');
const { Video } = await import('../src/model/video.model.js');
const { VideoPerformanceDataset } = await import('../src/model/VideoPerformanceDataset.model.js');
const { VideoFeatures, OutcomeSnapshot, SocialCreator, SocialVideo, LearningRun } = await import('../src/model/learning.model.js');
const learning = await import('../src/service/learning/learning.service.js');
const { runCollection } = await import('../src/service/learning/social/collector.js');
const { labelPending } = await import('../src/service/learning/classifier.js');
const { addSnapshot, deleteSnapshot } = await import('../src/service/performance.service.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 17, 12);
const settle = () => new Promise((r) => setTimeout(r, 150));

before(async () => {
    await connectTestDb();
    await Promise.all([VideoFeatures, OutcomeSnapshot, SocialCreator, SocialVideo].map((m) => m.syncIndexes()));
});
after(disconnectTestDb);

/** Fake provider: three creators, each with hits and misses; counts every record as billable. */
const fakeProvider = () => {
    const calls = { search: 0, creator: 0, stats: 0 };
    const vid = (creator, i, views, daysAgo) => ({
        externalId: `${creator}-v${i}`, creatorExternalId: creator, url: `https://www.tiktok.com/@${creator}/video/${i}`,
        caption: `clip ${i} #fyp #gym`, hashtags: ['fyp', 'gym'], soundTitle: i % 2 ? 'original sound' : 'Trending Song', durationSec: 20 + i,
        postedAt: new Date(NOW - daysAgo * DAY).toISOString(), views, likes: Math.round(views / 10),
    });
    return {
        name: 'fake',
        calls,
        async searchVideos({ query }) {
            calls.search += 1;
            const videos = [vid('c1', 0, 50000, 10), vid('c2', 0, 900, 9), { externalId: 'bad id!', views: 1 }];
            return { videos, creators: [{ externalId: 'c1', handle: 'creator1', followers: 12000 }], used: videos.length, query };
        },
        async creatorVideos({ externalId }) {
            calls.creator += 1;
            const videos = [1, 2, 3, 4, 5].map((i) => vid(externalId, i, 1000 * i, 8 + i));
            return { videos, creator: { externalId, handle: `${externalId}-handle`, followers: 5000 }, used: videos.length };
        },
        async videoStats({ ids }) {
            calls.stats += 1;
            return { stats: ids.map((externalId) => ({ externalId, views: 77777 })), used: ids.length };
        },
    };
};

test('collection: discovers, backfills creators (hits and misses), sets baselines, validates, respects the budget', async () => {
    const provider = fakeProvider();
    const plan = [{ niche: 'fitness_health', subNiche: 'gym_training', query: 'gym training' }];
    const out = await runCollection({ provider, budget: 1000, now: NOW, plan });
    assert.equal(out.errors, 0);
    assert.equal(out.discovered, 2, 'the invalid record was dropped');
    assert.equal(out.newCreators, 2, 'c2 tracked even though the search did not list it');
    assert.equal(provider.calls.creator, 2);
    assert.equal(out.backfilled, 10);
    const c1 = await SocialCreator.findOne({ externalId: 'c1' }).lean();
    assert.equal(c1.followers, 5000);
    assert.equal(c1.niche, 'fitness_health');
    assert.ok(c1.backfilledAt);
    assert.equal(c1.baselineN, 6, 'baseline uses every settled video, the viral one included');
    assert.equal(c1.baselineViews, 3500);
    assert.equal(await SocialVideo.countDocuments({}), 12);
    assert.equal(await OutcomeSnapshot.countDocuments({ subjectType: 'social', source: 'provider' }), 12);
    const f = await VideoFeatures.findOne({ subjectType: 'social' }).lean();
    assert.ok(f.features.durationSec > 0);
    assert.equal(f.niche, 'fitness_health');

    // Same day again: nothing duplicated.
    await runCollection({ provider, budget: 1000, now: NOW, plan });
    assert.equal(await SocialVideo.countDocuments({}), 12);
    assert.equal(await OutcomeSnapshot.countDocuments({ subjectType: 'social' }), 12);

    // Two days later: young videos are re-checked, the reading is stored as a new snapshot.
    await SocialVideo.updateMany({}, { $set: { nextCheckAt: new Date(NOW + DAY) } });
    const later = await runCollection({ provider, budget: 1000, now: NOW + 2 * DAY, plan: [] });
    assert.equal(later.rechecked, 12);
    assert.equal((await SocialVideo.findOne({ externalId: 'c1-v0' }).lean()).latest.views, 77777);
    assert.equal(await OutcomeSnapshot.countDocuments({ subjectType: 'social' }), 24);

    // Budget: a tiny budget stops before the backfill.
    const tight = fakeProvider();
    const t = await runCollection({ provider: tight, budget: 3, now: NOW, plan });
    assert.equal(tight.calls.creator, 0);
    assert.ok(t.used <= 3 + 3, 'stops after the call that reached the budget');
    assert.equal((await runCollection({ provider: null, budget: 10 })).skipped, 'no provider configured');
});

test('a failing provider call is counted, not fatal', async () => {
    const provider = { name: 'broken', async searchVideos() { throw new Error('rate limited'); }, async creatorVideos() { throw new Error('x'); }, async videoStats() { throw new Error('x'); } };
    const out = await runCollection({ provider, budget: 100, now: NOW, plan: [{ niche: 'food', subNiche: 'recipes', query: 'recipes' }] });
    assert.ok(out.errors >= 1);
});

test("users' videos: features on analysis, outcomes follow logged views, deletion removes both", async () => {
    const user = await User.create({ name: 'L', email: `learn-${Date.now()}@example.invalid`, password: 'pw-123456', isEmailVerified: true, creatorProfile: { niche: 'tech' } });
    const video = await Video.create({
        filename: 'desk.mp4', fileSize: 10, uploadStatus: 'completed', analysisStatus: 'completed', uploader_id: user._id,
        duration: 10, viralityScore: 70, creatorPlatform: 'tiktok', creatorFollowers: 9000, postedAt: new Date(NOW - 9 * DAY),
        analysis: [{ feature: 'hook', score: 80 }], scenes: [{ sceneNumber: 1, startTime: 0, endTime: 2 }, { sceneNumber: 2, startTime: 2, endTime: 6 }, { sceneNumber: 3, startTime: 6, endTime: 10 }],
        predictedViewsLow: 300, predictedViewsExpected: 1200, predictedViewsHigh: 4000, viewBase: { low: 250, expected: 1000, high: 3500 },
    });
    learning.onVideoAnalyzed(video);
    await settle();
    const f = await VideoFeatures.findOne({ subjectType: 'video', subjectId: video._id }).lean();
    assert.equal(f.niche, 'tech');
    assert.equal(f.labelSource, 'creator_profile');
    assert.equal(f.features.hookScore, 80);
    assert.equal(f.creatorKey, `user:${user._id}`);

    await addSnapshot(user._id, video._id, { views: 2500, capturedAt: new Date(NOW - 2 * DAY).toISOString() });
    await settle();
    const outcomes = await OutcomeSnapshot.find({ subjectType: 'video', subjectId: video._id }).lean();
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].source, 'user_reported');
    assert.equal(Math.round(outcomes[0].ageHours), 7 * 24);

    const card = await learning.reportCard({ now: NOW });
    assert.equal(card.live.n, 1);
    assert.equal(card.rulesOnly.n, 1);
    assert.ok(card.ownerCases.every((c) => c.pass));

    const stored = await Video.findById(video._id).lean();
    await deleteSnapshot(user._id, video._id, stored.performanceSnapshots[0]._id);
    await settle();
    assert.equal(await OutcomeSnapshot.countDocuments({ subjectType: 'video', subjectId: video._id }), 0, 'deleted reading is gone');

    await learning.removeVideoLearningData(video._id);
    assert.equal(await VideoFeatures.countDocuments({ subjectType: 'video', subjectId: video._id }), 0);
});

test('backfill covers existing uploads and admin examples; inventory counts labelled data', async () => {
    const user = await User.create({ name: 'B', email: `backfill-${Date.now()}@example.invalid`, password: 'pw-123456', isEmailVerified: true });
    await Video.create({
        filename: 'old.mp4', fileSize: 10, uploadStatus: 'completed', analysisStatus: 'completed', uploader_id: user._id, viralityScore: 55,
        performanceSnapshots: [{ capturedAt: new Date(NOW - DAY), views: 400 }], actualViews: 400,
    });
    await VideoPerformanceDataset.create({ sourceType: 'creator_video', platform: 'tiktok', actualViews: 2_000_000, status: 'complete', niche: 'food', creatorHandle: '@Chef', editProfile: { cutsPerMin: 40 } });
    const out = await learning.backfillLearning();
    assert.ok(out.videos >= 1 && out.dataset === 1);
    const ex = await VideoFeatures.findOne({ subjectType: 'dataset' }).lean();
    assert.equal(ex.niche, 'food');
    assert.equal(ex.labelSource, 'admin');
    assert.equal(ex.creatorKey, 'handle:tiktok:chef');
    assert.equal((await learning.backfillLearning()).dataset, 0, 'second run has nothing to do');

    const inv = await learning.dataInventory();
    assert.ok(inv.labelled.bySubject.social >= 12);
    assert.equal(inv.labelled.bySubject.dataset, 1);
    assert.ok(inv.labelled.bySubject.video >= 1, 'age unknown counts');
    assert.equal(inv.nextMilestone.at, 300);
    assert.ok(inv.social.creatorsWithBaseline >= 1);
});

test('classifier labels pending videos in batches and keeps going when a batch fails', async () => {
    let calls = 0;
    const complete = async ({ messages }) => {
        calls += 1;
        const refs = [...messages[0].content.matchAll(/^(V\d+) \|/gm)].map((m) => m[1]);
        return { videos: refs.map((ref) => ({ ref, niche: 'fitness_health', subNiche: 'gym_training', format: 'tutorial', hookPattern: 'bold_claim', confidence: 0.8 })) };
    };
    const out = await labelPending({ limit: 100, complete });
    assert.ok(out.labelled > 0 && out.failed === 0, JSON.stringify(out));
    assert.ok(calls >= 1);
    const labelled = await VideoFeatures.findOne({ subjectType: 'social', labelSource: 'ai' }).lean();
    assert.equal(labelled.subNiche, 'gym_training');
    assert.equal(labelled.taxonomyVersion, 1);
    assert.equal((await labelPending({ limit: 100, complete })).candidates, 0, 'nothing left to label');
    await VideoFeatures.updateMany({}, { $set: { labelSource: null } });
    const failing = await labelPending({ limit: 100, complete: async () => { throw new Error('quota'); } });
    assert.equal(failing.labelled, 0);
    assert.ok(failing.failed > 0);
});

test('daily job runs every step, records the run, and refuses to overlap', async () => {
    const provider = fakeProvider();
    const complete = async () => ({ videos: [] });
    const result = await learning.runDailyLearning({
        now: NOW, config: { enabled: true, dailyRecords: 200, labelLimit: 50 }, deps: { getProvider: () => provider, complete }, log: () => {},
    });
    assert.equal(result.status, 'done');
    const run = await LearningRun.findById(result.runId).lean();
    assert.deepEqual(run.steps.map((s) => s.name), ['backfill', 'collect', 'label', 'inventory', 'report_card']);
    assert.ok(run.steps.every((s) => s.ok), JSON.stringify(run.steps));
    assert.equal(run.provider, 'fake');
    assert.ok(run.inventory.labelled.total > 0);
    assert.ok(run.reportCard.ownerCases.length === 2);

    const noProvider = await learning.runDailyLearning({ now: NOW, config: { enabled: true, dailyRecords: 0, labelLimit: 0 }, deps: { getProvider: () => null }, log: () => {} });
    const r2 = await LearningRun.findById(noProvider.runId).lean();
    assert.equal(r2.steps.find((s) => s.name === 'collect').counts.skipped, 'no provider configured (LEARNING_PROVIDER)');

    const overview = await learning.learningOverview();
    assert.ok(overview.runs.length >= 2);
    assert.equal(typeof overview.config.enabled, 'boolean');
});

test('settings: off unless LEARNING_ENABLED=true; budgets parse safely', () => {
    assert.equal(learning.learningConfig({}).enabled, false);
    assert.equal(learning.learningConfig({ LEARNING_ENABLED: 'TRUE' }).enabled, true);
    assert.equal(learning.learningConfig({ LEARNING_DAILY_RECORDS: '-5' }).dailyRecords, 2000);
    assert.equal(learning.learningConfig({ LEARNING_DAILY_RECORDS: '500' }).dailyRecords, 500);
    assert.equal(learning.learningConfig({ LEARNING_PROVIDER: ' Bright ' }).provider, 'bright');
});
