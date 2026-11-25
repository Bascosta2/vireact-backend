import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { matchHooks } from '../src/service/library/matcher.js';
import { PROBLEM_CATEGORY_MAP, MID_VIDEO_TEXT_CATEGORY } from '../src/constants/problem-category-map.js';
import { PROBLEMS } from '../src/constants/library.js';
import {
    QUIZ_OPTIONS,
    sanitizeAnswers,
    isQuizComplete,
    isHighIntent,
    recommendedPlanFor,
} from '../src/constants/funnel-quiz.js';
import { buildDiagnosis } from '../src/constants/funnel-diagnosis.js';
import { screenRewrites, rewriteHook } from '../src/service/hook-rewriter.service.js';
import { getAccessState, computePostAuthPath, isEntitledState, effectivePlan } from '../src/service/access.service.js';
import { Subscription } from '../src/model/subscription.model.js';
import { StripeWebhookEvent } from '../src/model/stripe-webhook-event.model.js';
import { PromoRedemption, PromoCodeCounter } from '../src/model/promo-redemption.model.js';
import { PLAN_LIMITS, STRIPE_PRICE_IDS } from '../src/constants.js';
import {
    setStripeForTests, handleStripeWebhook, createCheckoutSession, checkAndResetPeriod,
    effectiveLimits, mapStripeStatus, invoiceSubscriptionId,
} from '../src/service/subscription.service.js';
import { parsePromoCodes, getPromoCode, loadPromoCodes } from '../src/config/promo-codes.js';
import { claimPromoSlot } from '../src/service/promo.service.js';

const hook = (slug, category, extra = {}) => ({ slug, type: 'hook', category, order: 1, niches: [], problemTags: [], platforms: [], ...extra });

test('every problem maps to at least one category and every problem is mapped', () => {
    assert.deepEqual(Object.keys(PROBLEM_CATEGORY_MAP).sort(), [...PROBLEMS].sort());
    for (const categories of Object.values(PROBLEM_CATEGORY_MAP)) assert.ok(categories.length > 0);
});

test('matcher hides the block when fewer than 3 public hooks exist', () => {
    const result = matchHooks([hook('a', 'Relatable Hooks'), hook('b', 'Relatable Hooks')], { problem: 'swipe_first_3s' });
    assert.deepEqual(result, { items: [], strongMatches: 0, hooksHidden: true });
});

test('matcher orders featured problem-tagged hooks first, then mapped categories, then the rest', () => {
    const pool = [
        hook('other', 'Money and Success Hooks'),
        hook('mapped-2', 'Suspense Shock Hooks'),
        hook('mapped-1', 'Content, Curiosity hooks (powerful)'),
        hook('featured', 'Relatable Hooks', { featuredFree: true, problemTags: ['swipe_first_3s'] }),
    ];
    const result = matchHooks(pool, { problem: 'swipe_first_3s' });
    assert.deepEqual(result.items.map((i) => i.slug), ['featured', 'mapped-1', 'mapped-2']);
    assert.equal(result.strongMatches, 3);
});

test('matcher returns 5 only with at least 5 strong matches, and prefers niche matches', () => {
    const cat = 'Content, Curiosity hooks (powerful)';
    const five = ['a', 'b', 'c', 'd', 'e'].map((s) => hook(s, cat));
    five[4].niches = ['food'];
    const result = matchHooks(five, { problem: 'swipe_first_3s', niche: 'food' });
    assert.equal(result.items.length, 5);
    assert.equal(result.items[0].slug, 'e');

    const fewStrong = [hook('a', cat), hook('x', 'Relatable Hooks'), hook('y', 'Relatable Hooks'), hook('z', 'Relatable Hooks'), hook('w', 'Relatable Hooks')];
    assert.equal(matchHooks(fewStrong, { problem: 'swipe_first_3s' }).items.length, 3);
});

test('mid-video text lines only fill results for the mid-video problem', () => {
    const pool = [hook('m1', MID_VIDEO_TEXT_CATEGORY), hook('m2', MID_VIDEO_TEXT_CATEGORY), hook('r1', 'Relatable Hooks'), hook('r2', 'Money and Success Hooks')];
    const swipe = matchHooks(pool, { problem: 'swipe_first_3s' });
    assert.ok(swipe.items.every((i) => i.category !== MID_VIDEO_TEXT_CATEGORY));
    const mid = matchHooks(pool, { problem: 'mid_video_dropoff' });
    assert.deepEqual(mid.items.slice(0, 2).map((i) => i.slug), ['m1', 'm2']);
});

test('matcher puts a valid entry item first', () => {
    const pool = ['a', 'b', 'c', 'd'].map((s) => hook(s, 'Relatable Hooks'));
    assert.equal(matchHooks(pool, { problem: 'views_plateau', preferSlug: 'd' }).items[0].slug, 'd');
});

test('quiz answers are enum-checked', () => {
    assert.deepEqual(sanitizeAnswers({ platform: 'tiktok', niche: 'nope', extra: 1 }), { answers: { platform: 'tiktok' }, errors: ['niche is invalid'] });
    const full = Object.fromEntries(Object.entries(QUIZ_OPTIONS).map(([k, v]) => [k, v[0]]));
    assert.equal(isQuizComplete(full), true);
    assert.equal(isQuizComplete({ ...full, persona: undefined }), false);
});

test('high intent and recommended plan follow plan §6.4', () => {
    assert.equal(isHighIntent({ persona: 'agency_multi_creator', followers: 'lt_1k', cadence: '0_1' }), true);
    assert.equal(isHighIntent({ persona: 'solo_creator', followers: '100k_1m', cadence: '0_1' }), true);
    assert.equal(isHighIntent({ persona: 'brand_business', followers: 'lt_1k', cadence: '5_10' }), true);
    assert.equal(isHighIntent({ persona: 'brand_business', followers: 'lt_1k', cadence: '2_4' }), false);
    assert.equal(isHighIntent({ persona: 'solo_creator', followers: '10k_100k', cadence: '10_plus' }), false);

    assert.equal(recommendedPlanFor({ persona: 'solo_creator', followers: '1k_10k' }), 'premium');
    assert.equal(recommendedPlanFor({ persona: 'solo_creator', followers: '10k_100k' }), 'pro');
    assert.equal(recommendedPlanFor({ persona: 'brand_business', followers: 'lt_1k' }), 'pro');
});

test('diagnosis copy exists for every problem and contains no numbers', () => {
    for (const problem of PROBLEMS) {
        for (const platform of QUIZ_OPTIONS.platform) {
            const d = buildDiagnosis({ problem, niche: 'other', platform });
            assert.ok(d.headline && d.body && d.nextStep);
            assert.doesNotMatch(`${d.headline} ${d.body} ${d.nextStep}`, /\d|%/);
        }
    }
    assert.equal(buildDiagnosis({ problem: 'unknown' }), null);
});

const HOOK = 'today I made pasta';
const exemplars = [{ slug: 'curiosity-1', displayText: 'You won\u2019t believe ___' }];

test('screenRewrites drops placeholders, copies of the original and unknown slugs', () => {
    const { accepted, rejected } = screenRewrites(
        {
            diagnosis: 'The line gives no reason to keep watching.',
            rewrites: [
                { line: 'This pasta trick broke every rule my grandmother taught me', sourceItemSlug: 'curiosity-1' },
                { line: 'You won\u2019t believe ___', sourceItemSlug: 'curiosity-1' },
                { line: 'Today I made pasta', sourceItemSlug: null },
                { line: 'I ruined pasta three times before this worked', sourceItemSlug: 'made-up' },
            ],
        },
        { hookLine: HOOK, exemplarSlugs: new Set(['curiosity-1']) }
    );
    assert.equal(accepted.length, 2);
    assert.equal(accepted[1].sourceItemSlug, null);
    assert.equal(rejected.length, 2);
});

test('rewriteHook retries once with corrections, then fails closed', async () => {
    const calls = [];
    const good = { diagnosis: 'It describes the dish but not the stakes.', rewrites: [
        { line: 'My pasta went viral for the wrong reason', sourceItemSlug: 'curiosity-1' },
        { line: 'I almost threw this pasta away', sourceItemSlug: null },
        { line: 'Nobody expected this pasta to work', sourceItemSlug: null },
    ] };
    const complete = async (args) => {
        calls.push(args);
        return calls.length === 1 ? { diagnosis: 'x', rewrites: [{ line: '[your hook]', sourceItemSlug: null }] } : good;
    };
    const result = await rewriteHook({ hookLine: HOOK }, { complete, exemplars });
    assert.equal(calls.length, 2);
    assert.equal(result.rewrites.length, 3);
    assert.match(calls[1].messages.at(-1).content, /rejected/);

    const bad = async () => ({ diagnosis: 'x', rewrites: [] });
    await assert.rejects(rewriteHook({ hookLine: HOOK }, { complete: bad, exemplars }), (e) => e.code === 'REWRITE_FAILED');
});

test('access state before Phase 6 and post-auth paths', () => {
    const user = { _id: 'u' };
    assert.equal(getAccessState(user, null, { model: 'legacy_free' }), 'legacy_free');
    assert.equal(getAccessState(user, null, { model: 'card_trial' }), 'lead');
    assert.equal(getAccessState({ ...user, legacyFree: true }, null, { model: 'card_trial' }), 'legacy_free');
    assert.equal(getAccessState(user, { plan: 'pro', status: 'active' }), 'active');
    assert.equal(getAccessState(user, { plan: 'pro', status: 'active', paymentFailed: true }), 'past_due');
    assert.equal(getAccessState(user, { plan: 'free', status: 'active' }, { model: 'legacy_free' }), 'legacy_free');
    assert.equal(isEntitledState('past_due'), false);
    assert.equal(getAccessState(null, null), null);

    assert.equal(computePostAuthPath('lead'), '/start/trial');
    assert.equal(computePostAuthPath('legacy_free', { hasUploaded: false }), '/upload?onboarding=1');
    assert.equal(computePostAuthPath('active', { hasUploaded: true }), '/dashboard');
    assert.equal(computePostAuthPath('past_due'), '/dashboard');
});

// ── Billing holes (DB-free: models are mocked; the subscription/promo test files need MongoDB) ──

const DAY_MS = 86_400_000;
const unixOf = (d) => Math.floor(d.getTime() / 1000);
let evtSeq = 0;
const stripeEvent = (type, object) => ({ id: `evt_unit_${++evtSeq}`, type, data: { object } });

/** A fake Subscription document: plain fields plus save(). */
const fakeSub = (fields = {}) => {
    const doc = {
        _id: 'sub_doc_1', userId: 'user_1', plan: 'pro', status: 'active', promo: null,
        stripeSubscriptionId: 'sub_live_1', stripeCustomerId: 'cus_1', paymentFailed: false, paymentFailedAt: null,
        lastPaidInvoiceId: null,
        currentPeriodStart: new Date(Date.now() - 10 * DAY_MS), currentPeriodEnd: new Date(Date.now() + 20 * DAY_MS),
        usage: { videosUsed: 4, chatMessagesUsed: 9, lastResetAt: new Date(Date.now() - 10 * DAY_MS) },
        saves: 0,
        ...fields,
    };
    doc.save = async () => { doc.saves += 1; return doc; };
    return doc;
};

/** Mocks webhook bookkeeping and Subscription lookups against one fake document. */
const mockWebhookStore = (doc) => {
    mock.method(StripeWebhookEvent, 'findOne', async () => null);
    mock.method(StripeWebhookEvent, 'create', async () => ({}));
    mock.method(StripeWebhookEvent, 'updateOne', async () => ({}));
    mock.method(Subscription, 'findOne', async (q) => (q.stripeSubscriptionId === doc.stripeSubscriptionId || q.userId ? doc : null));
    // Atomic conditional update, as Mongo applies it.
    mock.method(Subscription, 'findOneAndUpdate', async (filter, update) => {
        if (filter.stripeSubscriptionId !== doc.stripeSubscriptionId) return null;
        if (filter.lastPaidInvoiceId && doc.lastPaidInvoiceId === filter.lastPaidInvoiceId.$ne) return null;
        for (const [path, value] of Object.entries(update.$set)) {
            const [head, tail] = path.split('.');
            if (tail) doc[head][tail] = value; else doc[head] = value;
        }
        return doc;
    });
};

test('effective plan: past_due keeps the plan; unpaid, paused, incomplete, expired and cancelled get Free (or a running promo)', () => {
    const user = { _id: 'u' };
    assert.equal(effectivePlan(null), 'free');
    assert.equal(effectivePlan({ plan: 'pro', status: 'active' }), 'pro');
    assert.equal(effectivePlan({ plan: 'pro', status: 'trial' }), 'pro');
    assert.equal(effectivePlan({ plan: 'pro', status: 'past_due', paymentFailed: true }), 'pro');
    assert.equal(getAccessState(user, { plan: 'pro', status: 'past_due' }), 'past_due');
    for (const status of ['unpaid', 'paused', 'incomplete', 'incomplete_expired', 'cancelled', 'expired']) {
        const sub = { plan: 'pro', status };
        assert.equal(effectivePlan(sub), 'free', status);
        assert.deepEqual(effectiveLimits(sub), PLAN_LIMITS.free, status);
        assert.equal(getAccessState(user, sub, { model: 'card_trial' }), 'lead', status);
    }
    const promo = { code: 'x', plan: 'premium', grantedAt: new Date(), endsAt: null };
    assert.equal(effectivePlan({ plan: 'pro', status: 'unpaid', promo }), 'premium', 'a running promo plan still applies');
    assert.equal(getAccessState(user, { plan: 'pro', status: 'cancelled', promo }), 'active');
    assert.equal(effectivePlan({ plan: 'premium', status: 'active', promo }), 'premium', 'promo-granted plans keep working');
    assert.equal(effectivePlan({ plan: 'premium', status: 'active', promo: { ...promo, endsAt: new Date(Date.now() - DAY_MS) } }), 'free');

    assert.equal(mapStripeStatus('past_due'), 'past_due');
    assert.equal(mapStripeStatus('canceled'), 'cancelled');
    assert.equal(mapStripeStatus('incomplete_expired'), 'incomplete_expired');
    assert.equal(mapStripeStatus('something_new'), null);
    assert.equal(mapStripeStatus('__proto__'), null);
});

test('invoices: the subscription id is read from the old and the new Stripe invoice shape', () => {
    assert.equal(invoiceSubscriptionId({ subscription: 'sub_old' }), 'sub_old');
    assert.equal(invoiceSubscriptionId({ subscription: null, parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_new' } } }), 'sub_new');
    assert.equal(invoiceSubscriptionId({ parent: { subscription_details: { subscription: { id: 'sub_expanded' } } } }), 'sub_expanded');
    assert.equal(invoiceSubscriptionId({ parent: null }), null);
});

test('renewal paid (new invoice shape): usage resets once even when invoice.paid and invoice.payment_succeeded both arrive', async (t) => {
    t.after(() => mock.restoreAll());
    const doc = fakeSub({ status: 'past_due', paymentFailed: true, paymentFailedAt: new Date() });
    mockWebhookStore(doc);
    const invoice = { id: 'in_new_1', subscription: undefined, parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_live_1' } } };

    await handleStripeWebhook(stripeEvent('invoice.payment_succeeded', invoice));
    assert.equal(doc.usage.videosUsed, 0);
    assert.equal(doc.paymentFailed, false);
    assert.equal(doc.status, 'active', 'a paid invoice brings a past-due subscription back');
    assert.equal(doc.lastPaidInvoiceId, 'in_new_1');

    doc.usage.videosUsed = 3; // used after the renewal
    await handleStripeWebhook(stripeEvent('invoice.paid', invoice));
    assert.equal(doc.usage.videosUsed, 3, 'the second event for the same invoice changes nothing');

    // The old shape still works, and the next invoice is processed.
    await handleStripeWebhook(stripeEvent('invoice.paid', { id: 'in_old_2', subscription: 'sub_live_1' }));
    assert.equal(doc.usage.videosUsed, 0);
    assert.equal(doc.lastPaidInvoiceId, 'in_old_2');
});

test('payment failed (new invoice shape) is recorded', async (t) => {
    t.after(() => mock.restoreAll());
    const doc = fakeSub();
    mockWebhookStore(doc);
    await handleStripeWebhook(stripeEvent('invoice.payment_failed', { id: 'in_f', parent: { subscription_details: { subscription: 'sub_live_1' } } }));
    assert.equal(doc.paymentFailed, true);
    assert.ok(doc.paymentFailedAt);
});

test('subscription updated: statuses are mirrored; a new paid period resets usage, past_due does not', async (t) => {
    // Stripe unreachable: the handler falls back to the event's copy.
    setStripeForTests({ subscriptions: { retrieve: async () => { throw new Error('unreachable'); } } });
    t.after(() => { mock.restoreAll(); setStripeForTests(null); });
    const doc = fakeSub();
    mockWebhookStore(doc);
    const periodEvent = (status, start, end = new Date(start.getTime() + 30 * DAY_MS)) => stripeEvent('customer.subscription.updated', {
        id: 'sub_live_1', status, items: { data: [{ id: 'si_1', current_period_start: unixOf(start), current_period_end: unixOf(end) }] },
    });

    // Same period, still active: usage untouched.
    await handleStripeWebhook(periodEvent('active', new Date(doc.currentPeriodStart)));
    assert.equal(doc.usage.videosUsed, 4);

    // Renewal failed: Stripe moves the period on but the subscription is past_due. No fresh allowance.
    const next = new Date(Date.now() + DAY_MS);
    await handleStripeWebhook(periodEvent('past_due', next));
    assert.equal(doc.status, 'past_due');
    assert.equal(doc.plan, 'pro');
    assert.equal(doc.usage.videosUsed, 4);
    assert.equal(effectivePlan(doc), 'pro', 'access stays while Stripe retries');

    // Retries exhausted: unpaid means Free features.
    await handleStripeWebhook(periodEvent('unpaid', next));
    assert.equal(doc.status, 'unpaid');
    assert.equal(effectivePlan(doc), 'free');

    // A later paid period (active, period start advanced) resets usage even without the invoice event.
    await handleStripeWebhook(periodEvent('active', new Date(next.getTime() + 30 * DAY_MS)));
    assert.equal(doc.status, 'active');
    assert.equal(doc.usage.videosUsed, 0);
    assert.equal(effectivePlan(doc), 'pro');
});

test('period rollover: no fresh allowance while past_due; normal accounts still reset', async () => {
    const ended = new Date(Date.now() - DAY_MS);
    const pastDue = fakeSub({ status: 'past_due', currentPeriodEnd: ended });
    await checkAndResetPeriod(pastDue);
    assert.equal(pastDue.usage.videosUsed, 4);
    assert.equal(pastDue.saves, 0);

    const failedLegacy = fakeSub({ status: 'active', paymentFailed: true, currentPeriodEnd: ended });
    await checkAndResetPeriod(failedLegacy);
    assert.equal(failedLegacy.usage.videosUsed, 4, 'a recorded payment failure counts as past_due too');

    const fine = fakeSub({ currentPeriodEnd: ended });
    await checkAndResetPeriod(fine);
    assert.equal(fine.usage.videosUsed, 0);
    assert.ok(fine.currentPeriodEnd > new Date());
});

test('checkout: refused (409 ALREADY_SUBSCRIBED) while the account already has a live Stripe subscription', async (t) => {
    const savedPrice = STRIPE_PRICE_IDS.pro;
    STRIPE_PRICE_IDS.pro = 'price_unit_pro';
    let stripeSubs = [];
    const sessions = [];
    setStripeForTests({
        customers: { create: async () => ({ id: 'cus_new' }) },
        subscriptions: { list: async () => ({ data: stripeSubs }) },
        checkout: { sessions: { create: async (params) => { sessions.push(params); return { id: 'cs_1', url: 'https://checkout.test' }; } } },
    });
    t.after(() => { mock.restoreAll(); setStripeForTests(null); STRIPE_PRICE_IDS.pro = savedPrice; });
    let doc = fakeSub({ plan: 'free', stripeSubscriptionId: null });
    mock.method(Subscription, 'findOne', async () => doc);
    const already = (e) => e.statusCode === 409 && e.data?.code === 'ALREADY_SUBSCRIBED' && /already have a subscription/.test(e.message);

    // Stripe knows of a live subscription the local record missed.
    for (const status of ['active', 'trialing', 'past_due']) {
        stripeSubs = [{ id: 'sub_x', status }];
        await assert.rejects(createCheckoutSession('user_1', 'a@example.invalid', 'pro'), already, status);
    }
    // The local record alone is enough.
    doc = fakeSub({ plan: 'premium', status: 'active' });
    stripeSubs = [];
    await assert.rejects(createCheckoutSession('user_1', 'a@example.invalid', 'pro'), already);
    assert.equal(sessions.length, 0, 'no checkout was opened');

    // Only ended subscriptions: checkout goes ahead.
    doc = fakeSub({ plan: 'free', stripeSubscriptionId: null });
    stripeSubs = [{ id: 'sub_old', status: 'canceled' }, { id: 'sub_old2', status: 'incomplete_expired' }];
    const out = await createCheckoutSession('user_1', 'a@example.invalid', 'pro');
    assert.equal(out.url, 'https://checkout.test');
    assert.equal(sessions.length, 1);
});

test('promo codes come only from PROMO_CODES; bad JSON or bad entries are ignored and logged without the codes', (t) => {
    const saved = { codes: process.env.PROMO_CODES, off: process.env.PROMO_CODES_DISABLED, limits: process.env.PROMO_CODE_LIMITS };
    t.after(() => {
        for (const [k, v] of [['PROMO_CODES', saved.codes], ['PROMO_CODES_DISABLED', saved.off], ['PROMO_CODE_LIMITS', saved.limits]]) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    });
    const logs = [];
    const log = { error: (m) => logs.push(m) };

    delete process.env.PROMO_CODES;
    assert.equal(loadPromoCodes().size, 0, 'no codes ship in the source');

    assert.equal(parsePromoCodes('{not json', log).size, 0);
    assert.equal(parsePromoCodes('["a"]', log).size, 0);
    const codes = parsePromoCodes(JSON.stringify({
        'Unit-Good': { plan: 'pro', days: null, label: 'Pro for life', limit: 25 },
        'unit-free': { plan: 'free' },
        'unit-days': { plan: 'premium', days: -1 },
        'unit-limit': { plan: 'premium', limit: 'lots' },
        'bad code!': { plan: 'pro' },
        'unit-nolabel': { plan: 'premium', days: 30 },
    }), log);
    assert.deepEqual([...codes.keys()], ['unit-good', 'unit-nolabel']);
    assert.equal(codes.get('unit-nolabel').label, 'Premium for 30 days');
    assert.equal(logs.length, 6);
    assert.ok(logs.every((m) => !/unit-|bad code/i.test(m)), 'logs never print a code');

    process.env.PROMO_CODES = JSON.stringify({ 'UNIT-GOOD': { plan: 'pro', days: null, label: 'Pro for life', limit: 25 } });
    assert.deepEqual(getPromoCode('unit-good'), { code: 'unit-good', plan: 'pro', days: null, label: 'Pro for life', maxRedemptions: 25 });
    process.env.PROMO_CODE_LIMITS = 'unit-good=3';
    assert.equal(getPromoCode('unit-good').maxRedemptions, 3, 'PROMO_CODE_LIMITS still overrides');
    process.env.PROMO_CODE_LIMITS = 'unit-good=abc';
    assert.equal(getPromoCode('unit-good').maxRedemptions, 25, 'a bad override cannot lift the cap');
    process.env.PROMO_CODES_DISABLED = 'unit-good';
    assert.equal(getPromoCode('unit-good'), null, 'PROMO_CODES_DISABLED still works');
    assert.equal(getPromoCode('__proto__'), null);
});

test('promo cap holds under parallel redemptions (atomic counter)', async (t) => {
    t.after(() => mock.restoreAll());
    const counters = new Map();
    mock.method(PromoRedemption, 'countDocuments', async () => 1); // one redemption from before the counter existed
    mock.method(PromoCodeCounter, 'updateOne', async (filter, update, opts) => {
        if (update.$max) {
            if (!counters.has(filter._id) && opts?.upsert) counters.set(filter._id, update.$max.count);
            else counters.set(filter._id, Math.max(counters.get(filter._id), update.$max.count));
        } else if (update.$inc && counters.get(filter._id) > 0) {
            counters.set(filter._id, counters.get(filter._id) + update.$inc.count);
        }
        return {};
    });
    // Mongo applies the filter and $inc as one step.
    mock.method(PromoCodeCounter, 'findOneAndUpdate', async (filter, update) => {
        const count = counters.get(filter._id);
        if (!(count < filter.count.$lt)) return null;
        counters.set(filter._id, count + update.$inc.count);
        return { _id: filter._id, count: count + 1 };
    });

    const results = await Promise.all(Array.from({ length: 20 }, () => claimPromoSlot('unit-cap', 5)));
    assert.equal(results.filter(Boolean).length, 4, '5 total, 1 already used');
    assert.equal(counters.get('unit-cap'), 5);
});

test('out-of-order events: the live Stripe subscription wins, and a paying row never drops to incomplete', async (t) => {
    let live = null;
    setStripeForTests({ subscriptions: { retrieve: async () => { if (!live) throw new Error('unreachable'); return live; } } });
    t.after(() => { mock.restoreAll(); setStripeForTests(null); });
    const doc = fakeSub();
    mockWebhookStore(doc);
    const stale = { id: 'sub_live_1', status: 'incomplete', items: { data: [{ id: 'si_1' }] } };

    // created(incomplete) retried after the invoice was paid: Stripe says active now.
    live = { ...stale, status: 'active' };
    await handleStripeWebhook(stripeEvent('customer.subscription.created', stale));
    assert.equal(doc.status, 'active');

    // Live status is used even when the event is stale in the other direction.
    live = { ...stale, status: 'past_due' };
    await handleStripeWebhook(stripeEvent('customer.subscription.updated', { ...stale, status: 'active' }));
    assert.equal(doc.status, 'past_due');

    // Stripe unreachable and the event copy says incomplete: a started subscription is kept as it is.
    doc.status = 'active';
    live = null;
    await handleStripeWebhook(stripeEvent('customer.subscription.created', stale));
    assert.equal(doc.status, 'active');
    assert.equal(effectivePlan(doc), 'pro');

    // A row that never started can still be incomplete.
    doc.status = 'incomplete';
    live = { ...stale, status: 'incomplete_expired' };
    await handleStripeWebhook(stripeEvent('customer.subscription.updated', stale));
    assert.equal(doc.status, 'incomplete_expired');
});

test('checkout completed: a paid session is stored active (or trial) even if the subscription snapshot says incomplete', async (t) => {
    const stripeSub = { id: 'sub_live_1', status: 'incomplete', trial_end: null, items: { data: [{ id: 'si_1', price: { id: 'price_unit_pro' }, current_period_end: unixOf(new Date(Date.now() + 30 * DAY_MS)) }] } };
    setStripeForTests({ subscriptions: { retrieve: async () => stripeSub } });
    t.after(() => { mock.restoreAll(); setStripeForTests(null); });
    const session = (payment_status) => ({ metadata: { userId: '64b7f0a1c2d3e4f5a6b7c8d9', plan: 'pro' }, subscription: 'sub_live_1', customer: 'cus_1', payment_status });

    for (const paid of ['paid', 'no_payment_required']) {
        const doc = fakeSub({ plan: 'free', status: 'active', stripeSubscriptionId: null });
        mockWebhookStore(doc);
        await handleStripeWebhook(stripeEvent('checkout.session.completed', session(paid)));
        assert.equal(doc.status, 'active', paid);
        assert.equal(doc.plan, 'pro');
        mock.restoreAll();
    }

    // Payment still pending (e.g. a delayed method): no paid access until Stripe reports it active.
    const doc = fakeSub({ plan: 'free', status: 'active', stripeSubscriptionId: null });
    mockWebhookStore(doc);
    await handleStripeWebhook(stripeEvent('checkout.session.completed', session('unpaid')));
    assert.equal(doc.status, 'incomplete');
    assert.equal(effectivePlan(doc), 'free');
});
