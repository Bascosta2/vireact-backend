import { SUBSCRIPTION_PLANS, SUBSCRIPTION_STATUS, ROLES } from '../constants.js';
import { getNewUserAccessModel, ACCESS_MODELS } from '../config/flags.js';
import { Subscription } from '../model/subscription.model.js';

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
 * Access state (plan §8.3), reduced to what exists before Phase 6:
 * no Stripe trial status yet, so a paid plan with an active subscription row is
 * `active`, a payment failure is `past_due`, and everyone else is
 * `legacy_free` under the default model or `lead` under card_trial (unless
 * flagged `legacyFree`). Phase 6 replaces the paid branch with Stripe status.
 */
export function getAccessState(user, subscription, { model = getNewUserAccessModel() } = {}) {
    if (!user) return null;
    const paid = subscription && subscription.plan && subscription.plan !== SUBSCRIPTION_PLANS.FREE;
    if (paid && subscription.paymentFailed) return ACCESS_STATES.PAST_DUE;
    if (paid && subscription.status === SUBSCRIPTION_STATUS.TRIAL) return ACCESS_STATES.TRIALING;
    if (paid && subscription.status === SUBSCRIPTION_STATUS.ACTIVE) return ACCESS_STATES.ACTIVE;
    if (paid && subscription.status === SUBSCRIPTION_STATUS.CANCELLED) return ACCESS_STATES.CANCELED;
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
