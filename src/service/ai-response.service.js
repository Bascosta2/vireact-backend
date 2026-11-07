/**
 * Admin review of stored AI responses (model AiResponse, written by lib/ai-tracking.js).
 */
import { AiResponse, AI_RESPONSE_RETENTION_DAYS } from '../model/ai-response.model.js';

export const MAX_LIST_LIMIT = 100;

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const parseDate = (value) => {
    if (!value) return null;
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? undefined : date;
};
const short = (value, max = 120) => String(value).trim().slice(0, max);

/**
 * Build a Mongo filter from admin query params. Pure, so it is tested directly.
 * Params: feature, label, provider, model, status (ok|error), validation (passed|failed|none),
 * rating (good|bad|unreviewed), userId, videoId, traceId, q (text in the output preview), from, to (dates)
 * or hours (look-back window).
 * @returns {{ filter: object } | { error: string }}
 */
export const buildAiResponseFilter = (query = {}, now = Date.now()) => {
    const filter = {};
    for (const key of ['feature', 'label', 'provider', 'model', 'userId', 'videoId', 'traceId']) {
        if (query[key]) filter[key] = short(query[key]);
    }
    if (query.status) {
        if (!['ok', 'error'].includes(query.status)) return { error: 'invalid status' };
        filter.isError = query.status === 'error';
    }
    if (query.validation) {
        if (!['passed', 'failed', 'none'].includes(query.validation)) return { error: 'invalid validation' };
        filter['validation.status'] = query.validation === 'none' ? null : query.validation;
    }
    if (query.rating) {
        if (!['good', 'bad', 'unreviewed'].includes(query.rating)) return { error: 'invalid rating' };
        filter['review.rating'] = query.rating === 'unreviewed' ? null : query.rating;
    }
    if (query.q) filter.outputPreview = { $regex: escapeRegex(short(query.q, 200)), $options: 'i' };

    const from = parseDate(query.from);
    const to = parseDate(query.to);
    if (from === undefined || to === undefined) return { error: 'invalid date' };
    const hours = Number(query.hours);
    const createdAt = {};
    if (from) createdAt.$gte = from;
    else if (Number.isFinite(hours) && hours > 0) createdAt.$gte = new Date(now - Math.min(hours, 24 * 365) * 3600 * 1000);
    if (to) createdAt.$lte = to;
    if (Object.keys(createdAt).length) filter.createdAt = createdAt;
    return { filter };
};

/** List view: everything except the full prompt and output. */
const LIST_PROJECTION = { input: 0, output: 0 };

export const listAiResponses = async ({ filter, limit = 50, skip = 0 }) => {
    const safeLimit = Math.min(MAX_LIST_LIMIT, Math.max(1, Number(limit) || 50));
    const safeSkip = Math.max(0, Number(skip) || 0);
    const [items, total] = await Promise.all([
        AiResponse.find(filter, LIST_PROJECTION).sort({ createdAt: -1 }).skip(safeSkip).limit(safeLimit).lean(),
        AiResponse.countDocuments(filter),
    ]);
    return { total, limit: safeLimit, skip: safeSkip, items };
};

/** One response in full, plus the other calls in the same trace (e.g. all calls for one video analysis). */
export const getAiResponse = async (id) => {
    const item = await AiResponse.findById(id).lean();
    if (!item) return null;
    const trace = item.traceId
        ? await AiResponse.find({ traceId: item.traceId }, { label: 1, attempt: 1, isError: 1, createdAt: 1, totalTokens: 1, costUsd: 1, latencyMs: 1, 'validation.status': 1 })
            .sort({ createdAt: 1 }).limit(100).lean()
        : [];
    return { item, trace };
};

/**
 * Totals for the window, grouped by feature + label + model: volume, errors, tokens, cost, latency,
 * our quality gate and admin ratings. Also returns the values seen, for the filter dropdowns.
 */
export const getAiResponseStats = async ({ since }) => {
    const match = { createdAt: { $gte: since } };
    const [groups, features, labels, models] = await Promise.all([
        AiResponse.aggregate([
            { $match: match },
            {
                $group: {
                    _id: { feature: '$feature', label: '$label', provider: '$provider', model: '$model' },
                    calls: { $sum: 1 },
                    errors: { $sum: { $cond: ['$isError', 1, 0] } },
                    inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
                    outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
                    reasoningTokens: { $sum: { $ifNull: ['$reasoningTokens', 0] } },
                    costUsd: { $sum: { $ifNull: ['$costUsd', 0] } },
                    pricedCalls: { $sum: { $cond: [{ $ne: ['$costUsd', null] }, 1, 0] } },
                    avgLatencyMs: { $avg: '$latencyMs' },
                    maxLatencyMs: { $max: '$latencyMs' },
                    validationChecked: { $sum: { $cond: [{ $ne: ['$validation.status', null] }, 1, 0] } },
                    validationFailed: { $sum: { $cond: [{ $eq: ['$validation.status', 'failed'] }, 1, 0] } },
                    ratedGood: { $sum: { $cond: [{ $eq: ['$review.rating', 'good'] }, 1, 0] } },
                    ratedBad: { $sum: { $cond: [{ $eq: ['$review.rating', 'bad'] }, 1, 0] } },
                },
            },
            { $sort: { calls: -1 } },
            { $limit: 200 },
        ]),
        AiResponse.distinct('feature', match),
        AiResponse.distinct('label', match),
        AiResponse.distinct('model', match),
    ]);
    const rows = groups.map((g) => ({
        ...g._id,
        ...g,
        _id: undefined,
        avgLatencyMs: g.avgLatencyMs == null ? null : Math.round(g.avgLatencyMs),
        costUsd: g.pricedCalls ? Number(g.costUsd.toFixed(4)) : null,
    }));
    const totals = rows.reduce((t, r) => ({
        calls: t.calls + r.calls,
        errors: t.errors + r.errors,
        inputTokens: t.inputTokens + r.inputTokens,
        outputTokens: t.outputTokens + r.outputTokens,
        costUsd: r.costUsd == null ? t.costUsd : Number((t.costUsd + r.costUsd).toFixed(4)),
        validationChecked: t.validationChecked + r.validationChecked,
        validationFailed: t.validationFailed + r.validationFailed,
        ratedGood: t.ratedGood + r.ratedGood,
        ratedBad: t.ratedBad + r.ratedBad,
    }), { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, validationChecked: 0, validationFailed: 0, ratedGood: 0, ratedBad: 0 });
    return { totals, rows, facets: { features: features.sort(), labels: labels.sort(), models: models.sort() } };
};

/**
 * Save an admin rating/note. A reviewed response is kept for good; clearing the review puts it back
 * on the normal retention clock.
 * @returns the updated review, or null when the response doesn't exist
 */
export const reviewAiResponse = async (id, { rating = null, note = '' } = {}) => {
    const cleanNote = typeof note === 'string' ? note.trim().slice(0, 2000) : '';
    const reviewed = Boolean(rating) || Boolean(cleanNote);
    const item = await AiResponse.findById(id, { createdAt: 1 }).lean();
    if (!item) return null;
    const update = {
        $set: { 'review.rating': rating || null, 'review.note': cleanNote, 'review.reviewedAt': reviewed ? new Date() : null },
    };
    if (reviewed) update.$unset = { expiresAt: '' };
    else update.$set.expiresAt = new Date(new Date(item.createdAt).getTime() + AI_RESPONSE_RETENTION_DAYS * 24 * 3600 * 1000);
    await AiResponse.updateOne({ _id: id }, update);
    return { rating: rating || null, note: cleanNote, kept: reviewed };
};
