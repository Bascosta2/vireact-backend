import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, disconnectTestDb, fakeRes } from './helpers/test-db.js';
import { User } from '../src/model/user.model.js';
import { Video } from '../src/model/video.model.js';
import { Subscription } from '../src/model/subscription.model.js';
import { ContentStrategy } from '../src/model/content-strategy.model.js';
import { createStrategy, getStrategy, strategyUsage, updateStrategySlot } from '../src/controller/analytics.controller.js';
import { STRATEGY_LIMITS } from '../src/constants.js';

before(async () => {
    await connectTestDb();
    await ContentStrategy.createIndexes();
});
after(async () => { await disconnectTestDb(); });

const PROFILE = { niche: 'tech', platforms: ['youtube'], goal: 'more_views', postsPerWeek: 2, preferredDays: [], timezone: 'UTC', updatedAt: new Date() };

const newUser = async (suffix, plan, profile = PROFILE) => {
    const user = await User.create({
        name: 'Test', email: `strategy-${suffix}-${Date.now()}@example.invalid`, password: 'pw-123456', isEmailVerified: true, creatorProfile: profile,
    });
    const start = new Date(Date.now() - 5 * 86_400_000);
    await Subscription.create({ userId: user._id, plan, currentPeriodStart: start, currentPeriodEnd: new Date(start.getTime() + 30 * 86_400_000) });
    return user;
};

const call = async (handler, req) => {
    const res = fakeRes();
    let error = null;
    await handler(req, res, (err) => { error = err; });
    return { res, error };
};

const readyPlan = (userId, extra = {}) => ContentStrategy.create({
    userId,
    status: 'ready',
    generatedAt: new Date(),
    confidence: 'low',
    schedule: { startDate: '2026-11-09', endDate: '2026-11-20', timezone: 'UTC', slots: [{ id: 's1', date: '2026-11-09', timeLocal: '18:00', title: 'A' }] },
    ...extra,
});

test('free plan is locked (403 UPGRADE_REQUIRED) and nothing is claimed', async () => {
    const user = await newUser('free', 'free');
    const { error } = await call(createStrategy, { user, body: {} });
    assert.equal(error.statusCode, 403);
    assert.equal(error.data.code, 'UPGRADE_REQUIRED');
    assert.equal(await ContentStrategy.countDocuments({ userId: user._id }), 0);
});

test('premium cap counts ready plans this period only; failed ones are free', async () => {
    const user = await newUser('cap', 'premium');
    for (let i = 0; i < STRATEGY_LIMITS.premium; i += 1) await readyPlan(user._id);
    await ContentStrategy.create({ userId: user._id, status: 'failed', startedAt: new Date() });
    await readyPlan(user._id, { generatedAt: new Date(Date.now() - 60 * 86_400_000) }); // previous period
    const usage = await strategyUsage(user._id);
    assert.equal(usage.used, STRATEGY_LIMITS.premium);
    assert.equal(usage.remaining, 0);
    const { error } = await call(createStrategy, { user, body: {} });
    assert.equal(error.statusCode, 429);
    assert.equal(error.data.code, 'STRATEGY_LIMIT');
});

test('incomplete profile is rejected before any AI call', async () => {
    const user = await newUser('noprofile', 'pro', null);
    const { error } = await call(createStrategy, { user, body: {} });
    assert.equal(error.statusCode, 400);
    assert.equal(error.data.code, 'PROFILE_INCOMPLETE');
});

test('a fresh generating claim blocks a second one (409); a stale claim is released', async () => {
    const user = await newUser('claim', 'pro');
    const clip = await Video.create({ filename: 'c.mp4', fileSize: 1, uploader_id: user._id, analysisStatus: 'completed', viralityScore: 50 });
    await ContentStrategy.create({ userId: user._id, status: 'generating', startedAt: new Date() });
    const blocked = await call(createStrategy, { user, body: {} });
    assert.equal(blocked.error.statusCode, 409);
    await Video.deleteOne({ _id: clip._id }); // so the next attempt stops before any AI call

    await ContentStrategy.updateMany({ userId: user._id }, { $set: { startedAt: new Date(Date.now() - 10 * 60_000) } });
    // The stale claim is released; with no analyzed videos it then stops before any AI call.
    const attempt = await call(createStrategy, { user, body: {} });
    assert.equal(attempt.error.statusCode, 400);
    assert.equal(attempt.error.data.code, 'NO_VIDEOS');
    assert.equal(await ContentStrategy.countDocuments({ userId: user._id, status: 'generating' }), 0);
    assert.equal(await ContentStrategy.countDocuments({ userId: user._id, status: 'failed', error: 'stale' }), 1);
    assert.equal((await strategyUsage(user._id)).used, 0);
});

test('slot updates: mark posted and link only the owner\'s video', async () => {
    const user = await newUser('slot', 'premium');
    const stranger = await newUser('slot-other', 'premium');
    const plan = await readyPlan(user._id);
    const mine = await Video.create({ filename: 'a.mp4', fileSize: 1, uploader_id: user._id, analysisStatus: 'completed', viralityScore: 50 });
    const theirs = await Video.create({ filename: 'b.mp4', fileSize: 1, uploader_id: stranger._id, analysisStatus: 'completed', viralityScore: 50 });
    const params = { id: String(plan._id), slotId: 's1' };

    const ok = await call(updateStrategySlot, { user, params, body: { status: 'posted', linkedVideoId: String(mine._id) } });
    assert.equal(ok.error, null);
    const slot = ok.res.body.data.strategy.schedule.slots[0];
    assert.equal(slot.status, 'posted');
    assert.equal(slot.linkedVideoId, String(mine._id));
    assert.equal(ok.res.body.data.strategy.videos[String(mine._id)].title, 'a.mp4');

    const foreign = await call(updateStrategySlot, { user, params, body: { linkedVideoId: String(theirs._id) } });
    assert.equal(foreign.error.statusCode, 400);
    const otherUser = await call(updateStrategySlot, { user: stranger, params, body: { status: 'skipped' } });
    assert.equal(otherUser.error.statusCode, 404);
    const badStatus = await call(updateStrategySlot, { user, params, body: { status: 'done' } });
    assert.equal(badStatus.error.statusCode, 400);
});

test('GET strategy returns the newest plan, usage, profile and history', async () => {
    const user = await newUser('get', 'pro');
    await readyPlan(user._id, { generatedAt: new Date(Date.now() - 1000) });
    const newest = await readyPlan(user._id);
    const { res, error } = await call(getStrategy, { user, query: {} });
    assert.equal(error, null);
    assert.equal(res.body.data.strategy.id, String(newest._id));
    assert.equal(res.body.data.history.length, 2);
    assert.equal(res.body.data.usage.plan, 'pro');
    assert.equal(res.body.data.profile.source, 'saved');
    assert.equal(res.body.data.generating, false);
});
