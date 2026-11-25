import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, disconnectTestDb } from './helpers/test-db.js';
import { User } from '../src/model/user.model.js';
import { Subscription } from '../src/model/subscription.model.js';
import { PromoRedemption } from '../src/model/promo-redemption.model.js';
import { getOrCreateSubscription, handleStripeWebhook, trialInfo } from '../src/service/subscription.service.js';
import { redeemPromoCode } from '../src/service/promo.service.js';
import { promoInfo, promoLapsed } from '../src/service/promo-state.js';
import { getAccessState, ACCESS_STATES } from '../src/service/access.service.js';
import { getPromoCode, normalizePromoCode } from '../src/config/promo-codes.js';

const ENV = ['PROMO_CODES', 'PROMO_CODES_DISABLED', 'PROMO_CODE_LIMITS'];
// Fake codes for tests only; real codes live in the PROMO_CODES env var, never in the source.
const TEST_CODES = JSON.stringify({
    'TEST-MONTH': { plan: 'premium', days: 30, label: 'Premium for 1 month' },
    'test-life': { plan: 'pro', days: null, label: 'Pro for life' },
});
const saved = {};
let seq = 0;
const newUser = async () => User.create({ name: 'Promo', email: `promo-${Date.now()}-${++seq}@example.invalid`, password: 'pw-123456', isEmailVerified: true });
const code = (err, expected) => { assert.equal(err.data?.code, expected, err.message); return true; };
const DAY = 24 * 60 * 60 * 1000;

before(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    await connectTestDb();
    await PromoRedemption.syncIndexes();
});
after(async () => {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    await disconnectTestDb();
});
beforeEach(() => { for (const k of ENV) delete process.env[k]; process.env.PROMO_CODES = TEST_CODES; });

test('codes from PROMO_CODES: a 30-day Premium code and a Pro-for-life code; case and spaces ignored', () => {
    assert.equal(normalizePromoCode('  Test-Month '), 'test-month');
    assert.equal(normalizePromoCode('test- life'), 'test-life');
    assert.deepEqual(getPromoCode('test-month'), { code: 'test-month', plan: 'premium', days: 30, label: 'Premium for 1 month', maxRedemptions: null });
    assert.deepEqual(getPromoCode('test-life'), { code: 'test-life', plan: 'pro', days: null, label: 'Pro for life', maxRedemptions: null });
    assert.equal(getPromoCode('__proto__'), null);
    assert.equal(getPromoCode('constructor'), null);
    assert.equal(getPromoCode('nope'), null);
});

test('month code: Premium for 30 days with fresh usage, once per account', async () => {
    const user = await newUser();
    const before = await getOrCreateSubscription(user._id);
    before.usage.chatMessagesUsed = 5;
    await before.save();

    const now = new Date();
    const out = await redeemPromoCode(user._id, ' TEST-MONTH ', now);
    assert.equal(out.plan, 'premium');
    assert.equal(out.label, 'Premium for 1 month');
    assert.equal(out.promo.lifetime, false);
    assert.equal(new Date(out.promo.endsAt).getTime(), now.getTime() + 30 * DAY);

    const sub = await Subscription.findOne({ userId: user._id });
    assert.equal(sub.plan, 'premium');
    assert.equal(sub.status, 'active');
    assert.equal(sub.usage.chatMessagesUsed, 0);
    assert.equal(trialInfo(sub).eligible, false, 'no trial offer while on a promo plan');

    await assert.rejects(redeemPromoCode(user._id, 'test-month'), (e) => code(e, 'PROMO_USED'));
    assert.equal(await PromoRedemption.countDocuments({ userId: user._id }), 1);
});

test('month code ends: the account is back on Free at the next read, and access agrees before that', async () => {
    const user = await newUser();
    await redeemPromoCode(user._id, 'test-month', new Date(Date.now() - 31 * DAY));

    const raw = await Subscription.findOne({ userId: user._id }).lean();
    assert.equal(raw.plan, 'premium');
    assert.equal(promoLapsed(raw), true);
    assert.notEqual(getAccessState(user, raw), ACCESS_STATES.ACTIVE, 'an ended promo does not count as paid');

    const sub = await getOrCreateSubscription(user._id);
    assert.equal(sub.plan, 'free');
    assert.equal(sub.promo, null);
    assert.equal(promoInfo(sub), null);
    // The code still counts as used.
    await assert.rejects(redeemPromoCode(user._id, 'test-month'), (e) => code(e, 'PROMO_USED'));
});

test('life code: Pro for life; it never expires and makes the month code pointless', async () => {
    const user = await newUser();
    const out = await redeemPromoCode(user._id, 'test-life');
    assert.equal(out.plan, 'pro');
    assert.equal(out.promo.lifetime, true);
    assert.equal(out.promo.endsAt, null);

    const later = await getOrCreateSubscription(user._id);
    assert.equal(later.plan, 'pro');
    assert.equal(getAccessState(user, later.toObject()), ACCESS_STATES.ACTIVE);
    await assert.rejects(redeemPromoCode(user._id, 'test-month'), (e) => code(e, 'PROMO_NOT_NEEDED'));
});

test('month code then life code upgrades to Pro for life', async () => {
    const user = await newUser();
    await redeemPromoCode(user._id, 'test-month');
    const out = await redeemPromoCode(user._id, 'test-life');
    assert.equal(out.plan, 'pro');
    assert.equal(out.promo.lifetime, true);
});

test('refused: unknown codes, switched-off codes, codes past their limit, accounts billed through Stripe', async () => {
    const user = await newUser();
    await assert.rejects(redeemPromoCode(user._id, ''), (e) => code(e, 'PROMO_INVALID'));
    await assert.rejects(redeemPromoCode(user._id, 'free-stuff'), (e) => code(e, 'PROMO_INVALID'));
    await assert.rejects(redeemPromoCode(user._id, 'x'.repeat(200)), (e) => code(e, 'PROMO_INVALID'));

    process.env.PROMO_CODES_DISABLED = 'test-life';
    await assert.rejects(redeemPromoCode(user._id, 'test-life'), (e) => code(e, 'PROMO_INVALID'));
    delete process.env.PROMO_CODES_DISABLED;

    const claimed = await PromoRedemption.countDocuments({ code: 'test-life' });
    process.env.PROMO_CODE_LIMITS = `test-life=${claimed}`;
    await assert.rejects(redeemPromoCode(user._id, 'test-life'), (e) => code(e, 'PROMO_EXHAUSTED'));
    delete process.env.PROMO_CODE_LIMITS;

    const payer = await newUser();
    const sub = await getOrCreateSubscription(payer._id);
    sub.plan = 'premium';
    sub.stripeSubscriptionId = `sub_test_${Date.now()}`;
    await sub.save();
    await assert.rejects(redeemPromoCode(payer._id, 'test-life'), (e) => code(e, 'PROMO_HAS_BILLING'));
    assert.equal(await PromoRedemption.countDocuments({ userId: { $in: [user._id, payer._id] } }), 0, 'nothing recorded for refused attempts');
});

test('a paid Stripe plan bought on top of a promo falls back to the promo plan when it ends', async () => {
    const user = await newUser();
    await redeemPromoCode(user._id, 'test-month');
    const sub = await Subscription.findOne({ userId: user._id });
    sub.plan = 'pro';
    sub.stripeSubscriptionId = `sub_test_pro_${Date.now()}`;
    await sub.save();

    await handleStripeWebhook({ id: `evt_promo_${Date.now()}`, type: 'customer.subscription.deleted', data: { object: { id: sub.stripeSubscriptionId } } });
    const after = await Subscription.findOne({ userId: user._id });
    assert.equal(after.plan, 'premium', 'back to the running promo plan, not Free');
    assert.equal(after.stripeSubscriptionId, null);
    assert.equal(promoInfo(after)?.code, 'test-month');
});
