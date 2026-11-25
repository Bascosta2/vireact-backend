import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, disconnectTestDb } from './helpers/test-db.js';
import { User } from '../src/model/user.model.js';
import { Subscription } from '../src/model/subscription.model.js';
import { PLAN_LIMITS, STRIPE_PRICE_IDS, SUBSCRIPTION_STATUS } from '../src/constants.js';
import {
    setStripeForTests, getOrCreateSubscription, createCheckoutSession, handleStripeWebhook,
    effectiveLimits, trialInfo, claimVideoMonthlySlot, claimChatMessageSlot,
} from '../src/service/subscription.service.js';

const ENV = ['TRIAL_BILLING_ENABLED', 'TRIAL_DAYS', 'TRIAL_VIDEO_LIMIT', 'TRIAL_CHAT_MESSAGE_LIMIT'];
const saved = {};
const savedPrices = { ...STRIPE_PRICE_IDS };
let sessions;
let stripeSubs;
let seq = 0;

const fakeStripe = {
    customers: { create: async () => ({ id: `cus_test_${++seq}` }) },
    checkout: { sessions: { create: async (params) => { sessions.push(params); return { id: `cs_test_${++seq}`, url: 'https://checkout.test/session' }; } } },
    subscriptions: {
        retrieve: async (id) => stripeSubs.get(id),
        list: async () => ({ data: [] }),
    },
};

const newUser = async () => User.create({ name: 'Trial', email: `trial-${Date.now()}-${++seq}@example.invalid`, password: 'pw-123456', isEmailVerified: true });
const event = (type, object) => ({ id: `evt_test_${++seq}_${Date.now()}`, type, data: { object } });
const unix = (d) => Math.floor(d.getTime() / 1000);

before(async () => {
    for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    STRIPE_PRICE_IDS.premium = 'price_test_premium';
    STRIPE_PRICE_IDS.pro = 'price_test_pro';
    await connectTestDb();
    setStripeForTests(fakeStripe);
});
after(async () => {
    setStripeForTests(null);
    Object.assign(STRIPE_PRICE_IDS, savedPrices);
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    await disconnectTestDb();
});
beforeEach(() => {
    sessions = [];
    stripeSubs = new Map();
    for (const k of ENV) delete process.env[k];
});

test('free plan: 2 videos and 5 coach messages a month', async () => {
    assert.deepEqual(PLAN_LIMITS.free, { videosPerMonth: 2, chatMessagesPerMonth: 5 });
    const user = await newUser();
    for (let i = 0; i < 5; i++) await claimChatMessageSlot(user._id);
    await assert.rejects(claimChatMessageSlot(user._id), (err) => {
        assert.equal(err.statusCode, 403);
        assert.equal(err.data.code, 'CHAT_LIMIT');
        assert.equal(err.data.trial.eligible, true);
        assert.match(err.message, /5\/5 messages/);
        return true;
    });
});

test('trial checkout: card required, 7 days, only for accounts that never had a trial or a plan', async () => {
    const user = await newUser();
    const sub = await getOrCreateSubscription(user._id);
    assert.deepEqual(trialInfo(sub), { eligible: true, days: 7, active: false, endsAt: null, videoLimit: 5, chatMessageLimit: 60 });

    const out = await createCheckoutSession(user._id, user.email, 'pro', { trial: true });
    assert.equal(out.trial, true);
    assert.equal(out.trialDays, 7);
    const params = sessions.at(-1);
    assert.equal(params.mode, 'subscription');
    assert.equal(params.line_items[0].price, 'price_test_pro');
    assert.equal(params.payment_method_collection, 'always');
    assert.equal(params.subscription_data.trial_period_days, 7);
    assert.equal(params.subscription_data.trial_settings.end_behavior.missing_payment_method, 'cancel');
    assert.equal(params.metadata.trial, 'true');
    assert.match(params.success_url, /success=true&trial=1$/);
    assert.match(params.cancel_url, /\/trial\?cancelled=true$/);

    // A normal checkout carries no trial.
    await createCheckoutSession(user._id, user.email, 'premium');
    assert.equal(sessions.at(-1).subscription_data, undefined);
    assert.equal(sessions.at(-1).payment_method_collection, undefined);
    assert.match(sessions.at(-1).success_url, /success=true$/);

    // TRIAL_DAYS is honoured; the switch turns the offer off.
    process.env.TRIAL_DAYS = '14';
    await createCheckoutSession(user._id, user.email, 'premium', { trial: true });
    assert.equal(sessions.at(-1).subscription_data.trial_period_days, 14);
    process.env.TRIAL_BILLING_ENABLED = 'false';
    assert.equal(trialInfo(await getOrCreateSubscription(user._id)).eligible, false);
    await assert.rejects(createCheckoutSession(user._id, user.email, 'pro', { trial: true }), (err) => err.statusCode === 400 && err.data.code === 'TRIAL_UNAVAILABLE');
});

test('trial lifecycle: trialing with trial caps, then active with the full plan, and no second trial', async () => {
    const user = await newUser();
    await getOrCreateSubscription(user._id);
    const trialEnd = new Date(Date.now() + 7 * 86_400_000);
    const stripeSub = {
        id: 'sub_test_trial', status: 'trialing', trial_end: unix(trialEnd),
        items: { data: [{ id: 'si_1', price: { id: 'price_test_pro' }, current_period_start: unix(new Date()), current_period_end: unix(trialEnd) }] },
    };
    stripeSubs.set(stripeSub.id, stripeSub);

    await handleStripeWebhook(event('checkout.session.completed', { metadata: { userId: String(user._id), plan: 'pro', trial: 'true' }, subscription: stripeSub.id, customer: 'cus_test_trial' }));
    let sub = await Subscription.findOne({ userId: user._id });
    assert.equal(sub.plan, 'pro');
    assert.equal(sub.status, SUBSCRIPTION_STATUS.TRIAL);
    assert.ok(sub.trialUsedAt);
    assert.equal(unix(sub.trialEndsAt), unix(trialEnd));
    assert.deepEqual(effectiveLimits(sub), { videosPerMonth: 5, chatMessagesPerMonth: 60 });
    const info = trialInfo(sub);
    assert.equal(info.active, true);
    assert.equal(info.eligible, false);
    assert.equal(unix(new Date(info.endsAt)), unix(trialEnd));

    // Five analyses during the trial, then a trial-specific message.
    for (let i = 0; i < 5; i++) await claimVideoMonthlySlot(user._id);
    await assert.rejects(claimVideoMonthlySlot(user._id), (err) => {
        assert.equal(err.statusCode, 403);
        assert.equal(err.data.code, 'VIDEO_LIMIT');
        assert.match(err.message, /Trial limit reached/);
        return true;
    });

    // First payment: Stripe flips the subscription to active. Usage restarts on the full plan.
    await handleStripeWebhook(event('customer.subscription.updated', { ...stripeSub, status: 'active' }));
    sub = await Subscription.findOne({ userId: user._id });
    assert.equal(sub.status, SUBSCRIPTION_STATUS.ACTIVE);
    assert.equal(sub.trialEndsAt, null);
    assert.equal(sub.usage.videosUsed, 0);
    assert.deepEqual(effectiveLimits(sub), PLAN_LIMITS.pro);
    await claimVideoMonthlySlot(user._id);

    // Cancelled later: back on Free, and the trial cannot be taken again.
    await handleStripeWebhook(event('customer.subscription.deleted', { id: stripeSub.id }));
    sub = await Subscription.findOne({ userId: user._id });
    assert.equal(sub.plan, 'free');
    assert.equal(trialInfo(sub).eligible, false);
    await assert.rejects(createCheckoutSession(user._id, user.email, 'pro', { trial: true }), (err) => err.data.code === 'TRIAL_UNAVAILABLE');
});

test('a normal paid checkout also uses up the free trial', async () => {
    const user = await newUser();
    await getOrCreateSubscription(user._id);
    const end = new Date(Date.now() + 30 * 86_400_000);
    stripeSubs.set('sub_test_paid', { id: 'sub_test_paid', status: 'active', trial_end: null, items: { data: [{ id: 'si_2', price: { id: 'price_test_premium' }, current_period_end: unix(end) }] } });
    await handleStripeWebhook(event('checkout.session.completed', { metadata: { userId: String(user._id), plan: 'premium' }, subscription: 'sub_test_paid', customer: 'cus_test_paid' }));
    const sub = await Subscription.findOne({ userId: user._id });
    assert.equal(sub.status, SUBSCRIPTION_STATUS.ACTIVE);
    assert.equal(sub.trialEndsAt, null);
    assert.ok(sub.trialUsedAt);
    assert.deepEqual(effectiveLimits(sub), PLAN_LIMITS.premium);
});
