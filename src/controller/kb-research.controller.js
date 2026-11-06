import mongoose from 'mongoose';
import { KbCandidate } from '../model/kb-candidate.model.js';
import { KbResearchRun } from '../model/kb-research-run.model.js';
import { approveCandidate, rejectCandidate, RESEARCH_TOPICS } from '../service/kb-research/research.service.js';
import { startResearchRun, isResearchRunning } from '../service/kb-research/runner.js';

const isId = (id) => mongoose.isValidObjectId(id);

/** POST /admin/kb-research/run  { topics?: string[], maxPages?: number } */
export const postResearchRun = async (req, res, next) => {
    try {
        const { topics, maxPages } = req.body || {};
        if (topics !== undefined && (!Array.isArray(topics) || topics.some((t) => !RESEARCH_TOPICS.includes(t)))) {
            return res.status(400).json({ ok: false, error: `topics must be a list from: ${RESEARCH_TOPICS.join(', ')}` });
        }
        const result = await startResearchRun({ topics, maxPages, trigger: 'admin' });
        if (!result.started) return res.status(409).json({ ok: false, error: result.error || 'a research run is already in progress', runId: result.runId });
        res.status(202).json({ ok: true, ...result });
    } catch (error) {
        next(error);
    }
};

/** GET /admin/kb-research/runs */
export const getResearchRuns = async (req, res, next) => {
    try {
        const runs = await KbResearchRun.find().sort({ startedAt: -1 }).limit(20).lean();
        res.status(200).json({ ok: true, running: isResearchRunning(), runs });
    } catch (error) {
        next(error);
    }
};

/** GET /admin/kb-candidates?status=pending&topic=hook&runId=...&limit=50&skip=0 */
export const listCandidates = async (req, res, next) => {
    try {
        const filter = {};
        const status = String(req.query.status || 'pending');
        if (!['pending', 'approved', 'rejected', 'all'].includes(status)) return res.status(400).json({ ok: false, error: 'invalid status' });
        if (status !== 'all') filter.status = status;
        if (req.query.topic) {
            if (!RESEARCH_TOPICS.includes(String(req.query.topic))) return res.status(400).json({ ok: false, error: 'invalid topic' });
            filter.topic = String(req.query.topic);
        }
        if (req.query.runId) filter.runId = String(req.query.runId);
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
        const skip = Math.max(0, Number(req.query.skip) || 0);
        const [items, total] = await Promise.all([
            KbCandidate.find(filter).sort({ confidence: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
            KbCandidate.countDocuments(filter),
        ]);
        res.status(200).json({ ok: true, total, items });
    } catch (error) {
        next(error);
    }
};

/** POST /admin/kb-candidates/:id/approve  { claim?, evidence?, example?, appliesTo?, topic?, specificity?, layer? } */
export const postApproveCandidate = async (req, res, next) => {
    try {
        if (!isId(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid id' });
        const result = await approveCandidate(req.params.id, req.body || {});
        if (!result.ok) return res.status(result.reason === 'not_found' ? 404 : 400).json(result);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};

/** POST /admin/kb-candidates/approve-batch  { ids: string[] }  (max 100, no edits) */
export const postApproveBatch = async (req, res, next) => {
    try {
        const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(String))] : [];
        if (!ids.length || ids.length > 100 || !ids.every(isId)) {
            return res.status(400).json({ ok: false, error: 'ids must be 1 to 100 valid ids' });
        }
        const results = [];
        for (const id of ids) {
            try {
                results.push({ id, ...(await approveCandidate(id)) });
            } catch (error) {
                results.push({ id, ok: false, reason: error.message });
            }
        }
        res.status(200).json({ ok: true, approved: results.filter((r) => r.ok).length, results });
    } catch (error) {
        next(error);
    }
};

/** POST /admin/kb-candidates/:id/reject  { note? } */
export const postRejectCandidate = async (req, res, next) => {
    try {
        if (!isId(req.params.id)) return res.status(400).json({ ok: false, error: 'invalid id' });
        const result = await rejectCandidate(req.params.id, req.body?.note);
        if (!result.ok) return res.status(result.reason === 'not_found' ? 404 : 409).json(result);
        res.status(200).json(result);
    } catch (error) {
        next(error);
    }
};
