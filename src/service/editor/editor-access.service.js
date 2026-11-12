import { User } from '../../model/user.model.js';
import { EditProject } from '../../model/edit-project.model.js';
import { EDITOR_LIMITS, SUBSCRIPTION_PLANS } from '../../constants.js';
import { getOrCreateSubscription } from '../subscription.service.js';

/**
 * Editor access: every account gets one free AI edit for life, then each plan has a cap per billing
 * period (EDITOR_LIMITS). An edit is charged only once its plan is produced, so failed uploads,
 * preprocessing or planning never use anything up.
 */

const startOfMonth = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const startOfNextMonth = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

export async function editorUsage(userId, { now = new Date() } = {}) {
    const [subscription, user] = await Promise.all([
        getOrCreateSubscription(userId),
        User.findById(userId).select('editorTrialUsedAt').lean(),
    ]);
    const plan = subscription?.plan ?? SUBSCRIPTION_PLANS.FREE;
    const limit = EDITOR_LIMITS[plan] ?? 0;
    const paid = plan !== SUBSCRIPTION_PLANS.FREE;
    const periodStart = paid && subscription.currentPeriodStart ? subscription.currentPeriodStart : startOfMonth(now);
    const resetsOn = paid && subscription.currentPeriodEnd ? subscription.currentPeriodEnd : startOfNextMonth(now);
    const used = await EditProject.countDocuments({ userId, 'billing.kind': 'plan', 'billing.countedAt': { $gte: periodStart } });
    const trialAvailable = !user?.editorTrialUsedAt;
    const remaining = Math.max(0, limit - used);
    const canStart = trialAvailable || remaining > 0;
    return { plan, limit, used, remaining, resetsOn, trialAvailable, canStart, locked: !canStart && limit === 0 };
}

/** Why a new edit can't start, as `{status, code, message}`, or null when it can. */
export function accessError(usage) {
    if (usage.canStart) return null;
    if (usage.limit === 0) {
        return { status: 403, code: 'UPGRADE_REQUIRED', message: 'You have used your free edit. Upgrade to Premium to keep editing.' };
    }
    return { status: 429, code: 'EDITOR_LIMIT', message: `You have used all ${usage.limit} edits for this period. More unlock when your plan renews.` };
}

/**
 * Charge one edit for a project whose plan was just produced. Uses the lifetime free edit first.
 * Idempotent: a project is charged at most once (regenerations are included).
 * @returns {'trial'|'plan'|null} what was charged, or null if it already had been
 */
export async function chargeEdit(projectId, userId, { now = new Date() } = {}) {
    const project = await EditProject.findOne({ _id: projectId, userId }).select('billing').lean();
    if (!project || project.billing?.countedAt) return null;
    const trial = await User.findOneAndUpdate({ _id: userId, editorTrialUsedAt: null }, { $set: { editorTrialUsedAt: now } }).select('_id').lean();
    const kind = trial ? 'trial' : 'plan';
    const res = await EditProject.updateOne(
        { _id: projectId, 'billing.countedAt': null },
        { $set: { 'billing.kind': kind, 'billing.countedAt': now } }
    );
    if (res.modifiedCount === 0 && trial) {
        // Another worker charged it first; give the free edit back.
        await User.updateOne({ _id: userId, editorTrialUsedAt: now }, { $set: { editorTrialUsedAt: null } });
        return null;
    }
    return kind;
}
