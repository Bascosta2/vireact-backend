import mongoose from 'mongoose';
import { Subscription } from '../model/subscription.model.js';
import { StripeWebhookEvent } from '../model/stripe-webhook-event.model.js';
import { ApiError } from '../utils/ApiError.js';
import { SUBSCRIPTION_PLANS, SUBSCRIPTION_STATUS, PLAN_LIMITS, STRIPE_PRICE_IDS } from '../constants.js';
import stripe from '../lib/stripe.js';
import { FRONTEND_URL, BACKEND_URL } from '../config/index.js';

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
    }

    return subscription;
};

// Check and reset period if needed
export const checkAndResetPeriod = async (subscription) => {
    const now = new Date();

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
    const limits = PLAN_LIMITS[subscription.plan];
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
            `Video limit reached. You've used ${subscription.usage.videosUsed}/${limits.videosPerMonth} videos this month. Upgrade your plan for more videos.`
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
    const limits = PLAN_LIMITS[subscription.plan];
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
            `Chat message limit reached. You've used ${subscription.usage.chatMessagesUsed}/${limits.chatMessagesPerMonth} messages this month. Upgrade your plan for more messages.`
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


// Create Stripe checkout session
export const createCheckoutSession = async (userId, userEmail, plan) => {
    if (!stripe) {
        throw new ApiError(500, 'Stripe is not configured');
    }

    if (!plan || (plan !== 'starter' && plan !== 'pro')) {
        throw new ApiError(400, 'Invalid plan. Must be "starter" or "pro"');
    }

    const priceId = STRIPE_PRICE_IDS[plan];
    if (!priceId) {
        throw new ApiError(500, `Stripe Price ID not configured for ${plan} plan`);
    }

    const subscription = await getOrCreateSubscription(userId);

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
        success_url: `${FRONTEND_URL}/subscription-usage?success=true`,
        cancel_url: `${FRONTEND_URL}/subscription-plans?cancelled=true`,
        metadata: {
            userId: userId.toString(),
            plan: plan
        }
    });

    return { url: session.url, sessionId: session.id };
};

// Handle Stripe webhook events
export const handleStripeWebhook = async (event) => {
    console.log(`[Stripe Webhook] Received event: ${event.type}`);
    try {
        await StripeWebhookEvent.create({
            eventId: event.id,
            type: event.type
        });
    } catch (error) {
        if (error?.code === 11000) {
            console.log(`[Stripe Webhook] Duplicate event ignored: ${event.id}`);
            return;
        }
        throw error;
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

        case 'invoice.payment_succeeded':
            await handlePaymentSucceeded(event.data.object);
            break;

        case 'invoice.payment_failed':
            await handlePaymentFailed(event.data.object);
            break;

        default:
            console.log(`[Stripe Webhook] Unhandled event type: ${event.type}`);
    }
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

    if (plan !== SUBSCRIPTION_PLANS.STARTER && plan !== SUBSCRIPTION_PLANS.PRO) {
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
    const periodEnd = new Date(stripeSubscription.current_period_end * 1000);
    const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;

    if (!subscription) {
        subscription = new Subscription({
            userId,
            plan,
            status: SUBSCRIPTION_STATUS.ACTIVE,
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
    subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
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

    console.log(`[Stripe Webhook] Upgraded user ${userId} to ${plan} plan`);
}

// Handle subscription updated
async function handleSubscriptionUpdated(stripeSubscription) {
    const subscription = await Subscription.findOne({
        stripeSubscriptionId: stripeSubscription.id
    });

    if (!subscription) {
        console.error(`[Stripe Webhook] Subscription not found for Stripe subscription ${stripeSubscription.id}`);
        return;
    }

    // Update period dates
    subscription.currentPeriodStart = new Date(stripeSubscription.current_period_start * 1000);
    subscription.currentPeriodEnd = new Date(stripeSubscription.current_period_end * 1000);

    // Update status
    if (stripeSubscription.status === 'active') {
        subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
    } else if (stripeSubscription.status === 'canceled') {
        subscription.status = SUBSCRIPTION_STATUS.CANCELLED;
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

    // Downgrade to FREE plan
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    subscription.plan = SUBSCRIPTION_PLANS.FREE;
    subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
    subscription.stripeSubscriptionId = null;
    subscription.stripePriceId = null;
    subscription.currentPeriodStart = now;
    subscription.currentPeriodEnd = periodEnd;
    subscription.usage.videosUsed = 0;
    subscription.usage.chatMessagesUsed = 0;
    subscription.usage.lastResetAt = now;
    subscription.paymentFailed = false;
    subscription.paymentFailedAt = null;

    await subscription.save();

    console.log(`[Stripe Webhook] Downgraded user ${subscription.userId} to FREE plan`);
}

// Handle payment succeeded (renew period)
async function handlePaymentSucceeded(invoice) {
    if (!invoice.subscription) return;

    const subscription = await Subscription.findOne({
        stripeSubscriptionId: invoice.subscription
    });

    if (!subscription) {
        console.error(`[Stripe Webhook] Subscription not found for invoice ${invoice.id}`);
        return;
    }

    // Reset usage for new billing period
    const now = new Date();
    subscription.usage.videosUsed = 0;
    subscription.usage.chatMessagesUsed = 0;
    subscription.usage.lastResetAt = now;
    subscription.paymentFailed = false;
    subscription.paymentFailedAt = null;

    await subscription.save();

    console.log(`[Stripe Webhook] Reset usage for user ${subscription.userId} after payment`);
}

// Handle payment failed
async function handlePaymentFailed(invoice) {
    if (!invoice.subscription) return;

    const subscription = await Subscription.findOne({
        stripeSubscriptionId: invoice.subscription
    });

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

    // Downgrade to FREE plan immediately
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    subscription.plan = SUBSCRIPTION_PLANS.FREE;
    subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
    subscription.stripeSubscriptionId = null;
    subscription.stripePriceId = null;
    subscription.currentPeriodStart = now;
    subscription.currentPeriodEnd = periodEnd;
    subscription.usage.videosUsed = 0;
    subscription.usage.chatMessagesUsed = 0;
    subscription.usage.lastResetAt = now;
    subscription.paymentFailed = false;
    subscription.paymentFailedAt = null;

    await subscription.save();

    console.log(`[Subscription] Cancelled and downgraded user ${userId} to FREE plan`);

    return subscription;
};

