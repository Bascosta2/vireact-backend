import crypto from 'node:crypto';
import { FunnelSession } from '../model/funnel-session.model.js';
import { RewriteUsage } from '../model/rewrite-usage.model.js';
import { User } from '../model/user.model.js';
import { LibraryItem } from '../model/library-item.model.js';
import { SESSION_SECRET } from '../config/index.js';
import { isLifecycleEmailsEnabled } from '../config/flags.js';
import { sanitizeAttribution } from '../utils/attribution.js';
import {
    sanitizeAnswers,
    isQuizComplete,
    isHighIntent,
    recommendedPlanFor,
    segmentFor,
    statusRank,
    QUIZ_KEYS,
} from '../constants/funnel-quiz.js';
import { buildDiagnosis } from '../constants/funnel-diagnosis.js';
import { recommendedFor, servedFilter, serializeItem } from './library.service.js';

const MAX_STEPS = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export const isSessionId = (value) => typeof value === 'string' && UUID_RE.test(value);
export const isValidEmail = (value) => typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value.trim());

/** Keyed hash so raw IPs are never stored. */
export const hashIp = (ip) =>
    crypto.createHmac('sha256', SESSION_SECRET || 'vireact-funnel').update(String(ip || '')).digest('hex').slice(0, 32);

const sanitizeSlug = (value) => (typeof value === 'string' && /^[a-z0-9-]{3,120}$/.test(value) ? value : undefined);

const stepEntry = (step) => ({ step: String(step).slice(0, 60), at: new Date() });

/** A session linked to a user is only visible to that user. */
export const canAccessSession = (session, user) =>
    Boolean(session) && (!session.userId || Boolean(user && String(session.userId) === String(user._id)));

export async function createSession({ attribution, entryItemSlug, ip, userId } = {}) {
    const session = await FunnelSession.create({
        attribution: sanitizeAttribution(attribution) || undefined,
        entryItemSlug: sanitizeSlug(entryItemSlug),
        ipHash: hashIp(ip),
        steps: [stepEntry('started')],
        ...(userId ? { userId, purgeable: false } : {}),
    });
    return session;
}

export async function findSession(id) {
    if (!isSessionId(id)) return null;
    return FunnelSession.findById(id).lean();
}

/** Merges answers. Re-answering after completion re-opens results computation on the next /complete. */
export async function updateAnswers(session, { answers, step } = {}) {
    const clean = sanitizeAnswers(answers);
    if (clean.errors.length) return { errors: clean.errors };
    const set = {};
    for (const [key, value] of Object.entries(clean.answers)) set[`answers.${key}`] = value;
    const update = { $push: { steps: { $each: [stepEntry(step || 'answer')], $slice: -MAX_STEPS } } };
    if (Object.keys(set).length) update.$set = set;
    const updated = await FunnelSession.findByIdAndUpdate(session._id, update, { new: true, runValidators: true }).lean();
    return { session: updated };
}

export async function completeSession(session) {
    const answers = Object.fromEntries(QUIZ_KEYS.map((k) => [k, session.answers?.[k]]));
    if (!isQuizComplete(answers)) return { error: 'Quiz is incomplete' };

    const match = await recommendedFor(
        { problem: answers.problem, niche: answers.niche, platform: answers.platform },
        { entitled: false, preferSlug: session.entryItemSlug }
    );
    const set = {
        segment: segmentFor(answers),
        highIntent: isHighIntent(answers),
        recommendedPlan: recommendedPlanFor(answers),
        matchedItemSlugs: match.items.map((i) => i.slug),
    };
    if (statusRank(session.status) < statusRank('completed')) set.status = 'completed';
    const updated = await FunnelSession.findByIdAndUpdate(
        session._id,
        { $set: set, $push: { steps: { $each: [stepEntry('completed')], $slice: -MAX_STEPS } } },
        { new: true, runValidators: true }
    ).lean();
    return { session: updated };
}

/**
 * Results payload. Matched items are re-read so an item unpublished after the
 * quiz disappears instead of being served from the session.
 */
export async function buildResults(session) {
    if (!session.recommendedPlan) return null;
    const slugs = session.matchedItemSlugs || [];
    const docs = slugs.length ? await LibraryItem.find({ slug: { $in: slugs }, ...servedFilter(false) }).lean() : [];
    const bySlug = new Map(docs.map((d) => [d.slug, d]));
    const hooks = slugs.map((s) => bySlug.get(s)).filter(Boolean).map(serializeItem);
    return {
        sessionId: session._id,
        answers: session.answers,
        diagnosis: buildDiagnosis(session.answers || {}),
        hooks,
        hooksHidden: hooks.length === 0,
        highIntent: Boolean(session.highIntent),
        recommendedPlan: session.recommendedPlan,
        emailCaptured: Boolean(session.email),
        // Email capture is only offered once result emails are actually sent (Phase 8).
        emailDelivery: isLifecycleEmailsEnabled(),
        rewritesUsed: session.rewritesUsed || 0,
    };
}

export async function captureEmail(session, email) {
    if (!isValidEmail(email)) return { error: 'A valid email is required' };
    const set = { email: email.trim().toLowerCase(), purgeable: false };
    if (statusRank(session.status) < statusRank('email_captured') && statusRank(session.status) >= statusRank('completed')) {
        set.status = 'email_captured';
    }
    const updated = await FunnelSession.findByIdAndUpdate(
        session._id,
        { $set: set, $push: { steps: { $each: [stepEntry('email_captured')], $slice: -MAX_STEPS } } },
        { new: true, runValidators: true }
    ).lean();
    return { session: updated };
}

const utcDay = (now = new Date()) => now.toISOString().slice(0, 10);

/** Atomically takes one unit of a daily quota. Returns false when the limit is reached. */
export async function claimDailyQuota(key, limit, now = new Date()) {
    const day = utcDay(now);
    const expireAt = new Date(`${day}T00:00:00.000Z`);
    expireAt.setUTCDate(expireAt.getUTCDate() + 2);
    try {
        const doc = await RewriteUsage.findOneAndUpdate(
            { key, day, count: { $lt: limit } },
            { $inc: { count: 1 }, $setOnInsert: { expireAt } },
            { upsert: true, new: true }
        );
        return Boolean(doc);
    } catch (error) {
        if (error?.code === 11000) return false;
        throw error;
    }
}

export async function releaseDailyQuota(key, now = new Date()) {
    await RewriteUsage.updateOne({ key, day: utcDay(now), count: { $gt: 0 } }, { $inc: { count: -1 } });
}

export async function claimSessionRewrite(sessionId, perSession) {
    const doc = await FunnelSession.findOneAndUpdate(
        { _id: sessionId, rewritesUsed: { $lt: perSession } },
        { $inc: { rewritesUsed: 1 } },
        { new: true }
    ).lean();
    return Boolean(doc);
}

export async function releaseSessionRewrite(sessionId) {
    await FunnelSession.updateOne({ _id: sessionId, rewritesUsed: { $gt: 0 } }, { $inc: { rewritesUsed: -1 } });
}

/**
 * Links a quiz session to a user (plan §7). Idempotent and first-wins: a user
 * keeps the first session linked to them, and a session linked to one user is
 * never moved to another. Returns { linked, reason? }.
 */
export async function linkFunnelSession(userId, sessionId) {
    if (!userId || !isSessionId(sessionId)) return { linked: false, reason: 'invalid' };
    const session = await FunnelSession.findById(sessionId).lean();
    if (!session) return { linked: false, reason: 'not_found' };
    if (session.userId && String(session.userId) !== String(userId)) return { linked: false, reason: 'other_user' };

    const onboarding = { 'onboarding.linkedAt': new Date() };
    if (session.answers && isQuizComplete(session.answers)) onboarding['onboarding.answers'] = session.answers;
    if (session.segment) onboarding['onboarding.segment'] = session.segment;
    onboarding['onboarding.highIntent'] = Boolean(session.highIntent);
    if (session.recommendedPlan) onboarding['onboarding.recommendedPlan'] = session.recommendedPlan;

    const userUpdate = await User.updateOne(
        { _id: userId, $or: [{ funnelSessionId: { $exists: false } }, { funnelSessionId: null }] },
        { $set: { funnelSessionId: sessionId, ...onboarding } }
    );
    const user = await User.findById(userId).select('funnelSessionId attribution').lean();
    if (!user || user.funnelSessionId !== sessionId) return { linked: false, reason: 'already_linked' };

    const set = { userId, purgeable: false };
    if (statusRank(session.status) < statusRank('account_created')) set.status = 'account_created';
    await FunnelSession.updateOne(
        { _id: sessionId },
        { $set: set, ...(session.userId ? {} : { $push: { steps: { $each: [stepEntry('account_created')], $slice: -MAX_STEPS } } }) }
    );
    if (!user.attribution && session.attribution) {
        await User.updateOne({ _id: userId, attribution: { $exists: false } }, { $set: { attribution: session.attribution } });
    }
    return { linked: true, firstLink: userUpdate.modifiedCount === 1 };
}
