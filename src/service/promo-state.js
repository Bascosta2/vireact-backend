import { SUBSCRIPTION_PLANS, SUBSCRIPTION_STATUS } from '../constants.js';
import { promoCodeRef } from '../config/promo-codes.js';

/**
 * Plain rules about a subscription's promo grant. No database access except `expirePromoIfDue`,
 * which saves the document it is given. Kept apart from subscription.service so both it and
 * access.service can use them without an import cycle.
 */

/** The promo grant is still running (lifetime, or its end date is in the future). */
export const promoIsActive = (subscription, now = new Date()) => {
    const promo = subscription?.promo;
    if (!promo?.plan) return false;
    return !promo.endsAt || new Date(promo.endsAt) > now;
};

/**
 * The promo has ended and it is still the only thing giving this account its plan
 * (no Stripe subscription). Such an account is really on Free.
 */
export const promoLapsed = (subscription, now = new Date()) => {
    const promo = subscription?.promo;
    if (!promo?.plan || !promo.endsAt || new Date(promo.endsAt) > now) return false;
    return !subscription.stripeSubscriptionId && subscription.plan === promo.plan;
};

/** Promo state for the web app, or null. */
export const promoInfo = (subscription, now = new Date()) => {
    if (!promoIsActive(subscription, now)) return null;
    const { code, plan, grantedAt, endsAt } = subscription.promo;
    return { code, plan, grantedAt: grantedAt ?? null, endsAt: endsAt ?? null, lifetime: !endsAt };
};

/** The plan to fall back to when a Stripe subscription ends: a running promo plan, otherwise Free. */
export const planAfterBillingEnds = (subscription, now = new Date()) =>
    promoIsActive(subscription, now) ? subscription.promo.plan : SUBSCRIPTION_PLANS.FREE;

/**
 * Ends a promo whose time is up. If the promo was the account's plan, the account goes back to Free
 * with a fresh usage period. Returns true when the document changed (and was saved).
 */
export const expirePromoIfDue = async (subscription, now = new Date()) => {
    const promo = subscription?.promo;
    if (!promo?.plan || !promo.endsAt || new Date(promo.endsAt) > now) return false;

    if (promoLapsed(subscription, now)) {
        const periodEnd = new Date(now);
        periodEnd.setMonth(periodEnd.getMonth() + 1);
        subscription.plan = SUBSCRIPTION_PLANS.FREE;
        subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
        subscription.currentPeriodStart = now;
        subscription.currentPeriodEnd = periodEnd;
        subscription.usage.videosUsed = 0;
        subscription.usage.chatMessagesUsed = 0;
        subscription.usage.lastResetAt = now;
        console.log(`[Promo] code ${promoCodeRef(promo.code)} ended for user ${subscription.userId}; back to FREE`);
    }
    subscription.promo = null;
    await subscription.save();
    return true;
};
