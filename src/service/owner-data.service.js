/**
 * Read-only data for the owner console. Every query names its fields, so password hashes, refresh
 * tokens, reset tokens and verification tokens are never read. Nothing here writes user data.
 */
import mongoose from 'mongoose';
import { Video } from '../model/video.model.js';
import { User } from '../model/user.model.js';
import { Chat } from '../model/chat.model.js';
import { Subscription } from '../model/subscription.model.js';
import { PromoRedemption } from '../model/promo-redemption.model.js';
import { AiResponse } from '../model/ai-response.model.js';
import { OwnerAudit } from '../model/owner-security.model.js';
import { ApiError } from '../utils/ApiError.js';
import { ANALYSIS_STATUS } from '../constants.js';
import { displayViewBand, viewDrivers } from './view-prediction.service.js';
import { promoInfo } from './promo-state.js';

const USER_SAFE = '_id name email provider role isEmailVerified avatar lifetimeFreeVideosUsed creatorProfile onboarding attribution createdAt updatedAt';
const SUB_SAFE = 'userId plan status currentPeriodStart currentPeriodEnd usage paymentFailed paymentFailedAt trialUsedAt trialEndsAt promo stripeCustomerId stripeSubscriptionId createdAt';
const LIST_VIDEO = '_id uploader_id filename sourceTitle sourceUrl thumbnailUrl duration fileSize createdAt analysisStatus viralityScore '
    + 'predictedViewsLow predictedViewsExpected predictedViewsHigh viewPredictionMethod viewLearning creatorFollowers creatorPlatform '
    + 'actualViews lastError analysis.feature analysis.score scenes.startTime scenes.endTime scenes.audioSummary scenes.visualDescription '
    + 'scenes.primaryAction scriptSuggestions.generatedAt';

const MAX_PAGE_SIZE = 50;
const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toId = (value) => (mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(String(value)) : null);
const page = (q) => {
    const size = Math.min(MAX_PAGE_SIZE, Math.max(5, Number(q.pageSize) || 25));
    const index = Math.max(0, (Number(q.page) || 1) - 1);
    return { size, skip: index * size, page: index + 1 };
};
const dateOrNull = (v) => {
    const d = v ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
};

const plansFor = async (userIds) => {
    const subs = await Subscription.find({ userId: { $in: userIds } }).select('userId plan status promo stripeSubscriptionId').lean();
    return new Map(subs.map((s) => [String(s.userId), s]));
};

const chatCountsFor = async (videoIds) => {
    const rows = await Chat.aggregate([
        { $match: { videoId: { $in: videoIds } } },
        { $project: { videoId: 1, n: { $size: { $ifNull: ['$messages', []] } }, user: { $size: { $filter: { input: { $ifNull: ['$messages', []] }, cond: '$$this.isUser' } } } } },
    ]);
    return new Map(rows.map((r) => [String(r.videoId), { messages: r.n, fromUser: r.user }]));
};

const videoRow = (v, users, plans, chats) => {
    const user = users.get(String(v.uploader_id));
    const sub = plans.get(String(v.uploader_id));
    const band = displayViewBand(v);
    return {
        id: String(v._id),
        title: v.sourceTitle || v.filename || 'Untitled',
        filename: v.filename ?? null,
        thumbnailUrl: v.thumbnailUrl ?? null,
        createdAt: v.createdAt,
        duration: v.duration ?? null,
        status: v.analysisStatus,
        error: v.lastError ?? null,
        score: v.viralityScore ?? null,
        predicted: band?.expected != null ? { low: band.low, expected: band.expected, high: band.high } : null,
        actualViews: v.actualViews ?? null,
        followers: v.creatorFollowers ?? null,
        platform: v.creatorPlatform ?? null,
        scripts: Boolean(v.scriptSuggestions?.generatedAt),
        chat: chats.get(String(v._id)) ?? { messages: 0, fromUser: 0 },
        user: user ? { id: String(user._id), email: user.email, name: user.name } : { id: String(v.uploader_id ?? ''), email: null, name: null },
        plan: sub?.plan ?? 'free',
        promo: sub?.promo?.code ?? null,
    };
};

const hydrateRows = async (videos) => {
    const userIds = [...new Set(videos.map((v) => String(v.uploader_id)).filter(Boolean))].map(toId).filter(Boolean);
    const [users, plans, chats] = await Promise.all([
        User.find({ _id: { $in: userIds } }).select('_id name email').lean().then((list) => new Map(list.map((u) => [String(u._id), u]))),
        plansFor(userIds),
        chatCountsFor(videos.map((v) => v._id)),
    ]);
    return videos.map((v) => videoRow(v, users, plans, chats));
};

/** Videos, newest first, with filters: q (title, file name or user email), status, plan, userId, from, to, minScore, maxScore. */
export const listVideos = async (q = {}) => {
    const filter = {};
    if (q.status && Object.values(ANALYSIS_STATUS).includes(q.status)) filter.analysisStatus = q.status;
    const from = dateOrNull(q.from);
    const to = dateOrNull(q.to);
    if (from || to) filter.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
    const min = Number(q.minScore);
    const max = Number(q.maxScore);
    if (Number.isFinite(min) || Number.isFinite(max)) filter.viralityScore = { ...(Number.isFinite(min) ? { $gte: min } : {}), ...(Number.isFinite(max) ? { $lte: max } : {}) };

    let userFilter = null;
    if (q.userId) {
        const id = toId(q.userId);
        if (!id) return { rows: [], total: 0, page: 1, pageSize: 25 };
        userFilter = [id];
    }
    if (q.plan) {
        const subs = await Subscription.find({ plan: String(q.plan) }).select('userId').lean();
        const ids = subs.map((s) => s.userId);
        if (q.plan === 'free') {
            const paid = await Subscription.find({ plan: { $ne: 'free' } }).select('userId').lean();
            filter.uploader_id = { $nin: paid.map((s) => s.userId) };
        } else {
            userFilter = userFilter ? userFilter.filter((id) => ids.some((x) => String(x) === String(id))) : ids;
        }
    }
    const text = String(q.q ?? '').trim().slice(0, 100);
    if (text) {
        const rx = new RegExp(escapeRegex(text), 'i');
        const matchingUsers = await User.find({ $or: [{ email: rx }, { name: rx }] }).select('_id').limit(500).lean();
        filter.$or = [{ filename: rx }, { sourceTitle: rx }, { uploader_id: { $in: matchingUsers.map((u) => u._id) } }];
    }
    if (userFilter) filter.uploader_id = { ...(filter.uploader_id ?? {}), $in: userFilter };

    const { size, skip, page: current } = page(q);
    const [videos, total] = await Promise.all([
        Video.find(filter).select(LIST_VIDEO).sort({ createdAt: -1 }).skip(skip).limit(size).lean(),
        Video.countDocuments(filter),
    ]);
    return { rows: await hydrateRows(videos), total, page: current, pageSize: size };
};

/** Everything about one video: the input, every output, the coach conversation and the prediction. */
export const getVideoDetail = async (videoId) => {
    const id = toId(videoId);
    if (!id) throw new ApiError(404, 'Video not found');
    const video = await Video.findById(id).lean();
    if (!video) throw new ApiError(404, 'Video not found');

    const userId = video.uploader_id ? String(video.uploader_id) : null;
    const [user, subscription, chat, aiCalls] = await Promise.all([
        userId ? User.findById(userId).select(USER_SAFE).lean() : null,
        userId ? Subscription.findOne({ userId }).select(SUB_SAFE).lean() : null,
        Chat.findOne({ videoId: id }).lean(),
        AiResponse.countDocuments({ videoId: String(id) }),
    ]);

    // Drop internal bulk the console has no use for.
    for (const key of Object.keys(video)) if (/embedding/i.test(key)) delete video[key];

    const band = displayViewBand(video);
    return {
        video: {
            ...video,
            id: String(video._id),
        },
        user,
        subscription: subscription ? { ...subscription, promo: promoInfo(subscription) } : null,
        chat: {
            messages: (chat?.messages ?? []).map((m) => ({
                isUser: Boolean(m.isUser), text: m.text ?? '', createdAt: m.createdAt ?? null,
                coverage: m.coverage ?? null, fixes: m.fixes ?? [], scriptRewrites: m.scriptRewrites ?? [], feedbackRefs: m.feedbackRefs ?? [],
            })),
        },
        prediction: {
            shown: band,
            method: video.viewPredictionMethod ?? null,
            comparables: video.viewPredictionComparables ?? 0,
            base: video.viewBase ?? null,
            learning: video.viewLearning ?? null,
            drivers: viewDrivers(video),
            followers: video.creatorFollowers ?? null,
            platform: video.creatorPlatform ?? null,
            actualViews: video.actualViews ?? null,
            snapshots: video.performanceSnapshots ?? [],
        },
        aiCalls,
    };
};

/** Users, newest first; q matches email or name. */
export const listUsers = async (q = {}) => {
    const filter = {};
    const text = String(q.q ?? '').trim().slice(0, 100);
    if (text) {
        const rx = new RegExp(escapeRegex(text), 'i');
        filter.$or = [{ email: rx }, { name: rx }];
    }
    const { size, skip, page: current } = page(q);
    const [users, total] = await Promise.all([
        User.find(filter).select('_id name email provider isEmailVerified createdAt').sort({ createdAt: -1 }).skip(skip).limit(size).lean(),
        User.countDocuments(filter),
    ]);
    const ids = users.map((u) => u._id);
    const [plans, counts] = await Promise.all([
        plansFor(ids),
        Video.aggregate([
            { $match: { uploader_id: { $in: ids } } },
            { $group: { _id: '$uploader_id', videos: { $sum: 1 }, last: { $max: '$createdAt' } } },
        ]).then((rows) => new Map(rows.map((r) => [String(r._id), r]))),
    ]);
    return {
        rows: users.map((u) => {
            const sub = plans.get(String(u._id));
            const c = counts.get(String(u._id));
            return {
                id: String(u._id), name: u.name ?? null, email: u.email, provider: u.provider ?? null, verified: Boolean(u.isEmailVerified),
                createdAt: u.createdAt, plan: sub?.plan ?? 'free', promo: sub?.promo?.code ?? null, billed: Boolean(sub?.stripeSubscriptionId),
                videos: c?.videos ?? 0, lastVideoAt: c?.last ?? null,
            };
        }),
        total, page: current, pageSize: size,
    };
};

export const getUserDetail = async (userId) => {
    const id = toId(userId);
    if (!id) throw new ApiError(404, 'User not found');
    const user = await User.findById(id).select(USER_SAFE).lean();
    if (!user) throw new ApiError(404, 'User not found');
    const [subscription, promos, videos] = await Promise.all([
        Subscription.findOne({ userId: id }).select(SUB_SAFE).lean(),
        PromoRedemption.find({ userId: id }).select('code plan grantedAt endsAt').sort({ grantedAt: -1 }).lean(),
        listVideos({ userId: String(id), pageSize: 50 }),
    ]);
    return { user, subscription: subscription ? { ...subscription, promo: promoInfo(subscription) } : null, promos, videos };
};

export const overview = async () => {
    const day = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [users, usersWeek, videos, videosDay, failedWeek, processing, reported, plans, promos] = await Promise.all([
        User.countDocuments({}),
        User.countDocuments({ createdAt: { $gte: week } }),
        Video.countDocuments({}),
        Video.countDocuments({ createdAt: { $gte: day } }),
        Video.countDocuments({ analysisStatus: ANALYSIS_STATUS.FAILED, createdAt: { $gte: week } }),
        Video.countDocuments({ analysisStatus: { $in: [ANALYSIS_STATUS.PENDING, ANALYSIS_STATUS.QUEUED, ANALYSIS_STATUS.PROCESSING] } }),
        Video.countDocuments({ actualViews: { $gte: 0 } }),
        Subscription.aggregate([{ $group: { _id: '$plan', n: { $sum: 1 } } }]),
        PromoRedemption.aggregate([{ $group: { _id: '$code', n: { $sum: 1 } } }]),
    ]);
    return {
        users, usersWeek, videos, videosDay, failedWeek, processing, reported,
        plans: Object.fromEntries(plans.map((p) => [p._id ?? 'free', p.n])),
        promos: Object.fromEntries(promos.map((p) => [p._id, p.n])),
    };
};

export const auditLog = async ({ limit = 200 } = {}) =>
    OwnerAudit.find().sort({ createdAt: -1 }).limit(Math.min(500, Math.max(1, Number(limit) || 200))).lean();
