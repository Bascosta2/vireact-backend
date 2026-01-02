import { Subscription } from '../model/subscription.model.js';
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

// Check video limit before upload
export const checkVideoLimit = async (userId) => {
    const subscription = await getOrCreateSubscription(userId);
    await checkAndResetPeriod(subscription);

    const limits = PLAN_LIMITS[subscription.plan];
    
    if (subscription.usage.videosUsed >= limits.videosPerMonth) {
        throw new ApiError(
            403,
            `Video limit reached. You've used ${subscription.usage.videosUsed}/${limits.videosPerMonth} videos this month. Upgrade your plan for more videos.`
        );
    }

    return true;
};

// Check chat limit before message
export const checkChatLimit = async (userId) => {
    const subscription = await getOrCreateSubscription(userId);
    await checkAndResetPeriod(subscription);

    const limits = PLAN_LIMITS[subscription.plan];
    
    if (subscription.usage.chatMessagesUsed >= limits.chatMessagesPerMonth) {
        throw new ApiError(
            403,
            `Chat message limit reached. You've used ${subscription.usage.chatMessagesUsed}/${limits.chatMessagesPerMonth} messages this month. Upgrade your plan for more messages.`
        );
    }

    return true;
};

// Increment video usage after successful analysis
export const incrementVideoUsage = async (userId) => {
    const subscription = await getOrCreateSubscription(userId);
    await checkAndResetPeriod(subscription);

    subscription.usage.videosUsed += 1;
    await subscription.save();

    console.log(`[Subscription] Incremented video usage for user ${userId}: ${subscription.usage.videosUsed}/${PLAN_LIMITS[subscription.plan].videosPerMonth}`);

    return subscription;
};

// Increment chat usage after AI response
export const incrementChatUsage = async (userId) => {
    const subscription = await getOrCreateSubscription(userId);
    await checkAndResetPeriod(subscription);

    subscription.usage.chatMessagesUsed += 1;
    await subscription.save();

    console.log(`[Subscription] Incremented chat usage for user ${userId}: ${subscription.usage.chatMessagesUsed}/${PLAN_LIMITS[subscription.plan].chatMessagesPerMonth}`);

    return subscription;
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

    switch (event.type) {
        case 'checkout.session.completed':
            await handleCheckoutCompleted(event.data.object);
            break;

        case 'customer.subscription.updated':
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
    const userId = session.metadata.userId;
    const plan = session.metadata.plan;
    const stripeSubscriptionId = session.subscription;

    if (!userId || !plan) {
        console.error('[Stripe Webhook] Missing userId or plan in session metadata');
        return;
    }

    const subscription = await Subscription.findOne({ userId });
    if (!subscription) {
        console.error(`[Stripe Webhook] Subscription not found for user ${userId}`);
        return;
    }

    // Get Stripe subscription details
    const stripeSubscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);

    // Update subscription
    const now = new Date();
    const periodEnd = new Date(stripeSubscription.current_period_end * 1000);

    subscription.plan = plan;
    subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
    subscription.stripeSubscriptionId = stripeSubscriptionId;
    subscription.stripePriceId = stripeSubscription.items.data[0].price.id;
    subscription.currentPeriodStart = now;
    subscription.currentPeriodEnd = periodEnd;
    subscription.usage.videosUsed = 0;
    subscription.usage.chatMessagesUsed = 0;
    subscription.usage.lastResetAt = now;

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

    console.log(`[Stripe Webhook] Payment failed for user ${subscription.userId}`);
    // Stripe will handle retries automatically
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

    await subscription.save();

    console.log(`[Subscription] Cancelled and downgraded user ${userId} to FREE plan`);

    return subscription;
};

