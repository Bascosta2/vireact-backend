import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb, fakeRes } from './helpers/test-db.js';
import { User } from '../src/model/user.model.js';
import { Video } from '../src/model/video.model.js';
import { addSnapshot, deleteSnapshot, setPostDetails, migrateLegacyActualViews, MAX_SNAPSHOTS } from '../src/service/performance.service.js';
import { reportActualViews } from '../src/controller/video.controller.js';
import { getAnalyticsOverview, getAnalyticsVideos, updateCreatorProfile } from '../src/controller/analytics.controller.js';

before(async () => { await connectTestDb(); });
after(async () => { await disconnectTestDb(); });

const newUser = (suffix) =>
    User.create({ name: 'Test', email: `analytics-${suffix}-${Date.now()}@example.invalid`, password: 'pw-123456', isEmailVerified: true });

const newVideo = (userId, extra = {}) => Video.create({
    filename: 'clip.mp4', fileSize: 1000, uploader_id: userId, analysisStatus: 'completed', viralityScore: 55,
    predictedViewsLow: 20, predictedViewsExpected: 100, predictedViewsHigh: 400, viewPredictionMethod: 'score', ...extra,
});

const call = async (handler, req) => {
    const res = fakeRes();
    let error = null;
    await handler(req, res, (err) => { error = err; });
    return { res, error };
};

test('snapshots: actualViews mirrors the newest; delete rolls back; cap at MAX_SNAPSHOTS', async () => {
    const user = await newUser('snap');
    const video = await newVideo(user._id);

    await addSnapshot(user._id, video._id, { views: 300, capturedAt: new Date(Date.now() - 1000) });
    let out = await addSnapshot(user._id, video._id, { views: 100, capturedAt: new Date(Date.now() - 86_400_000) });
    assert.equal(out.actualViews, 300, 'an older snapshot must not overwrite the newest');
    assert.deepEqual(out.snapshots.map((s) => s.views), [100, 300]);

    out = await deleteSnapshot(user._id, video._id, out.snapshots[1].id);
    assert.equal(out.actualViews, 100);
    out = await deleteSnapshot(user._id, video._id, out.snapshots[0].id);
    assert.equal(out.actualViews, null);
    assert.equal((await Video.findById(video._id)).actualViewsReportedAt, null);

    for (let i = 0; i < MAX_SNAPSHOTS + 2; i += 1) {
        await addSnapshot(user._id, video._id, { views: i, capturedAt: new Date(Date.now() - (100 - i) * 60_000) });
    }
    const stored = await Video.findById(video._id);
    assert.equal(stored.performanceSnapshots.length, MAX_SNAPSHOTS);
    assert.equal(stored.actualViews, MAX_SNAPSHOTS + 1);
});

test('ownership: another user cannot read or write results', async () => {
    const owner = await newUser('owner');
    const other = await newUser('other');
    const video = await newVideo(owner._id);
    await assert.rejects(addSnapshot(other._id, video._id, { views: 5 }), (e) => e.statusCode === 404);
    await assert.rejects(setPostDetails(other._id, video._id, { postUrl: 'https://x.com/a' }), (e) => e.statusCode === 404);
    await assert.rejects(addSnapshot(owner._id, 'not-an-id', { views: 5 }), (e) => e.statusCode === 404);
});

test('post details: partial updates and validation', async () => {
    const user = await newUser('post');
    const video = await newVideo(user._id, { creatorPlatform: 'tiktok' });
    const out = await setPostDetails(user._id, video._id, { postedAt: '2026-11-01T18:00:00Z', postUrl: 'https://www.tiktok.com/@me/video/1' });
    assert.equal(out.postUrl, 'https://www.tiktok.com/@me/video/1');
    assert.equal(out.creatorPlatform, 'tiktok', 'platform untouched when not sent');
    await assert.rejects(setPostDetails(user._id, video._id, { postUrl: 'ftp://nope' }), (e) => e.statusCode === 400);
    await assert.rejects(setPostDetails(user._id, video._id, { platform: 'myspace' }), (e) => e.statusCode === 400);
});

test('legacy PATCH actual-views still works and now writes a snapshot', async () => {
    const user = await newUser('legacy');
    const video = await newVideo(user._id);
    const { res, error } = await call(reportActualViews, { user, params: { videoId: String(video._id) }, body: { views: '1,840', followers: 2000 } });
    assert.equal(error, null);
    assert.equal(res.body.data.actualViews, 1840);
    assert.equal(res.body.data.creatorFollowers, 2000);
    const stored = await Video.findById(video._id);
    assert.equal(stored.performanceSnapshots.length, 1);
});

test('migration gives legacy actualViews a snapshot and is idempotent', async () => {
    const user = await newUser('migrate');
    const reportedAt = new Date('2026-10-01T00:00:00Z');
    const video = await newVideo(user._id, { actualViews: 777, actualViewsReportedAt: reportedAt });
    const first = await migrateLegacyActualViews();
    assert.ok(first.modified >= 1);
    const stored = await Video.findById(video._id);
    assert.equal(stored.performanceSnapshots.length, 1);
    assert.equal(stored.performanceSnapshots[0].views, 777);
    assert.equal(stored.performanceSnapshots[0].capturedAt.toISOString(), reportedAt.toISOString());
    const second = await migrateLegacyActualViews();
    assert.equal(second.matched, 0);
});

test('overview and videos endpoints only see the caller\'s ready videos', async () => {
    const user = await newUser('overview');
    const stranger = await newUser('stranger');
    const mine = await newVideo(user._id, { viralityScore: 70 });
    await newVideo(user._id, { analysisStatus: 'processing', viralityScore: undefined });
    await newVideo(stranger._id, { viralityScore: 10 });
    await addSnapshot(user._id, mine._id, { views: 900 });

    const { res, error } = await call(getAnalyticsOverview, { user, query: { range: '30d' } });
    assert.equal(error, null);
    assert.equal(res.body.data.kpis.videosAnalyzed, 1);
    assert.equal(res.body.data.kpis.avgScore, 70);
    assert.equal(res.body.data.kpis.viewsLogged, 900);

    const rows = await call(getAnalyticsVideos, { user, query: {} });
    assert.equal(rows.res.body.data.videos.length, 1);
    assert.equal(rows.res.body.data.videos[0].outcome, 'beat');
});

test('PUT profile saves and resolves as the saved source', async () => {
    const user = await newUser('profile');
    const { res, error } = await call(updateCreatorProfile, {
        user,
        body: { niche: 'food', platforms: ['tiktok', 'instagram'], goal: 'grow_followers', postsPerWeek: 4, preferredDays: [1, 3], timezone: 'America/Chicago' },
    });
    assert.equal(error, null);
    assert.equal(res.body.data.source, 'saved');
    assert.equal(res.body.data.complete, true);
    const bad = await call(updateCreatorProfile, { user, body: { niche: 'food' } });
    assert.equal(bad.error.statusCode, 400);
    assert.ok(mongoose.isValidObjectId(user._id));
});
