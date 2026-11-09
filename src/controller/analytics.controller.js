import mongoose from 'mongoose';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { User } from '../model/user.model.js';
import { Video } from '../model/video.model.js';
import { ContentStrategy, STRATEGY_STATUS, SLOT_STATUS } from '../model/content-strategy.model.js';
import { STRATEGY_LIMITS, SUBSCRIPTION_PLANS } from '../constants.js';
import { getOrCreateSubscription } from '../service/subscription.service.js';
import { buildOverview, buildVideoRows, loadAnalyticsVideos, RANGES } from '../service/analytics.service.js';
import { normalizeCreatorProfileInput, resolveCreatorProfile } from '../service/creator-profile.service.js';
import { generateStrategy, loadStrategyVideos } from '../service/content-strategy.service.js';
import { captureServerEvent } from '../lib/analytics.js';

const profileTimeZone = (user) => resolveCreatorProfile(user).timezone || 'UTC';

/** GET /analytics/overview?range=30d|90d|all */
export const getAnalyticsOverview = async (req, res, next) => {
    try {
        const range = Object.hasOwn(RANGES, req.query.range) ? req.query.range : '30d';
        const videos = await loadAnalyticsVideos(req.user._id);
        const overview = buildOverview(videos, { range, timeZone: profileTimeZone(req.user) });
        res.status(200).json(ApiResponse.success(200, 'Analytics overview', overview));
    } catch (error) {
        next(error);
    }
};

/** GET /analytics/videos */
export const getAnalyticsVideos = async (req, res, next) => {
    try {
        const videos = await loadAnalyticsVideos(req.user._id);
        res.status(200).json(ApiResponse.success(200, 'Analytics videos', { videos: buildVideoRows(videos) }));
    } catch (error) {
        next(error);
    }
};

/** GET /analytics/profile */
export const getCreatorProfile = async (req, res, next) => {
    try {
        res.status(200).json(ApiResponse.success(200, 'Creator profile', resolveCreatorProfile(req.user)));
    } catch (error) {
        next(error);
    }
};

/** PUT /analytics/profile */
export const updateCreatorProfile = async (req, res, next) => {
    try {
        const creatorProfile = normalizeCreatorProfileInput(req.body ?? {});
        const user = await User.findByIdAndUpdate(
            req.user._id,
            { $set: { creatorProfile } },
            { new: true }
        ).select('creatorProfile onboarding');
        res.status(200).json(ApiResponse.success(200, 'Profile saved', resolveCreatorProfile(user)));
    } catch (error) {
        next(error);
    }
};

// ─── Strategy (Premium and up) ──────────────────────────────────────────────

const STALE_GENERATION_MS = 3 * 60 * 1000;
const HISTORY_LIMIT = 10;
const generationsInFlight = new Set();

const startOfMonth = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const startOfNextMonth = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

/** Plan cap for this billing period. Failed generations never count. */
export const strategyUsage = async (userId) => {
    const subscription = await getOrCreateSubscription(userId);
    const plan = subscription?.plan ?? SUBSCRIPTION_PLANS.FREE;
    const limit = STRATEGY_LIMITS[plan] ?? 0;
    const paid = plan !== SUBSCRIPTION_PLANS.FREE;
    const periodStart = paid && subscription.currentPeriodStart ? subscription.currentPeriodStart : startOfMonth();
    const resetsOn = paid && subscription.currentPeriodEnd ? subscription.currentPeriodEnd : startOfNextMonth();
    const used = await ContentStrategy.countDocuments({ userId, status: STRATEGY_STATUS.READY, generatedAt: { $gte: periodStart } });
    return { plan, limit, used, remaining: Math.max(0, limit - used), resetsOn, locked: limit === 0 };
};

const idStr = (id) => (id ? String(id) : null);

/** Client shape, plus a lookup of every video the plan cites (title, thumbnail, score). */
const toStrategyResponse = async (doc, userId) => {
    if (!doc) return null;
    const s = typeof doc.toObject === 'function' ? doc.toObject() : doc;
    const evidence = (items) => (items ?? []).map((i) => ({ ...i, evidenceVideoIds: (i.evidenceVideoIds ?? []).map(idStr) }));
    const out = {
        id: idStr(s._id),
        status: s.status,
        generatedAt: s.generatedAt,
        confidence: s.confidence,
        inputSummary: s.inputSummary ?? null,
        diagnosis: s.diagnosis ? { ...s.diagnosis, strengths: evidence(s.diagnosis.strengths), weaknesses: evidence(s.diagnosis.weaknesses) } : null,
        pillars: (s.pillars ?? []).map((p) => ({ ...p, evidenceVideoIds: (p.evidenceVideoIds ?? []).map(idStr) })),
        formula: s.formula ?? null,
        schedule: s.schedule ? { ...s.schedule, slots: (s.schedule.slots ?? []).map((slot) => ({ ...slot, linkedVideoId: idStr(slot.linkedVideoId) })) } : null,
        experiments: s.experiments ?? [],
        nextMilestone: s.nextMilestone ?? null,
    };
    const ids = new Set([
        ...(out.diagnosis?.strengths ?? []).flatMap((i) => i.evidenceVideoIds),
        ...(out.diagnosis?.weaknesses ?? []).flatMap((i) => i.evidenceVideoIds),
        ...out.pillars.flatMap((p) => p.evidenceVideoIds),
        ...(out.schedule?.slots ?? []).map((slot) => slot.linkedVideoId).filter(Boolean),
    ]);
    const videos = ids.size
        ? await Video.find({ _id: { $in: [...ids] }, uploader_id: userId }).select('_id filename sourceTitle thumbnailUrl viralityScore actualViews').lean()
        : [];
    out.videos = Object.fromEntries(videos.map((v) => [String(v._id), {
        title: v.sourceTitle || v.filename,
        thumbnailUrl: v.thumbnailUrl ?? null,
        score: v.viralityScore ?? null,
        actualViews: v.actualViews ?? null,
    }]));
    return out;
};

/** GET /analytics/strategy: newest ready plan (or ?id=), whether one is generating, usage and history. */
export const getStrategy = async (req, res, next) => {
    try {
        const userId = req.user._id;
        const usage = await strategyUsage(userId);
        const filter = { userId, status: STRATEGY_STATUS.READY };
        if (req.query.id) {
            if (!mongoose.isValidObjectId(req.query.id)) throw new ApiError(404, 'Plan not found');
            filter._id = req.query.id;
        }
        const [doc, generating, history] = await Promise.all([
            ContentStrategy.findOne(filter).sort({ generatedAt: -1 }),
            ContentStrategy.exists({ userId, status: STRATEGY_STATUS.GENERATING, startedAt: { $gte: new Date(Date.now() - STALE_GENERATION_MS) } }),
            ContentStrategy.find({ userId, status: STRATEGY_STATUS.READY }).sort({ generatedAt: -1 }).limit(HISTORY_LIMIT).select('_id generatedAt confidence').lean(),
        ]);
        if (req.query.id && !doc) throw new ApiError(404, 'Plan not found');
        res.status(200).json(ApiResponse.success(200, 'Strategy', {
            strategy: await toStrategyResponse(doc, userId),
            generating: Boolean(generating),
            usage,
            profile: resolveCreatorProfile(req.user),
            history: history.map((h) => ({ id: String(h._id), generatedAt: h.generatedAt, confidence: h.confidence })),
        }));
    } catch (error) {
        next(error);
    }
};

/** POST /analytics/strategy: write a new plan. Gated by plan, capped per period, one at a time per user. */
export const createStrategy = async (req, res, next) => {
    const userId = req.user._id;
    const key = String(userId);
    let claim = null;
    let locked = false;
    try {
        const usage = await strategyUsage(userId);
        if (usage.locked) {
            throw new ApiError(403, 'Content strategies are part of Premium and Pro.', { code: 'UPGRADE_REQUIRED' });
        }
        if (usage.remaining <= 0) {
            throw new ApiError(429, `You have used all ${usage.limit} plans for this billing period.`, { code: 'STRATEGY_LIMIT', resetsOn: usage.resetsOn });
        }
        const profile = resolveCreatorProfile(req.user);
        if (!profile.complete) {
            throw new ApiError(400, 'Add your niche, platforms and posting rhythm first.', { code: 'PROFILE_INCOMPLETE' });
        }
        if (generationsInFlight.has(key)) {
            throw new ApiError(409, 'Your plan is already being written. Give it a minute.');
        }
        generationsInFlight.add(key);
        locked = true;

        // Release a claim left by a crashed instance, then claim (unique partial index: one per user).
        await ContentStrategy.updateMany(
            { userId, status: STRATEGY_STATUS.GENERATING, startedAt: { $lt: new Date(Date.now() - STALE_GENERATION_MS) } },
            { $set: { status: STRATEGY_STATUS.FAILED, error: 'stale' } }
        );
        const [videos, allVideos] = await Promise.all([loadStrategyVideos(userId), loadAnalyticsVideos(userId)]);
        if (!videos.length) {
            throw new ApiError(400, 'Analyze at least one video first. The plan is built from your own videos.', { code: 'NO_VIDEOS' });
        }
        try {
            claim = await ContentStrategy.create({ userId, status: STRATEGY_STATUS.GENERATING, startedAt: new Date() });
        } catch (error) {
            if (error?.code === 11000) throw new ApiError(409, 'Your plan is already being written. Give it a minute.');
            throw error;
        }

        const fields = await generateStrategy({ userId: key, profile, videos, allVideos });
        Object.assign(claim, fields, { status: STRATEGY_STATUS.READY, generatedAt: new Date(), error: null });
        await claim.save();
        captureServerEvent(key, 'strategy_generated', { confidence: fields.confidence, slots: fields.schedule.slots.length, plan: usage.plan });

        res.status(201).json(ApiResponse.success(201, 'Your plan is ready', {
            strategy: await toStrategyResponse(claim, userId),
            usage: await strategyUsage(userId),
        }));
    } catch (error) {
        if (claim && claim.status === STRATEGY_STATUS.GENERATING) {
            await ContentStrategy.updateOne(
                { _id: claim._id },
                { $set: { status: STRATEGY_STATUS.FAILED, error: String(error?.message ?? error).slice(0, 500) } }
            ).catch(() => {});
        }
        if (!(error instanceof ApiError)) {
            console.error(`[Strategy] Generation failed for user ${key}:`, error?.message);
            return next(new ApiError(502, 'We could not write your plan right now. Try again in a moment. This did not use up a plan.'));
        }
        next(error);
    } finally {
        if (locked) generationsInFlight.delete(key);
    }
};

/** PATCH /analytics/strategy/:id/slots/:slotId { status?, linkedVideoId? } */
export const updateStrategySlot = async (req, res, next) => {
    try {
        const userId = req.user._id;
        const { id, slotId } = req.params;
        const body = req.body ?? {};
        if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Plan not found');
        const set = {};
        if ('status' in body) {
            if (!SLOT_STATUS.includes(body.status)) throw new ApiError(400, 'Status must be planned, posted or skipped.');
            set['schedule.slots.$.status'] = body.status;
        }
        if ('linkedVideoId' in body) {
            const videoId = body.linkedVideoId || null;
            if (videoId && (!mongoose.isValidObjectId(videoId) || !(await Video.exists({ _id: videoId, uploader_id: userId })))) {
                throw new ApiError(400, 'Pick one of your analyzed videos.');
            }
            set['schedule.slots.$.linkedVideoId'] = videoId;
        }
        if (!Object.keys(set).length) throw new ApiError(400, 'Nothing to update.');
        const doc = await ContentStrategy.findOneAndUpdate(
            { _id: id, userId, status: STRATEGY_STATUS.READY, 'schedule.slots.id': String(slotId) },
            { $set: set },
            { new: true }
        );
        if (!doc) throw new ApiError(404, 'That slot was not found.');
        if (body.status === 'posted') captureServerEvent(String(userId), 'slot_marked_posted', { linked: Boolean(body.linkedVideoId) });
        res.status(200).json(ApiResponse.success(200, 'Slot updated', { strategy: await toStrategyResponse(doc, userId) }));
    } catch (error) {
        next(error);
    }
};
