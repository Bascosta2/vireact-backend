import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDb, disconnectTestDb, fakeRes } from './helpers/test-db.js';
import { User } from '../src/model/user.model.js';
import { LibraryItem } from '../src/model/library-item.model.js';
import { FunnelSession } from '../src/model/funnel-session.model.js';
import { RewriteUsage } from '../src/model/rewrite-usage.model.js';
import { listItems, getItemBySlug, libraryStats } from '../src/service/library.service.js';
import {
    createSession,
    updateAnswers,
    completeSession,
    buildResults,
    captureEmail,
    claimDailyQuota,
    releaseDailyQuota,
    claimSessionRewrite,
    linkFunnelSession,
    canAccessSession,
} from '../src/service/funnel.service.js';
import { getLibraryItem } from '../src/controller/library.controller.js';
import { getMe } from '../src/controller/auth.controller.js';

const KB_ID = new mongoose.Types.ObjectId();
const CAT = 'Content, Curiosity hooks (powerful)';
const item = (slug, extra = {}) => ({
    slug, type: 'hook', displayText: `Line ${slug}`, category: CAT, sourceKbIds: [KB_ID],
    reviewStatus: 'approved', visibility: 'public', order: 1, ...extra,
});

const ANSWERS = { platform: 'tiktok', niche: 'food', followers: '1k_10k', problem: 'swipe_first_3s', cadence: '2_4', persona: 'solo_creator' };

before(async () => {
    await connectTestDb();
    await Promise.all([LibraryItem.createIndexes(), FunnelSession.createIndexes(), RewriteUsage.createIndexes(), User.createIndexes()]);
    await LibraryItem.create([
        item('pub-1'), item('pub-2'), item('pub-3'), item('pub-4', { order: 4 }),
        item('members-1', { visibility: 'members', title: 'Locked one' }),
        item('private-1', { visibility: 'private' }),
        item('draft-public', { reviewStatus: 'draft' }),
        item('rejected-public', { reviewStatus: 'rejected' }),
        item('structure-1', { type: 'structure', category: 'Introducing the story' }),
    ]);
});
after(async () => { await disconnectTestDb(); });

const newUser = (suffix) =>
    User.create({ name: 'Test', email: `funnel-${suffix}-${Date.now()}@example.invalid`, password: 'pw-123456', isEmailVerified: true });

test('library serves approved public items only to anonymous callers', async () => {
    const { items, total } = await listItems({}, { entitled: false });
    assert.deepEqual(items.map((i) => i.slug).sort(), ['pub-1', 'pub-2', 'pub-3', 'pub-4', 'structure-1']);
    assert.equal(total, 5);
    assert.ok(items.every((i) => !('sourceKbIds' in i) && !('reviewStatus' in i)));
});

test('entitled callers also get members items; drafts, rejected and private never appear', async () => {
    const { items } = await listItems({ type: 'hook' }, { entitled: true });
    const slugs = items.map((i) => i.slug);
    assert.ok(slugs.includes('members-1'));
    for (const hidden of ['private-1', 'draft-public', 'rejected-public']) assert.equal(slugs.includes(hidden), false);
});

test('members item is a locked teaser without entitlement; private is 404', async () => {
    assert.deepEqual(await getItemBySlug('members-1', { entitled: false }), { locked: true, slug: 'members-1', title: 'Locked one', category: CAT });
    assert.equal((await getItemBySlug('members-1', { entitled: true })).displayText, 'Line members-1');
    assert.equal(await getItemBySlug('private-1', { entitled: true }), null);
    assert.equal(await getItemBySlug('draft-public', { entitled: true }), null);

    let err;
    await getLibraryItem({ user: null, params: { slug: 'private-1' } }, fakeRes(), (e) => { err = e; });
    assert.equal(err.statusCode, 404);
});

test('stats count approved public and members items only', async () => {
    const stats = await libraryStats();
    assert.deepEqual(stats.hooks, { public: 4, members: 1, total: 5 });
    assert.deepEqual(stats.structures, { public: 1, members: 0, total: 1 });
});

test('funnel session: answers, completion, results from public hooks only, email', async () => {
    const session = await createSession({ attribution: { utm_source: 'tiktok' }, ip: '203.0.113.9' });
    assert.equal(session.purgeable, true);
    assert.notEqual(session.ipHash, '203.0.113.9');

    assert.deepEqual((await updateAnswers(session, { answers: { niche: 'bogus' } })).errors, ['niche is invalid']);
    await updateAnswers(session, { answers: { platform: 'tiktok' }, step: 'q1' });
    const partial = await FunnelSession.findById(session._id).lean();
    assert.equal((await completeSession(partial)).error, 'Quiz is incomplete');

    const { session: answered } = await updateAnswers(partial, { answers: ANSWERS, step: 'q6' });
    const { session: done } = await completeSession(answered);
    assert.equal(done.status, 'completed');
    assert.equal(done.recommendedPlan, 'premium');
    assert.equal(done.highIntent, false);

    const results = await buildResults(done);
    assert.equal(results.hooks.length, 3);
    assert.ok(results.hooks.every((h) => h.visibility === 'public'));
    assert.ok(results.diagnosis.headline);

    await LibraryItem.updateOne({ slug: results.hooks[0].slug }, { $set: { visibility: 'private' } });
    assert.equal((await buildResults(done)).hooks.length, 2);
    await LibraryItem.updateOne({ slug: results.hooks[0].slug }, { $set: { visibility: 'public' } });

    assert.equal((await captureEmail(done, 'not-an-email')).error, 'A valid email is required');
    const { session: withEmail } = await captureEmail(done, ' Lead@Example.invalid ');
    assert.equal(withEmail.email, 'lead@example.invalid');
    assert.equal(withEmail.status, 'email_captured');
    assert.equal(withEmail.purgeable, false);
});

test('anonymous sessions carry the TTL index on purgeable sessions only', async () => {
    const indexes = await FunnelSession.collection.indexes();
    const ttl = indexes.find((i) => i.expireAfterSeconds !== undefined);
    assert.equal(ttl.expireAfterSeconds, 180 * 24 * 60 * 60);
    assert.deepEqual(ttl.partialFilterExpression, { purgeable: true });
});

test('daily quota is atomic under concurrency and refundable', async () => {
    const key = `ip:test-${Date.now()}`;
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimDailyQuota(key, 5)));
    assert.equal(claims.filter(Boolean).length, 5);
    await releaseDailyQuota(key);
    assert.equal(await claimDailyQuota(key, 5), true);
    assert.equal(await claimDailyQuota(key, 5), false);
});

test('one free rewrite per session, even under concurrency', async () => {
    const session = await createSession({ ip: '203.0.113.10' });
    const claims = await Promise.all([claimSessionRewrite(session._id, 1), claimSessionRewrite(session._id, 1), claimSessionRewrite(session._id, 1)]);
    assert.equal(claims.filter(Boolean).length, 1);
});

test('linkage is idempotent and first-wins in both directions', async () => {
    const userA = await newUser('a');
    const userB = await newUser('b');
    const s1 = await createSession({ attribution: { utm_source: 'reels' }, ip: '203.0.113.11' });
    await updateAnswers(s1, { answers: ANSWERS });
    await completeSession(await FunnelSession.findById(s1._id).lean());
    const s2 = await createSession({ ip: '203.0.113.12' });

    const first = await linkFunnelSession(userA._id, s1._id);
    assert.deepEqual(first, { linked: true, firstLink: true });
    assert.deepEqual(await linkFunnelSession(userA._id, s1._id), { linked: true, firstLink: false });
    assert.equal((await linkFunnelSession(userA._id, s2._id)).reason, 'already_linked');
    assert.equal((await linkFunnelSession(userB._id, s1._id)).reason, 'other_user');
    assert.equal((await linkFunnelSession(userA._id, 'not-a-uuid')).reason, 'invalid');

    const stored = await User.findById(userA._id).lean();
    assert.equal(stored.funnelSessionId, s1._id);
    assert.equal(stored.onboarding.answers.problem, 'swipe_first_3s');
    assert.equal(stored.attribution.utm_source, 'reels');

    const linked = await FunnelSession.findById(s1._id).lean();
    assert.equal(String(linked.userId), String(userA._id));
    assert.equal(linked.status, 'account_created');
    assert.equal(linked.purgeable, false);
    assert.equal(linked.steps.filter((s) => s.step === 'account_created').length, 1);
    assert.equal(canAccessSession(linked, { _id: userB._id }), false);
    assert.equal(canAccessSession(linked, null), false);
    assert.equal(canAccessSession(linked, { _id: userA._id }), true);
});

test('/auth/me adds access state and onboarding destination for users', async () => {
    const user = await newUser('me');
    const res = fakeRes();
    await getMe({ user: await User.findById(user._id) }, res, (e) => { throw e; });
    assert.deepEqual(res.body.data.access, { state: 'legacy_free', entitled: true });
    assert.deepEqual(res.body.data.onboarding, { hasUploaded: false, nextPath: '/upload?onboarding=1' });
});
