import mongoose from 'mongoose';
import { Subscription } from '../model/subscription.model.js';
import { StripeWebhookEvent } from '../model/stripe-webhook-event.model.js';
import { User } from '../model/user.model.js';
import { ApiError } from '../utils/ApiError.js';
import { SUBSCRIPTION_PLANS, SUBSCRIPTION_STATUS, PLAN_LIMITS, STRIPE_PRICE_IDS, STRIPE_CHECKOUT_PLANS, STRIPE_PRICE_ID_TO_PLAN, LIFETIME_FREE_VIDEO_LIMIT } from '../constants.js';
import defaultStripe from '../lib/stripe.js';
import { FRONTEND_URL, BACKEND_URL } from '../config/index.js';
import { isTrialBillingEnabled, getTrialConfig } from '../config/flags.js';
import { expirePromoIfDue, planAfterBillingEnds } from './promo-state.js';
import { effectivePlan, isPastDue } from './access.service.js';

let stripe = defaultStripe;
/** Tests swap in a fake Stripe client; null restores the real one. */
export const setStripeForTests = (client) => {
    stripe = client ?? defaultStripe;
};

const minCap = (planCap, trialCap) => (planCap === null ? trialCap : Math.min(planCap, trialCap));

/** Stripe subscription status -> local status. Unknown statuses map to null (left unchanged). */
const STRIPE_STATUS_MAP = Object.freeze({
    trialing: SUBSCRIPTION_STATUS.TRIAL,
    active: SUBSCRIPTION_STATUS.ACTIVE,
    past_due: SUBSCRIPTION_STATUS.PAST_DUE,
    unpaid: SUBSCRIPTION_STATUS.UNPAID,
    paused: SUBSCRIPTION_STATUS.PAUSED,
    incomplete: SUBSCRIPTION_STATUS.INCOMPLETE,
    incomplete_expired: SUBSCRIPTION_STATUS.INCOMPLETE_EXPIRED,
    canceled: SUBSCRIPTION_STATUS.CANCELLED,
});
export const mapStripeStatus = (stripeStatus) =>
    (Object.hasOwn(STRIPE_STATUS_MAP, stripeStatus ?? '') ? STRIPE_STATUS_MAP[stripeStatus] : null);

/** Stripe statuses during which a second checkout would create a duplicate subscription. */
const LIVE_STRIPE_STATUSES = new Set(['active', 'trialing', 'past_due']);

/**
 * The Stripe subscription id an invoice belongs to. Older API versions put it at
 * invoice.subscription; 2025-03-31+ moved it to invoice.parent.subscription_details.subscription.
 * Either may be an id string or an expanded object.
 */
export const invoiceSubscriptionId = (invoice) => {
    const ref = invoice?.subscription ?? invoice?.parent?.subscription_details?.subscription ?? null;
    return (typeof ref === 'string' ? ref : ref?.id) || null;
};

/**
 * The caps that apply to a subscription right now. While trialing, the trial caps apply
 * (TRIAL_VIDEO_LIMIT / TRIAL_CHAT_MESSAGE_LIMIT) unless the plan's own cap is lower.
 */
export const effectiveLimits = (subscription) => {
    const plan = PLAN_LIMITS[effectivePlan(subscription)] ?? PLAN_LIMITS[SUBSCRIPTION_PLANS.FREE];
    if (subscription?.status !== SUBSCRIPTION_STATUS.TRIAL) return { ...plan };
    const trial = getTrialConfig();
    return {
        videosPerMonth: minCap(plan.videosPerMonth, trial.videoLimit),
        chatMessagesPerMonth: minCap(plan.chatMessagesPerMonth, trial.chatMessageLimit),
    };
};

/** Free trial state for the web app: who can start one, and when a running one ends. */
export const trialInfo = (subscription) => {
    const { days, videoLimit, chatMessageLimit } = getTrialConfig();
    const active = subscription?.status === SUBSCRIPTION_STATUS.TRIAL;
    const eligible = isTrialBillingEnabled()
        && Boolean(stripe)
        && subscription?.plan === SUBSCRIPTION_PLANS.FREE
        && !subscription?.trialUsedAt
        && !subscription?.stripeSubscriptionId;
    return { eligible, days, active, endsAt: active ? subscription.trialEndsAt ?? subscription.currentPeriodEnd ?? null : null, videoLimit, chatMessageLimit };
};

/**
 * Stripe deprecated subscription-level current_period_start/end in API 2025-03-31.
 * The canonical location is now on each subscription item.
 * This helper reads item-level first, falls back to top-level for older payloads.
 * Returns a tuple [startDate, endDate] as JS Date objects, or [null, null] if unresolvable.
 */
function extractSubscriptionPeriod(subscription) {
    const item = subscription?.items?.data?.[0];
    const startUnix = item?.current_period_start ?? subscription?.current_period_start;
    const endUnix = item?.current_period_end ?? subscription?.current_period_end;
    const start = startUnix ? new Date(startUnix * 1000) : null;
    const end = endUnix ? new Date(endUnix * 1000) : null;
    return [start, end];
}

// Get or create subscription for a user (auto-creates FREE plan)
export const getOrCreateSubscription = async (userId) => {
    if (!userId) {
        throw new ApiError(400, 'User ID is required');
    }

    let subscription = await Subscription.findOne({ userId });

    if (!subscription) {
        // Create FREE subscription for new users
        const now = new Date();
        const periodEnd = new Date(now);
        periodEnd.setMonth(periodEnd.getMonth() + 1);

        subscription = new Subscription({
            userId,
            plan: SUBSCRIPTION_PLANS.FREE,
            status: SUBSCRIPTION_STATUS.ACTIVE,
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            usage: {
                videosUsed: 0,
                chatMessagesUsed: 0,
                lastResetAt: now
            }
        });

        await subscription.save();
        console.log(`[Subscription] Created FREE subscription for user ${userId}`);
    } else if (subscription.promo) {
        // A promo plan whose time is up ends here, on the first read after it expires.
        await expirePromoIfDue(subscription);
    }

    return subscription;
};

// Check and reset period if needed
export const checkAndResetPeriod = async (subscription) => {
    const now = new Date();

    // Stripe is retrying a failed renewal: keep access, but no fresh allowance until it is paid.
    if (now >= subscription.currentPeriodEnd && isPastDue(subscription)) {
        return subscription;
    }

    // If period ended, reset usage
    if (now >= subscription.currentPeriodEnd) {
        const newPeriodStart = now;
        const newPeriodEnd = new Date(now);
        newPeriodEnd.setMonth(newPeriodEnd.getMonth() + 1);

        subscription.currentPeriodStart = newPeriodStart;
        subscription.currentPeriodEnd = newPeriodEnd;
        subscription.usage.videosUsed = 0;
        subscription.usage.chatMessagesUsed = 0;
        subscription.usage.lastResetAt = now;

        await subscription.save();
        console.log(`[Subscription] Reset usage for user ${subscription.userId} - new period: ${newPeriodStart} to ${newPeriodEnd}`);
    }

    return subscription;
};

/**
 * Atomically reserve one video slot for the billing period (prevents parallel-upload TOCTOU).
 * Call at start of upload; call releaseVideoMonthlySlot on ingest failure before analysis is queued.
 */
export const claimVideoMonthlySlot = async (userId) => {
    let subscription = await getOrCreateSubscription(userId);
    await checkAndResetPeriod(subscription);
    subscription = await Subscription.findById(subscription._id);
    if (!subscription) {
        throw new ApiError(500, 'Subscription not found');
    }
    const limits = effectiveLimits(subscription);
    const trialing = subscription.status === SUBSCRIPTION_STATUS.TRIAL;

    // Unlimited tier (Enterprise): bypass the cap CAS and atomically bump
    // usage so per-period telemetry remains accurate. Cannot fall through to
    // the capped query below — Mongo's `$lt: null` would match null/missing
    // values and silently reject increments on legitimate documents.
    if (limits.videosPerMonth === null) {
        const updated = await Subscription.findOneAndUpdate(
            { _id: subscription._id },
            { $inc: { 'usage.videosUsed': 1 } },
            { new: true }
        );
        console.log(`[Subscription] Claimed video slot for user ${userId} (unlimited): ${updated.usage.videosUsed}`);
        return updated;
    }

    const updated = await Subscription.findOneAndUpdate(
        {
            _id: subscription._id,
            'usage.videosUsed': { $lt: limits.videosPerMonth }
        },
        { $inc: { 'usage.videosUsed': 1 } },
        { new: true }
    );
    if (!updated) {
        throw new ApiError(
            403,
            trialing
                ? `Trial limit reached. Your free trial includes ${limits.videosPerMonth} video analyses. The full plan allowance starts when the trial ends.`
                : `Video limit reached. You've used ${subscription.usage.videosUsed}/${limits.videosPerMonth} videos this month. Upgrade your plan for more videos.`,
            { code: 'VIDEO_LIMIT', trial: trialInfo(subscription) }
        );
    }
    console.log(`[Subscription] Claimed video slot for user ${userId}: ${updated.usage.videosUsed}/${limits.videosPerMonth}`);
    return updated;
};

/** Undo claimVideoMonthlySlot when upload/ingest fails before analysis is queued. */
export const releaseVideoMonthlySlot = async (userId) => {
    const subscription = await Subscription.findOne({ userId });
    if (!subscription) return;
    await Subscription.updateOne(
        { _id: subscription._id, 'usage.videosUsed': { $gt: 0 } },
        { $inc: { 'usage.videosUsed': -1 } }
    );
    console.log(`[Subscription] Released video slot for user ${userId}`);
};

/**
 * Monotonic increment of the lifetime free-trial counter on the User model.
 * Called at the same code point where keepVideoQuota = true is set in the
 * upload service — i.e. only when the slot is permanently spent and the
 * video record will live in the user's library. No release function exists
 * by design: the schema enforces min: 0, the field is monotonic for the
 * lifetime of the account, and re-analyze does not re-enter this path.
 *
 * Safe to call for any user; only free-tier users have the lifetime cap
 * checked elsewhere via assertLifetimeFreeTrialAvailable. For paid tiers
 * this still increments (cheap, useful telemetry, no enforcement impact).
 */
export const incrementLifetimeFreeVideoCount = async (userId) => {
    const updated = await User.findByIdAndUpdate(
        userId,
        { $inc: { lifetimeFreeVideosUsed: 1 } },
        { new: true }
    );
    if (!updated) {
        // Do not throw — this is a telemetry-adjacent call invoked after
        // the slot is already spent. Log and move on; the upload should
        // not fail because the lifetime counter couldn't bump.
        console.warn(`[Subscription] incrementLifetimeFreeVideoCount: user ${userId} not found`);
        return null;
    }
    console.log(`[Subscription] Lifetime free video count for user ${userId}: ${updated.lifetimeFreeVideosUsed}`);
    return updated;
};

/**
 * Pre-claim gate. Throws ApiError(403, ...) if the user is on the free plan
 * and has already consumed their lifetime free-trial allowance. No-op for
 * paid tiers. Read-only; does not mutate any counter.
 *
 * Call BEFORE claimVideoMonthlySlot at the top of any upload path. The
 * monthly counter is irrelevant if the lifetime cap is already hit — we
 * want to fail fast with a tier-specific error message before touching
 * the monthly slot CAS.
 */
export const assertLifetimeFreeTrialAvailable = async (userId) => {
    const subscription = await getOrCreateSubscription(userId);
    if (effectivePlan(subscription) !== SUBSCRIPTION_PLANS.FREE) {
        return;
    }
    const user = await User.findById(userId).select('lifetimeFreeVideosUsed').lean();
    if (!user) {
        throw new ApiError(404, 'User not found');
    }
    const used = user.lifetimeFreeVideosUsed ?? 0;
    if (used >= LIFETIME_FREE_VIDEO_LIMIT) {
        throw new ApiError(
            403,
            'Free trial limit reached. Upgrade to continue analyzing videos.',
            { code: 'VIDEO_LIMIT', trial: trialInfo(subscription) }
        );
    }
};

/**
 * Atomically reserve one chat message for the billing period (prevents parallel-request TOCTOU).
 * Call before OpenAI; call releaseChatMessageSlot on infrastructure failure before success response.
 */
export const claimChatMessageSlot = async (userId) => {
    let subscription = await getOrCreateSubscription(userId);
    await checkAndResetPeriod(subscription);
    subscription = await Subscription.findById(subscription._id);
    if (!subscription) {
        throw new ApiError(500, 'Subscription not found');
    }
    const limits = effectiveLimits(subscription);

    // Unlimited tier (Enterprise): see claimVideoMonthlySlot for rationale.
    if (limits.chatMessagesPerMonth === null) {
        const updated = await Subscription.findOneAndUpdate(
            { _id: subscription._id },
            { $inc: { 'usage.chatMessagesUsed': 1 } },
            { new: true }
        );
        console.log(`[Subscription] Claimed chat slot for user ${userId} (unlimited): ${updated.usage.chatMessagesUsed}`);
        return updated;
    }

    const updated = await Subscription.findOneAndUpdate(
        {
            _id: subscription._id,
            'usage.chatMessagesUsed': { $lt: limits.chatMessagesPerMonth }
        },
        { $inc: { 'usage.chatMessagesUsed': 1 } },
        { new: true }
    );
    if (!updated) {
        throw new ApiError(
            403,
            `Chat message limit reached. You've used ${subscription.usage.chatMessagesUsed}/${limits.chatMessagesPerMonth} messages this month. Upgrade your plan for more messages.`,
            { code: 'CHAT_LIMIT', trial: trialInfo(subscription) }
        );
    }
    console.log(`[Subscription] Claimed chat slot for user ${userId}: ${updated.usage.chatMessagesUsed}/${limits.chatMessagesPerMonth}`);
    return updated;
};

export const releaseChatMessageSlot = async (userId) => {
    const subscription = await Subscription.findOne({ userId });
    if (!subscription) return;
    await Subscription.updateOne(
        { _id: subscription._id, 'usage.chatMessagesUsed': { $gt: 0 } },
        { $inc: { 'usage.chatMessagesUsed': -1 } }
    );
    console.log(`[Subscription] Released chat slot for user ${userId}`);
};


/**
 * Refuses a second checkout while the account already pays (or trials) through Stripe; a second
 * subscription would bill the card twice. Checks the local record and asks Stripe about the customer.
 */
async function assertNoLiveSubscription(subscription) {
    const localLive = Boolean(subscription.stripeSubscriptionId)
        && [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.TRIAL, SUBSCRIPTION_STATUS.PAST_DUE].includes(subscription.status);
    let live = localLive;
    if (!live && subscription.stripeCustomerId) {
        const existing = await stripe.subscriptions.list({ customer: subscription.stripeCustomerId, status: 'all', limit: 20 });
        live = (existing?.data ?? []).some((s) => LIVE_STRIPE_STATUSES.has(s.status));
    }
    if (live) {
        throw new ApiError(
            409,
            'You already have a subscription. To switch plans, use Change plan or Manage billing instead of buying a second one.',
            { code: 'ALREADY_SUBSCRIBED' }
        );
    }
}

// Create Stripe checkout session
/**
 * `trial: true` starts the plan with a free trial (card collected, first charge when the trial ends).
 * Only for accounts that have never had a trial or a paid plan; otherwise 400 TRIAL_UNAVAILABLE.
 */
export const createCheckoutSession = async (userId, userEmail, plan, { trial = false } = {}) => {
    if (!stripe) {
        throw new ApiError(500, 'Stripe is not configured');
    }

    if (!plan || !STRIPE_CHECKOUT_PLANS.includes(plan)) {
        throw new ApiError(400, `Invalid plan. Must be one of: ${STRIPE_CHECKOUT_PLANS.join(', ')}`);
    }

    const priceId = STRIPE_PRICE_IDS[plan];
    if (!priceId) {
        throw new ApiError(500, `Stripe Price ID not configured for ${plan} plan`);
    }

    const subscription = await getOrCreateSubscription(userId);
    await assertNoLiveSubscription(subscription);

    // Create or get Stripe customer
    let customerId = subscription.stripeCustomerId;

    if (!customerId) {
        const customer = await stripe.customers.create({
            email: userEmail,
            metadata: {
                userId: userId.toString()
            }
        });
        customerId = customer.id;

        subscription.stripeCustomerId = customerId;
        await subscription.save();
    }

    const withTrial = Boolean(trial);
    if (withTrial && !trialInfo(subscription).eligible) {
        throw new ApiError(400, 'The free trial is not available on this account. You can still subscribe to a plan.', { code: 'TRIAL_UNAVAILABLE' });
    }
    const trialDays = getTrialConfig().days;

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
        customer: customerId,
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: [
            {
                price: priceId,
                quantity: 1
            }
        ],
        ...(withTrial && {
            // Card is always collected; if it is missing when the trial ends the subscription is cancelled.
            payment_method_collection: 'always',
            subscription_data: {
                trial_period_days: trialDays,
                trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
                metadata: { userId: userId.toString(), plan, trial: 'true' }
            }
        }),
        success_url: `${FRONTEND_URL}/subscription-usage?success=true${withTrial ? '&trial=1' : ''}`,
        cancel_url: withTrial ? `${FRONTEND_URL}/trial?cancelled=true` : `${FRONTEND_URL}/subscription-plans?cancelled=true`,
        metadata: {
            userId: userId.toString(),
            plan: plan,
            ...(withTrial && { trial: 'true' })
        }
    });

    return { url: session.url, sessionId: session.id, trial: withTrial, trialDays: withTrial ? trialDays : null };
};

// Create Stripe Customer Portal session for billing management
export const createPortalSession = async (userId) => {
    if (!stripe) {
        throw new ApiError(500, 'Stripe is not configured');
    }

    const subscription = await getOrCreateSubscription(userId);

    if (!subscription.stripeCustomerId) {
        throw new ApiError(
            400,
            'No active subscription found. Please complete a purchase before accessing billing management.'
        );
    }

    const session = await stripe.billingPortal.sessions.create({
        customer: subscription.stripeCustomerId,
        return_url: `${FRONTEND_URL}/profile`
    });

    return { url: session.url };
};

// Shared prelude for on-site plan changes: validates the target plan, loads the
// user's Subscription, enforces preconditions (must have an active paid Stripe
// subscription, target must differ from current, Stripe configured, target
// priceId configured), and resolves the current Stripe subscription + item id.
async function resolvePlanChangeContext(userId, targetPlan) {
    if (!targetPlan || !STRIPE_CHECKOUT_PLANS.includes(targetPlan)) {
        throw new ApiError(400, `Invalid plan. Must be one of: ${STRIPE_CHECKOUT_PLANS.join(', ')}`);
    }

    if (!stripe) {
        throw new ApiError(500, 'Stripe is not configured');
    }

    const subscription = await getOrCreateSubscription(userId);

    if (!subscription.stripeSubscriptionId) {
        throw new ApiError(
            400,
            'No active subscription found. Please complete a purchase before changing plans.'
        );
    }

    if (subscription.plan === targetPlan) {
        throw new ApiError(400, 'You are already on this plan.');
    }

    const targetPriceId = STRIPE_PRICE_IDS[targetPlan];
    if (!targetPriceId) {
        throw new ApiError(500, `Stripe Price ID not configured for ${targetPlan} plan`);
    }

    const stripeSubscription = await stripe.subscriptions.retrieve(subscription.stripeSubscriptionId);
    const currentItemId = stripeSubscription.items?.data?.[0]?.id;

    if (!currentItemId) {
        throw new ApiError(500, 'Could not resolve current Stripe subscription item');
    }

    return { subscription, stripeSubscription, currentItemId, targetPriceId };
}

// Preview proration for an on-site plan change without charging the customer.
// Returns the immediate prorated charge (sum of proration line items), the next
// full invoice amount, and the next billing date.
export const previewPlanChange = async (userId, targetPlan) => {
    const { subscription, currentItemId, targetPriceId } = await resolvePlanChangeContext(userId, targetPlan);

    const previewParams = {
        customer: subscription.stripeCustomerId,
        subscription: subscription.stripeSubscriptionId,
        subscription_details: {
            items: [{
                id: currentItemId,
                price: targetPriceId
            }],
            proration_behavior: 'create_prorations'
        }
    };

    let upcomingInvoice;
    if (typeof stripe.invoices.createPreview === 'function') {
        upcomingInvoice = await stripe.invoices.createPreview(previewParams);
    } else if (typeof stripe.invoices.retrieveUpcoming === 'function') {
        // Legacy SDK shape: flat params, subscription_items + subscription_proration_behavior
        upcomingInvoice = await stripe.invoices.retrieveUpcoming({
            customer: subscription.stripeCustomerId,
            subscription: subscription.stripeSubscriptionId,
            subscription_items: [{
                id: currentItemId,
                price: targetPriceId
            }],
            subscription_proration_behavior: 'create_prorations'
        });
    } else {
        throw new ApiError(500, 'Stripe SDK does not support invoice preview (neither createPreview nor retrieveUpcoming available)');
    }

    const prorationLines = (upcomingInvoice.lines?.data ?? []).filter((line) => line.proration === true);
    const prorationTotal = prorationLines.reduce((sum, line) => sum + (line.amount ?? 0), 0);

    const nextBillingUnix = upcomingInvoice.next_payment_attempt ?? upcomingInvoice.period_end ?? null;
    const nextBillingDate = nextBillingUnix ? new Date(nextBillingUnix * 1000) : null;

    console.log(
        `[Subscription] Plan change preview for user ${userId}: ${subscription.plan} -> ${targetPlan}, proration=${prorationTotal} ${upcomingInvoice.currency}`
    );

    return {
        currentPlan: subscription.plan,
        targetPlan,
        currency: upcomingInvoice.currency,
        immediateCharge: prorationTotal,
        nextInvoiceAmount: upcomingInvoice.amount_due,
        nextBillingDate,
        prorationDate: new Date()
    };
};

// Execute an on-site plan change with immediate proration. The local
// Subscription doc is intentionally NOT updated here — handleSubscriptionUpdated
// (webhook) is the single source of truth for plan mutations via the reverse
// price-id map, which avoids race conditions and duplicated logic.
export const changePlan = async (userId, targetPlan) => {
    const { subscription, currentItemId, targetPriceId } = await resolvePlanChangeContext(userId, targetPlan);

    const updatedSubscription = await stripe.subscriptions.update(
        subscription.stripeSubscriptionId,
        {
            items: [{
                id: currentItemId,
                price: targetPriceId
            }],
            proration_behavior: 'create_prorations',
            payment_behavior: 'error_if_incomplete'
        }
    );

    console.log(
        `[Subscription] Plan change executed for user ${userId}: ${subscription.plan} -> ${targetPlan}, stripeStatus=${updatedSubscription.status}`
    );

    return {
        success: true,
        message: 'Plan change initiated. You will receive a confirmation shortly.',
        newPlan: targetPlan,
        stripeSubscriptionStatus: updatedSubscription.status
    };
};

// Handle Stripe webhook events
export const handleStripeWebhook = async (event) => {
    console.log(`[Stripe Webhook] Received event: ${event.type}`);

    // Check if we've already processed this event successfully
    const existingEvent = await StripeWebhookEvent.findOne({ eventId: event.id });
    if (existingEvent && existingEvent.processed) {
        console.log(`Webhook event ${event.id} already processed, skipping`);
        return;
    }

    if (!existingEvent) {
        try {
            await StripeWebhookEvent.create({
                eventId: event.id,
                type: event.type,
                processed: false,
            });
        } catch (error) {
            if (error?.code === 11000) {
                console.log(`Webhook event ${event.id} concurrent insert, skipping`);
                return;
            }
            throw error;
        }
    }

    switch (event.type) {
        case 'checkout.session.completed':
            await handleCheckoutCompleted(event.data.object);
            break;

        case 'customer.subscription.updated':
            await handleSubscriptionUpdated(event.data.object);
            break;

        case 'customer.subscription.created':
            await handleSubscriptionUpdated(event.data.object);
            break;

        case 'customer.subscription.deleted':
            await handleSubscriptionDeleted(event.data.object);
            break;

        // Stripe sends both for the same paid invoice; handlePaymentSucceeded runs once per invoice.
        case 'invoice.payment_succeeded':
        case 'invoice.paid':
            await handlePaymentSucceeded(event.data.object);
            break;

        case 'invoice.payment_failed':
            await handlePaymentFailed(event.data.object);
            break;

        default:
            console.log(`[Stripe Webhook] Unhandled event type: ${event.type}`);
    }

    await StripeWebhookEvent.updateOne(
        { eventId: event.id },
        { $set: { processed: true } }
    );
};

// Handle checkout session completed
async function handleCheckoutCompleted(session) {
    const userId = session.metadata?.userId;
    const plan = session.metadata?.plan;
    const stripeSubscriptionId = session.subscription;

    if (!userId || !plan) {
        console.error('[Stripe Webhook] Missing userId or plan in session metadata');
        return;
    }

    if (!mongoose.isValidObjectId(userId)) {
        console.error(`[Stripe Webhook] Invalid userId in session metadata: ${userId}`);
        return;
    }

    if (!STRIPE_CHECKOUT_PLANS.includes(plan)) {
        console.error(`[Stripe Webhook] Invalid plan in session metadata: ${plan}`);
        return;
    }

    if (!stripeSubscriptionId || !stripe) {
        console.error('[Stripe Webhook] Missing subscription id or Stripe client');
        return;
    }

    let subscription = await Subscription.findOne({ userId });
    const stripeSubscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
    const now = new Date();
    const [, periodEnd] = extractSubscriptionPeriod(stripeSubscription);
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
    const trialing = stripeSubscription.status === 'trialing';
    // A paid (or free-to-start trial) session is a started plan, whatever an early subscription snapshot says.
    // Otherwise (e.g. an async payment still pending) no paid access until Stripe reports it active.
    const sessionPaid = ['paid', 'no_payment_required'].includes(session.payment_status);
    const startedStatus = trialing ? SUBSCRIPTION_STATUS.TRIAL : SUBSCRIPTION_STATUS.ACTIVE;
    const status = sessionPaid ? startedStatus : (mapStripeStatus(stripeSubscription.status) ?? SUBSCRIPTION_STATUS.ACTIVE);
    const trialEndsAt = trialing && stripeSubscription.trial_end ? new Date(stripeSubscription.trial_end * 1000) : null;

    if (!subscription) {
        subscription = new Subscription({
            userId,
            plan,
            status,
            trialUsedAt: now,
            trialEndsAt,
            currentPeriodStart: now,
            currentPeriodEnd: periodEnd,
            usage: {
                videosUsed: 0,
                chatMessagesUsed: 0,
                lastResetAt: now
            },
            stripeSubscriptionId,
            stripeCustomerId: customerId || undefined,
            stripePriceId: stripeSubscription.items.data[0]?.price?.id,
            paymentFailed: false,
            paymentFailedAt: null
        });
        await subscription.save();
        console.log(`[Stripe Webhook] Created subscription for user ${userId}, plan ${plan}`);
        return;
    }

    subscription.plan = plan;
    subscription.status = status;
    // Any completed checkout (trial or paid) uses up the account's one free trial.
    if (!subscription.trialUsedAt) subscription.trialUsedAt = now;
    subscription.trialEndsAt = trialEndsAt;
    subscription.stripeSubscriptionId = stripeSubscriptionId;
    subscription.stripePriceId = stripeSubscription.items.data[0].price.id;
    if (customerId) {
        subscription.stripeCustomerId = customerId;
    }
    subscription.currentPeriodStart = now;
    subscription.currentPeriodEnd = periodEnd;
    subscription.usage.videosUsed = 0;
    subscription.usage.chatMessagesUsed = 0;
    subscription.usage.lastResetAt = now;
    subscription.paymentFailed = false;
    subscription.paymentFailedAt = null;

    await subscription.save();

    console.log(`[Stripe Webhook] Upgraded user ${userId} to ${plan} plan${trialing ? ' (free trial)' : ''}`);
}

/** Statuses a subscription can only reach after it started; it never goes from these back to incomplete. */
const PAID_START_STATUSES = [SUBSCRIPTION_STATUS.ACTIVE, SUBSCRIPTION_STATUS.TRIAL, SUBSCRIPTION_STATUS.PAST_DUE, SUBSCRIPTION_STATUS.UNPAID, SUBSCRIPTION_STATUS.PAUSED];

/** The subscription as Stripe has it now; the event's own copy only when Stripe can't be reached. */
async function liveStripeSubscription(eventSubscription) {
    try {
        const live = stripe ? await stripe.subscriptions.retrieve(eventSubscription.id) : null;
        if (live?.id) return live;
    } catch (err) {
        console.warn(`[Stripe Webhook] Could not fetch subscription ${eventSubscription.id}, using the event copy: ${err?.message}`);
    }
    return eventSubscription;
}

// Handle subscription updated.
// Also handles Stripe Customer Portal tier changes: if the line item's price id
// maps to a different local plan, update the plan and reset usage counters so
// a downgrade does not leave the user over-quota against the new lower limit.
async function handleSubscriptionUpdated(eventSubscription) {
    const subscription = await Subscription.findOne({
        stripeSubscriptionId: eventSubscription.id
    });

    if (!subscription) {
        console.error(`[Stripe Webhook] Subscription not found for Stripe subscription ${eventSubscription.id}`);
        return;
    }

    // Stripe events can arrive late, out of order or retried (e.g. created/incomplete after the invoice
    // was paid), so act on the subscription as it is now, not on the event's snapshot.
    const stripeSubscription = await liveStripeSubscription(eventSubscription);

    // Update period dates. Stripe API 2025-03-31+ moved current_period_* onto items[].
    // Helper reads item-level first, falls back to top-level; null guards prevent
    // overwriting valid existing dates if Stripe sends a payload with neither populated.
    const [periodStart, periodEnd] = extractSubscriptionPeriod(stripeSubscription);
    const previousStart = subscription.currentPeriodStart ? new Date(subscription.currentPeriodStart) : null;
    const periodAdvanced = Boolean(periodStart && previousStart && periodStart > previousStart);
    if (periodStart) subscription.currentPeriodStart = periodStart;
    if (periodEnd) subscription.currentPeriodEnd = periodEnd;

    // Mirror Stripe's status; unrecognized statuses leave the local status unchanged.
    let status = mapStripeStatus(stripeSubscription.status);
    if (status === SUBSCRIPTION_STATUS.INCOMPLETE && PAID_START_STATUSES.includes(subscription.status)) {
        // Stripe never moves a started subscription back to incomplete: this is a stale snapshot.
        console.warn(`[Stripe Webhook] Ignored stale incomplete status for user ${subscription.userId}`);
        status = null;
    }
    const resetUsage = () => {
        subscription.usage.videosUsed = 0;
        subscription.usage.chatMessagesUsed = 0;
        subscription.usage.lastResetAt = new Date();
    };
    if (status === SUBSCRIPTION_STATUS.TRIAL) {
        if (stripeSubscription.trial_end) subscription.trialEndsAt = new Date(stripeSubscription.trial_end * 1000);
    } else if (status === SUBSCRIPTION_STATUS.ACTIVE) {
        // Trial converted to paid, or a new paid period started (renewal): the full allowance starts now.
        // Not for past_due and the like: no fresh allowance until the renewal is paid.
        if (subscription.status === SUBSCRIPTION_STATUS.TRIAL || periodAdvanced) resetUsage();
        subscription.trialEndsAt = null;
    }
    if (status) subscription.status = status;

    // Detect Portal-driven plan changes via the current line-item price id.
    const newPriceId = stripeSubscription.items?.data?.[0]?.price?.id;
    const mappedPlan = newPriceId ? STRIPE_PRICE_ID_TO_PLAN[newPriceId] : null;
    const previousPlan = subscription.plan;

    if (newPriceId && !mappedPlan) {
        console.warn(
            `[Stripe Webhook] Unknown priceId ${newPriceId} on subscription.updated — plan left unchanged for user ${subscription.userId}`
        );
    } else if (mappedPlan && mappedPlan !== previousPlan) {
        subscription.plan = mappedPlan;
        subscription.stripePriceId = newPriceId;
        subscription.usage.videosUsed = 0;
        subscription.usage.chatMessagesUsed = 0;
        subscription.usage.lastResetAt = new Date();
        console.log(
            `[Stripe Webhook] Plan changed via Portal for user ${subscription.userId}: ${previousPlan} -> ${mappedPlan}`
        );
    } else if (newPriceId && mappedPlan === previousPlan && subscription.stripePriceId !== newPriceId) {
        // Same plan bucket but different price id (e.g. monthly<->yearly on the
        // same tier). Keep plan but record the current price id.
        subscription.stripePriceId = newPriceId;
    }

    await subscription.save();

    console.log(`[Stripe Webhook] Updated subscription for user ${subscription.userId}`);
}

// Handle subscription deleted/cancelled
async function handleSubscriptionDeleted(stripeSubscription) {
    const subscription = await Subscription.findOne({
        stripeSubscriptionId: stripeSubscription.id
    });

    if (!subscription) {
        console.error(`[Stripe Webhook] Subscription not found for Stripe subscription ${stripeSubscription.id}`);
        return;
    }

    // Downgrade to FREE plan (or back to a promo plan that is still running)
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    subscription.plan = planAfterBillingEnds(subscription, now);
    subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
    subscription.stripeSubscriptionId = null;
    subscription.stripePriceId = null;
    subscription.trialEndsAt = null;
    subscription.currentPeriodStart = now;
    subscription.currentPeriodEnd = periodEnd;
    subscription.usage.videosUsed = 0;
    subscription.usage.chatMessagesUsed = 0;
    subscription.usage.lastResetAt = now;
    subscription.paymentFailed = false;
    subscription.paymentFailedAt = null;

    await subscription.save();

    console.log(`[Stripe Webhook] Downgraded user ${subscription.userId} to ${subscription.plan.toUpperCase()} plan`);
}

// Handle payment succeeded (renew period)
// Runs once per invoice: invoice.payment_succeeded and invoice.paid both arrive for the same invoice,
// so the update only matches while lastPaidInvoiceId is a different invoice (atomic, retry-safe).
async function handlePaymentSucceeded(invoice) {
    const stripeSubscriptionId = invoiceSubscriptionId(invoice);
    if (!stripeSubscriptionId || !invoice?.id) return;

    const now = new Date();
    const subscription = await Subscription.findOneAndUpdate(
        { stripeSubscriptionId, lastPaidInvoiceId: { $ne: invoice.id } },
        {
            $set: {
                'usage.videosUsed': 0,
                'usage.chatMessagesUsed': 0,
                'usage.lastResetAt': now,
                paymentFailed: false,
                paymentFailedAt: null,
                lastPaidInvoiceId: invoice.id
            }
        },
        { new: true }
    );

    if (!subscription) {
        console.log(`[Stripe Webhook] Invoice ${invoice.id}: no subscription to update, or already processed`);
        return;
    }

    // A paid invoice brings a past-due or unpaid subscription back; Stripe's own update event confirms it.
    if ([SUBSCRIPTION_STATUS.PAST_DUE, SUBSCRIPTION_STATUS.UNPAID, SUBSCRIPTION_STATUS.INCOMPLETE].includes(subscription.status)) {
        subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
        await subscription.save();
    }

    console.log(`[Stripe Webhook] Reset usage for user ${subscription.userId} after payment`);
}

// Handle payment failed
async function handlePaymentFailed(invoice) {
    const stripeSubscriptionId = invoiceSubscriptionId(invoice);
    if (!stripeSubscriptionId) return;

    const subscription = await Subscription.findOne({ stripeSubscriptionId });

    if (!subscription) {
        console.error(`[Stripe Webhook] Subscription not found for invoice ${invoice.id}`);
        return;
    }

    subscription.paymentFailed = true;
    subscription.paymentFailedAt = new Date();
    await subscription.save();

    console.log(`[Stripe Webhook] Payment failed recorded for user ${subscription.userId} (access unchanged; Stripe dunning)`);
}

// Cancel subscription (immediate downgrade to FREE)
export const cancelSubscription = async (userId) => {
    const subscription = await getOrCreateSubscription(userId);

    if (subscription.plan === SUBSCRIPTION_PLANS.FREE) {
        throw new ApiError(400, 'You are already on the FREE plan');
    }

    if (!subscription.stripeSubscriptionId) {
        throw new ApiError(400, 'No active Stripe subscription found');
    }

    if (!stripe) {
        throw new ApiError(500, 'Stripe is not configured');
    }

    // Cancel Stripe subscription immediately
    await stripe.subscriptions.cancel(subscription.stripeSubscriptionId);

    // Downgrade to FREE plan immediately (or back to a promo plan that is still running)
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    subscription.plan = planAfterBillingEnds(subscription, now);
    subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
    subscription.stripeSubscriptionId = null;
    subscription.stripePriceId = null;
    subscription.trialEndsAt = null;
    subscription.currentPeriodStart = now;
    subscription.currentPeriodEnd = periodEnd;
    subscription.usage.videosUsed = 0;
    subscription.usage.chatMessagesUsed = 0;
    subscription.usage.lastResetAt = now;
    subscription.paymentFailed = false;
    subscription.paymentFailedAt = null;

    await subscription.save();

    console.log(`[Subscription] Cancelled and downgraded user ${userId} to ${subscription.plan.toUpperCase()} plan`);

    return subscription;
};

