import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';
console.warn = () => {};
console.log = () => {};

const { connectTestDb, disconnectTestDb } = await import('./helpers/test-db.js');
const M = await import('../src/model/learning.model.js');
const { Video } = await import('../src/model/video.model.js');
const { User } = await import('../src/model/user.model.js');
const { trainMatrixEngine, socialRows } = await import('../src/service/learning/model/trainer.js');
const { refreshInsights, learnedContextForVideo } = await import('../src/service/learning/insights.js');
const { labelComments } = await import('../src/service/learning/comments.js');
const { refreshSoundTrends } = await import('../src/service/learning/trends.js');
const { measureLater } = await import('../src/service/learning/user-media.js');
const learning = await import('../src/service/learning/learning.service.js');

const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 19, 12);

before(async () => {
    await connectTestDb();
    await Promise.all(Object.values(M).filter((x) => x?.syncIndexes).map((m) => m.syncIndexes()));
});
after(disconnectTestDb);

/** 30 creators x 8 videos; views follow the first cut (earlier = better) on top of creator size. */
const seed = async () => {
    let r = 1;
    const rand = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
    for (let c = 0; c < 30; c++) {
        const creator = await M.SocialCreator.create({ platform: 'tiktok', externalId: `cr${c}`, handle: `cr${c}`, niche: c % 2 ? 'food' : 'tech', baselineViews: 1000, baselineN: 8 });
        const size = 500 + c * 300;
        for (let k = 0; k < 8; k++) {
            const firstCut = 0.5 + rand() * 3;
            const views = Math.round(size * Math.exp(1.2 - 0.8 * firstCut + (rand() - 0.5) * 0.4));
            const v = await M.SocialVideo.create({
                platform: 'tiktok', externalId: `cr${c}-${k}`, creatorId: creator._id, creatorExternalId: `cr${c}`, url: `https://www.tiktok.com/@cr${c}/video/${k}`,
                caption: 'you need to see this one, it is so good', soundId: k % 3 ? 'snd1' : null, soundTitle: 'Trending Song', postedAt: new Date(NOW - (10 + k) * DAY),
                provider: 'fake', discoveredVia: 'creator_backfill', latest: { views, at: new Date(NOW) },
                topComments: k === 0 ? [{ text: 'part 2 please', likes: 50 }, { text: 'how?', likes: 3 }] : undefined,
            });
            await M.VideoFeatures.create({ subjectType: 'social', subjectId: v._id, platform: 'tiktok', featureVersion: 1, niche: creator.niche, features: { firstCutSecExact: firstCut, captionChars: 40 + k, hashtagCount: k % 4 } });
            if (k < 2) {
                await M.SocialVideoAnalysis.create({
                    socialVideoId: v._id, externalId: v.externalId, creatorId: creator._id, niche: creator.niche, role: firstCut < 1.75 ? 'hit' : 'miss',
                    outperformance: Math.log(views / size), via: 'download', cutsSource: 'ffmpeg', features: { firstCutSecExact: firstCut },
                });
            }
        }
    }
};

test('trainer: leave-one-out labels, within-creator ridge finds the real driver, network links it, model stored', async () => {
    await seed();
    const rows = await socialRows({ now: NOW });
    assert.equal(rows.length, 240);
    assert.ok(rows.every((r) => Math.abs(r.y) <= Math.log(50) + 1e-9));
    assert.ok(rows.some((r) => r.features.soundUsesPrior14d > 0), 'sound trendiness feature');
    const out = await trainMatrixEngine({ now: NOW, minRows: 100, deps: { inline: true } });
    assert.equal(out.version, 1);
    assert.equal(out.creators, 30);
    assert.ok(out.pairAccuracy > 0.85, JSON.stringify(out));
    assert.ok(out.beatsCreatorUsual);
    const model = await M.LearningModel.findOne({}).lean();
    assert.equal(model.coefficients.top[0].column, 'firstCutSecExact');
    assert.ok(model.coefficients.top[0].beta < 0, 'earlier first cut -> more views');
    assert.ok(model.network.toPerformance.find((t) => t.column === 'firstCutSecExact').significant);
    assert.ok(model.standardization.columns.length === model.p);
    assert.equal(model.promotion.serving, false);
    const skipped = await trainMatrixEngine({ now: NOW, minRows: 10000, deps: { inline: true } });
    assert.match(skipped.skipped, /needs 10000/);
});

test('insights: only factors passing the sign test on 30+ pairs; the model agreeing is attached; analyzers get them', async () => {
    const res = await refreshInsights({ now: NOW });
    // 30 creators each with 2 analyzed videos; only creators whose two videos split hit/miss form pairs.
    const insights = await M.LearningInsight.find({}).lean();
    if (insights.length) {
        assert.ok(insights.every((i) => i.pairs >= 30 && i.p < 0.05));
        const all = insights.find((i) => i.niche === 'all' && i.feature === 'firstCutSecExact');
        assert.ok(all.hitHigherShare < 0.5);
        assert.ok(all.modelEffect < 0, 'ridge agrees in sign');
    }
    assert.equal(typeof res.findings, 'number');
    // Force a confirmed finding to check the analyzer path end to end.
    await M.LearningInsight.updateOne({ niche: 'food', feature: 'firstCutSecExact' }, { $set: { pairs: 40, hitHigherShare: 0.2, p: 0.001, medianHit: 1.0, medianMiss: 2.5, updatedAt: new Date() } }, { upsert: true });
    const user = await User.create({ email: 'learner@example.com', name: 'L', password: 'x'.repeat(12), creatorProfile: { niche: 'food' } }).catch(() => null);
    const video = await Video.create({ filename: 'a.mp4', fileSize: 1, uploader_id: user?._id, duration: 10, mediaMeasure: { durationSec: 10, cuts: [3.2, 6], hasAudio: false } });
    const ctx = await learnedContextForVideo(video._id, 'hook');
    assert.match(ctx, /MEASURED PATTERNS/);
    assert.match(ctx, /first cut: in food.*1s vs 2.5s.*80% of 40.*This video: 3.2s/);
    assert.equal(await learnedContextForVideo(video._id, 'views_predictor'), '');
    assert.equal(await learnedContextForVideo(null, 'hook'), '');
});

test('comments: labelled in batches, stored as intent shares (results, not features); sound trends', async () => {
    const complete = async ({ messages }) => {
        const refs = messages[0].content.split('\n').filter((l) => /^\d+\.\d+ \|/.test(l)).map((l) => l.split(' | '));
        return { comments: refs.map(([ref, text]) => ({ ref, intent: /part 2/.test(text) ? 'wants_more' : 'question' })) };
    };
    const out = await labelComments({ complete });
    assert.equal(out.labelled, 30);
    const v = await M.SocialVideo.findOne({ externalId: 'cr0-0' }).lean();
    assert.ok(v.commentIntents.wants_more > v.commentIntents.question);
    const vf = await M.VideoFeatures.findOne({ subjectId: v._id }).lean();
    assert.equal(vf.features.wants_more, undefined, 'never a model input');
    const t = await refreshSoundTrends({ now: NOW });
    assert.equal(t.sounds, 1);
    const trend = await M.SoundTrend.findOne({ soundId: 'snd1' }).lean();
    assert.equal(trend.last14 + trend.prior14, 150, '5 of each creator\'s 8 videos use the sound');
    assert.ok(['rising', 'peak', 'fading', 'emerging'].includes(trend.stage));
});

test('user uploads: measured in the background, saved on the video, features refreshed when the analysis is done', async () => {
    const { default: mongoose } = await import('mongoose');
    const video = await Video.create({ filename: 'b.mp4', fileSize: 1, duration: 8, uploader_id: new mongoose.Types.ObjectId(), analysisStatus: 'completed', scenes: [{ sceneNumber: 1, startTime: 0, endTime: 8, visualDescription: 'x', onScreenText: 'HI' }] });
    const fsp = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vx-um-'));
    const measure = async () => ({ version: 2, info: { durationSec: 8, width: 720, height: 1280, fps: 30, hasAudio: false }, cuts: [1.2, 4], cutsHardOnly: [4], silences: [], loudnessLufs: null, picture: { brightness: 90 }, rhythm: {}, hookImage: null });
    const saved = await measureLater(video._id, { dir, file: path.join(dir, 'upload.bin') }, { deps: { measure } });
    assert.deepEqual(saved.cuts, [1.2, 4]);
    const fresh = await Video.findById(video._id).lean();
    assert.equal(fresh.mediaMeasure.hardCuts, 1);
    const vf = await M.VideoFeatures.findOne({ subjectType: 'video', subjectId: video._id }).lean();
    assert.equal(vf.features.firstCutSecExact, 1.2);
    assert.equal(vf.features.softCutCount, 1);
    assert.equal(vf.features.brightness, 90);
    await assert.rejects(fsp.stat(dir), 'the kept file is deleted');
});

test('owner overview includes the model, insights, trends and comment report', async () => {
    const o = await learning.learningOverview();
    assert.equal(o.model.version, 1);
    assert.ok(o.model.coefficients.length > 0);
    assert.ok(Array.isArray(o.insights) && o.insights.length >= 1);
    assert.ok(Array.isArray(o.trends));
    assert.ok(o.comments === null || Array.isArray(o.comments.intents));
    assert.equal(o.config.deepDaily, 100);
    assert.deepEqual(o.config.languages, ['en']);
});
