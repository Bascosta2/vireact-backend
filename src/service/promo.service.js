import { PromoRedemption } from '../model/promo-redemption.model.js';
import { ApiError } from '../utils/ApiError.js';
import { SUBSCRIPTION_PLANS, SUBSCRIPTION_STATUS } from '../constants.js';
import { getPromoCode, normalizePromoCode } from '../config/promo-codes.js';
import { getOrCreateSubscription } from './subscription.service.js';
import { promoInfo, promoIsActive } from './promo-state.js';

const RANK = { [SUBSCRIPTION_PLANS.FREE]: 0, [SUBSCRIPTION_PLANS.PREMIUM]: 1, [SUBSCRIPTION_PLANS.PRO]: 2, [SUBSCRIPTION_PLANS.ENTERPRISE]: 3 };
const PLAN_NAMES = { free: 'Free', premium: 'Premium', pro: 'Pro', enterprise: 'Enterprise' };
const DAY_MS = 24 * 60 * 60 * 1000;

const fail = (status, message, code) => new ApiError(status, message, { code });

/**
 * Redeem a promo code for the signed-in account and switch its plan.
 * Refuses: unknown or switched-off codes, a code this account already used, a code past its
 * redemption limit, accounts billed through Stripe, and accounts whose plan is already higher
 * (or already the same plan for life).
 */
export async function redeemPromoCode(userId, rawCode, now = new Date()) {
    const code = normalizePromoCode(rawCode);
    if (!code) throw fail(400, 'Enter a promo code.', 'PROMO_INVALID');
    const promo = code.length <= 64 ? getPromoCode(code) : null;
    if (!promo) throw fail(400, "That promo code isn't valid. Check the spelling and try again.", 'PROMO_INVALID');

    if (await PromoRedemption.exists({ userId, code })) {
        throw fail(409, 'You have already used this promo code.', 'PROMO_USED');
    }
    if (promo.maxRedemptions != null && (await PromoRedemption.countDocuments({ code })) >= promo.maxRedemptions) {
        throw fail(410, 'This promo code has been fully claimed.', 'PROMO_EXHAUSTED');
    }

    const subscription = await getOrCreateSubscription(userId);
    if (subscription.stripeSubscriptionId) {
        throw fail(
            409,
            'Your plan is billed through Stripe, so a promo code cannot be added to it. Cancel it in Manage billing first, then redeem the code.',
            'PROMO_HAS_BILLING'
        );
    }
    const current = RANK[subscription.plan] ?? 0;
    const target = RANK[promo.plan];
    const currentIsLifetime = promoIsActive(subscription, now) && !subscription.promo.endsAt;
    if (current > target || (current === target && currentIsLifetime)) {
        throw fail(409, `Your ${PLAN_NAMES[subscription.plan]} plan already includes everything this code unlocks.`, 'PROMO_NOT_NEEDED');
    }

    const endsAt = promo.days ? new Date(now.getTime() + promo.days * DAY_MS) : null;
    try {
        await PromoRedemption.create({ userId, code, plan: promo.plan, grantedAt: now, endsAt });
    } catch (err) {
        if (err?.code === 11000) throw fail(409, 'You have already used this promo code.', 'PROMO_USED');
        throw err;
    }

    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);
    subscription.plan = promo.plan;
    subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
    subscription.promo = { code, plan: promo.plan, grantedAt: now, endsAt };
    subscription.trialEndsAt = null;
    subscription.currentPeriodStart = now;
    subscription.currentPeriodEnd = periodEnd;
    subscription.usage.videosUsed = 0;
    subscription.usage.chatMessagesUsed = 0;
    subscription.usage.lastResetAt = now;
    subscription.paymentFailed = false;
    subscription.paymentFailedAt = null;
    await subscription.save();

    console.log(`[Promo] user ${userId} redeemed ${code}: ${promo.plan}${endsAt ? ` until ${endsAt.toISOString()}` : ' for life'}`);
    return { label: promo.label, plan: promo.plan, promo: promoInfo(subscription, now) };
}
