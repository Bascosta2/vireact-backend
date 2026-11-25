import { SUBSCRIPTION_PLANS, SUBSCRIPTION_STATUS, ROLES } from '../constants.js';
import { getNewUserAccessModel, ACCESS_MODELS } from '../config/flags.js';
import { Subscription } from '../model/subscription.model.js';
import { promoLapsed, planAfterBillingEnds } from './promo-state.js';

export const ACCESS_STATES = Object.freeze({
    LEAD: 'lead',
    TRIALING: 'trialing',
    ACTIVE: 'active',
    PAST_DUE: 'past_due',
    CANCELED: 'canceled',
    LEGACY_FREE: 'legacy_free',
});

const ENTITLED_STATES = new Set([ACCESS_STATES.TRIALING, ACCESS_STATES.ACTIVE, ACCESS_STATES.LEGACY_FREE]);

/**
 * Subscription statuses that give no paid access: the account is treated as Free (or as its promo plan,
 * if one is still running). past_due is NOT here: Stripe is retrying the card, so access stays.
 */
export const NO_PAID_ACCESS_STATUSES = new Set([
    SUBSCRIPTION_STATUS.CANCELLED,
    SUBSCRIPTION_STATUS.EXPIRED,
    SUBSCRIPTION_STATUS.UNPAID,
    SUBSCRIPTION_STATUS.PAUSED,
    SUBSCRIPTION_STATUS.INCOMPLETE,
    SUBSCRIPTION_STATUS.INCOMPLETE_EXPIRED,
]);

/**
 * The plan whose features and limits apply right now: the stored plan, unless its promo has ended
 * or the billing status gives no paid access. Every feature gate should read the plan through this.
 */
export function effectivePlan(subscription, now = new Date()) {
    if (!subscription?.plan) return SUBSCRIPTION_PLANS.FREE;
    if (promoLapsed(subscription, now)) return SUBSCRIPTION_PLANS.FREE;
    if (NO_PAID_ACCESS_STATUSES.has(subscription.status)) return planAfterBillingEnds(subscription, now);
    return subscription.plan;
}

/** Stripe is retrying a failed payment: access stays, but no fresh period allowance is granted. */
export const isPastDue = (subscription) =>
    subscription?.status === SUBSCRIPTION_STATUS.PAST_DUE
    || Boolean(subscription?.paymentFailed && subscription?.stripeSubscriptionId);

/**
 * Access state (plan §8.3), reduced to what exists before Phase 6:
 * no Stripe trial status yet, so a paid plan with an active subscription row is
 * `active`, a payment failure is `past_due`, and everyone else is
 * `legacy_free` under the default model or `lead` under card_trial (unless
 * flagged `legacyFree`). Phase 6 replaces the paid branch with Stripe status.
 */
export function getAccessState(user, subscription, { model = getNewUserAccessModel() } = {}) {
    if (!user) return null;
    // A promo plan that has ended, or a billing status without paid access, counts as Free.
    const paid = Boolean(subscription) && effectivePlan(subscription) !== SUBSCRIPTION_PLANS.FREE;
    if (paid && (subscription.paymentFailed || subscription.status === SUBSCRIPTION_STATUS.PAST_DUE)) return ACCESS_STATES.PAST_DUE;
    if (paid && subscription.status === SUBSCRIPTION_STATUS.TRIAL) return ACCESS_STATES.TRIALING;
    if (paid && subscription.status === SUBSCRIPTION_STATUS.ACTIVE) return ACCESS_STATES.ACTIVE;
    // Billing ended or unpaid, but a promo plan is still running: the promo carries the account.
    if (paid && NO_PAID_ACCESS_STATUSES.has(subscription.status)) return ACCESS_STATES.ACTIVE;
    if (model === ACCESS_MODELS.CARD_TRIAL && !user.legacyFree) return ACCESS_STATES.LEAD;
    return ACCESS_STATES.LEGACY_FREE;
}

export const isEntitledState = (state) => ENTITLED_STATES.has(state);

/** Admin accounts (Admin model) can always read members content. */
export const isAdminPrincipal = (user) =>
    Boolean(user) && [ROLES.ADMIN, ROLES.SUPER_ADMIN].includes(user.role);

/** Reads (never creates) the subscription row. */
export async function resolveAccess(user) {
    if (!user) return { state: null, entitled: false };
    if (isAdminPrincipal(user)) return { state: ACCESS_STATES.ACTIVE, entitled: true };
    const subscription = await Subscription.findOne({ userId: user._id }).lean();
    const state = getAccessState(user, subscription);
    return { state, entitled: isEntitledState(state) };
}

/** Post-auth destination (plan §7). Only used when the funnel flag is on. */
export function computePostAuthPath(state, { hasUploaded = false } = {}) {
    if (state === ACCESS_STATES.LEAD) return '/start/trial';
    if (isEntitledState(state) && !hasUploaded) return '/upload?onboarding=1';
    return '/dashboard';
}
