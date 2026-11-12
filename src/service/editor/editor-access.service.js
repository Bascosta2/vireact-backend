import { EditProject } from '../../model/edit-project.model.js';
import { EDITOR_LIMITS, SUBSCRIPTION_PLANS } from '../../constants.js';
import { getOrCreateSubscription } from '../subscription.service.js';

/**
 * Editor access: each plan has a cap of AI edits per period (EDITOR_LIMITS). Free accounts get theirs
 * per calendar month (UTC); paid plans per billing period. An edit is charged only once its plan is
 * produced, so failed uploads, preprocessing or planning never use anything up.
 */

const startOfMonth = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const startOfNextMonth = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

export async function editorUsage(userId, { now = new Date() } = {}) {
    const subscription = await getOrCreateSubscription(userId);
    const plan = subscription?.plan ?? SUBSCRIPTION_PLANS.FREE;
    const limit = EDITOR_LIMITS[plan] ?? 0;
    const paid = plan !== SUBSCRIPTION_PLANS.FREE;
    const periodStart = paid && subscription.currentPeriodStart ? subscription.currentPeriodStart : startOfMonth(now);
    const resetsOn = paid && subscription.currentPeriodEnd ? subscription.currentPeriodEnd : startOfNextMonth(now);
    // Any charged edit counts, including ones charged as the old lifetime 'trial' kind.
    const used = await EditProject.countDocuments({ userId, 'billing.countedAt': { $gte: periodStart } });
    const remaining = Math.max(0, limit - used);
    const canStart = remaining > 0;
    return { plan, limit, used, remaining, resetsOn, canStart, locked: !canStart && !paid };
}

/** Why a new edit can't start, as `{status, code, message}`, or null when it can. */
export function accessError(usage) {
    if (usage.canStart) return null;
    if (usage.plan === SUBSCRIPTION_PLANS.FREE) {
        return { status: 403, code: 'UPGRADE_REQUIRED', message: 'You have used this month\'s free AI edit. Upgrade to Premium for more, or wait until next month.' };
    }
    return { status: 429, code: 'EDITOR_LIMIT', message: `You have used all ${usage.limit} edits for this period. More unlock when your plan renews.` };
}

/**
 * Charge one edit for a project whose plan was just produced.
 * Idempotent: a project is charged at most once (regenerations are included).
 * @returns {'plan'|null} what was charged, or null if it already had been
 */
export async function chargeEdit(projectId, userId, { now = new Date() } = {}) {
    const res = await EditProject.updateOne(
        { _id: projectId, userId, 'billing.countedAt': null },
        { $set: { 'billing.kind': 'plan', 'billing.countedAt': now } }
    );
    return res.modifiedCount ? 'plan' : null;
}
