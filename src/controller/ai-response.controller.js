import mongoose from 'mongoose';
import {
    buildAiResponseFilter,
    listAiResponses,
    getAiResponse,
    getAiResponseStats,
    reviewAiResponse,
} from '../service/ai-response.service.js';

const isId = (id) => mongoose.isValidObjectId(id);

/**
 * GET /admin/ai-responses?feature&label&provider&model&status=ok|error&validation=passed|failed|none
 *   &rating=good|bad|unreviewed&userId&videoId&traceId&q&from&to&hours&limit=50&skip=0
 * Newest first, without the full prompt/output (see /:id).
 */
export const listAiResponsesAdmin = async (req, res, next) => {
    try {
        const built = buildAiResponseFilter(req.query);
        if (built.error) return res.status(400).json({ ok: false, error: built.error });
        const result = await listAiResponses({ filter: built.filter, limit: req.query.limit, skip: req.query.skip });
        res.status(200).json({ ok: true, ...result });
    } catch (error) { next(error); }
};

/** GET /admin/ai-responses/stats?hours=24 (max 90 days) */
export const getAiResponseStatsAdmin = async (req, res, next) => {
    try {
        const hours = Math.min(24 * 90, Math.max(1, Number(req.query.hours) || 24));
        const stats = await getAiResponseStats({ since: new Date(Date.now() - hours * 3600 * 1000) });
        res.status(200).json({ ok: true, hours, ...stats });
    } catch (error) { next(error); }
};

/** GET /admin/ai-responses/:id: full prompt and output, plus the rest of its trace. */
export const getAiResponseAdmin = async (req, res, next) => {
    try {
        if (!isId(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid id' });
        const found = await getAiResponse(req.params.id);
        if (!found) return res.status(404).json({ ok: false, error: 'not found' });
        res.status(200).json({ ok: true, ...found });
    } catch (error) { next(error); }
};

/** PATCH /admin/ai-responses/:id/review { rating: 'good'|'bad'|null, note?: string } */
export const reviewAiResponseAdmin = async (req, res, next) => {
    try {
        if (!isId(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid id' });
        const rating = req.body?.rating ?? null;
        if (rating !== null && !['good', 'bad'].includes(rating)) return res.status(400).json({ ok: false, error: 'invalid rating' });
        const review = await reviewAiResponse(req.params.id, { rating, note: req.body?.note });
        if (!review) return res.status(404).json({ ok: false, error: 'not found' });
        res.status(200).json({ ok: true, review });
    } catch (error) { next(error); }
};
