import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.js';
import { authenticateToken, requireAdminUser } from '../middleware/auth.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { overview, listUsers } from '../service/owner-data.service.js';
import { getPromoCode, loadPromoCodes } from '../config/promo-codes.js';
import { SKILLS, ANIMATION_STYLES } from '../service/editor/skills.js';
import { learningOverview } from '../service/learning/learning.service.js';
import { getResearchStats } from '../service/research-ingest/ingest.service.js';
import { LearningRun } from '../model/learning.model.js';
import mongoose from 'mongoose';
import { getAnalysisStats } from '../service/ops-monitoring.service.js';
import { getErrorReport } from '../service/error-log.service.js';
import { runningJobIds } from '../queue/analysis-runtime.js';
import { analysisQueueStats } from '../controller/video.controller.js';
import { Video } from '../model/video.model.js';
import { ANALYSIS_STATUS } from '../constants.js';
import { RECOVERY } from '../service/analysis-recovery.service.js';
import { countStalledMetaDeletions } from '../service/accounts/meta-data-deletion.js';
import { uploadAdminVideo, uploadAdminCreatorVideo, uploadAdminKnowledge, uploadAdminExample, uploadAdminSound } from '../middleware/adminUpload.js';
import { listExamples, createExample, reprofileExample, updateExample, deleteExample, listSounds, createSound, updateSound } from '../controller/admin-editor.controller.js';
import { postPairedVideo, postCreatorVideoUpload, postKnowledge } from '../controller/admin.controller.js';
import {
    listLibraryItemsAdmin,
    patchLibraryItemAdmin,
    createLibraryItemFromKb,
    searchKnowledgeBaseAdmin,
} from '../controller/admin-library.controller.js';
import {
    postResearchRun,
    getResearchRuns,
    listCandidates,
    postApproveCandidate,
    postApproveBatch,
    postRejectCandidate,
} from '../controller/kb-research.controller.js';
import {
    listAiResponsesAdmin,
    getAiResponseStatsAdmin,
    getAiResponseAdmin,
    reviewAiResponseAdmin,
} from '../controller/ai-response.controller.js';
import { getResearchStatsAdmin } from '../controller/research-ingest.controller.js';
import { withAiContext, newTraceId } from '../lib/ai-tracking.js';

import { learningReport, refitLearnedModel } from '../service/view-learning.service.js';

const adminRoutes = Router();

/**
 * Read-only data for the in-app admin dashboard. Signed-in users with role admin only (JWT, no x-admin-key).
 * Mounted at /api/v1/admin-app; GET endpoints only.
 */
export const adminAppRoutes = Router();
adminAppRoutes.use(authenticateToken, requireAdminUser);

const send = (res, data) => res.status(200).json(ApiResponse.success(200, 'OK', data));
const countList = (name) => String(process.env[name] || '').split(',').filter((e) => e.trim()).length;

adminAppRoutes.get('/overview', async (req, res, next) => {
    try {
        const [base, week, errors] = await Promise.all([
            overview(),
            getAnalysisStats({ since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }),
            getErrorReport({ limit: 1 }),
        ]);
        send(res, {
            users: base.users, usersWeek: base.usersWeek, plans: base.plans,
            analysesToday: base.videosDay, analyses7d: week.uploads, failed7d: week.failed, processing: base.processing,
            errors24h: errors.total,
            health: {
                database: mongoose.connection.readyState === 1 ? 'connected' : 'not connected',
                uptimeMinutes: Math.round(process.uptime() / 60),
                analysisJobs: runningJobIds().length,
                status: week.uploads >= 5 && week.failed / week.uploads > 0.2 ? 'attention' : 'healthy',
            },
        });
    } catch (error) {
        next(error);
    }
});

adminAppRoutes.get('/users', async (req, res, next) => {
    try {
        send(res, await listUsers(req.query));
    } catch (error) {
        next(error);
    }
});

adminAppRoutes.get('/promo-codes', async (req, res, next) => {
    try {
        const { promos } = await overview();
        // Codes come from the PROMO_CODES env var (never from source); admins only.
        send(res, [...loadPromoCodes()].map(([code, p]) => ({
            code, plan: p.plan, label: p.label, days: p.days, disabled: getPromoCode(code) === null,
            maxRedemptions: getPromoCode(code)?.maxRedemptions ?? null, redemptions: promos[code] ?? 0,
        })));
    } catch (error) {
        next(error);
    }
});

adminAppRoutes.get('/skills', (req, res) => {
    send(res, {
        skills: Object.values(SKILLS).filter((s) => !ANIMATION_STYLES[s.id]).map((s) => ({ id: s.id, name: s.name, version: s.version })),
        animationStyles: Object.entries(ANIMATION_STYLES).map(([id, s]) => ({ id, name: s.name, bestFor: s.bestFor, accent: s.accent })),
        betaAllowLists: { editor: countList('EDITOR_BETA_EMAILS'), accounts: countList('ACCOUNTS_BETA_EMAILS') },
    });
});

adminAppRoutes.get('/model-health', async (req, res, next) => {
    try {
        const [learning, research, latestRun] = await Promise.all([
            learningOverview(),
            getResearchStats(),
            LearningRun.findOne({}).sort({ startedAt: -1 }).select('kind startedAt finishedAt ok recordsUsed').lean(),
        ]);
        send(res, {
            latestRun, model: learning.model ? { version: learning.model.version, status: learning.model.status, trainedAt: learning.model.trainedAt, n: learning.model.n } : null,
            learningEnabled: learning.config.enabled, research,
        });
    } catch (error) {
        next(error);
    }
});

adminRoutes.use(adminAuth);

// Model calls made by admin work (ingest, research runs) are tracked as system work, one trace per request.
adminRoutes.use((req, res, next) => withAiContext({ feature: 'admin', distinctId: 'system:admin', traceId: newTraceId('admin') }, next));

// Views learning loop: the model in use and how its accuracy moved over the last fits. ?limit=20 &refit=1
adminRoutes.get('/view-learning', async (req, res, next) => {
    try {
        if (req.query.refit === '1') await refitLearnedModel();
        res.status(200).json({ ok: true, ...(await learningReport({ limit: Number(req.query.limit) || 20 })) });
    } catch (error) {
        next(error);
    }
});

adminRoutes.get('/ping', (req, res) => {
    res.status(200).json({ ok: true });
});

// Uploads, completions and failures for the last N hours (default 24, max 30 days).
adminRoutes.get('/analysis-stats', async (req, res, next) => {
    try {
        const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours) || 24));
        const stats = await getAnalysisStats({ since: new Date(Date.now() - hours * 60 * 60 * 1000) });
        res.status(200).json({ ok: true, hours, ...stats });
    } catch (error) {
        next(error);
    }
});

const sinceHours = (req, fallback = 24) => new Date(Date.now() - Math.min(24 * 30, Math.max(1, Number(req.query.hours) || fallback)) * 60 * 60 * 1000);

// Safety net: errors caught on the server and in users' browsers, grouped by kind, most frequent first.
// ?hours=24 (max 720) &source=server|client|upload|analysis|recovery|process &limit=50
adminRoutes.get('/errors', async (req, res, next) => {
    try {
        const source = req.query.source ? String(req.query.source) : undefined;
        res.status(200).json({ ok: true, ...(await getErrorReport({ since: sinceHours(req), source, limit: Number(req.query.limit) || 50 })) });
    } catch (error) {
        next(error);
    }
});

// One-look health check: this instance, the analysis pipeline, and errors in the last N hours.
adminRoutes.get('/health-report', async (req, res, next) => {
    try {
        const since = sinceHours(req);
        const staleHeartbeat = new Date(Date.now() - RECOVERY.staleHeartbeatMs);
        const [analysis, errors, stuckNow, stalledMetaDeletions] = await Promise.all([
            getAnalysisStats({ since }),
            getErrorReport({ since, limit: 10 }),
            Video.countDocuments({ analysisStatus: ANALYSIS_STATUS.PROCESSING, analysisHeartbeatAt: { $lt: staleHeartbeat } }),
            countStalledMetaDeletions(),
        ]);
        const mem = process.memoryUsage();
        const mb = (n) => Math.round(n / 1024 / 1024);
        const warnings = [];
        if (analysis.uploads >= 5 && analysis.failed / analysis.uploads > 0.2) warnings.push('More than 20% of analyses failed');
        if (stuckNow > 0) warnings.push(`${stuckNow} analyses look stuck (the sweeper retries them every 5 minutes)`);
        if (mb(mem.rss) > 900) warnings.push(`High memory use: ${mb(mem.rss)} MB`);
        if ((errors.bySource.server || 0) + (errors.bySource.process || 0) > 50) warnings.push('Many server errors');
        if (stalledMetaDeletions > 0) warnings.push(`${stalledMetaDeletions} Meta data-deletion requests still pending after 7 days`);
        res.status(200).json({
            ok: true,
            status: warnings.length ? 'attention' : 'healthy',
            warnings,
            instance: {
                uptimeMinutes: Math.round(process.uptime() / 60),
                memoryMb: { rss: mb(mem.rss), heapUsed: mb(mem.heapUsed) },
                database: mongoose.connection.readyState === 1 ? 'connected' : 'not connected',
                analysisJobs: { running: runningJobIds().length, ...analysisQueueStats() },
            },
            analysis,
            metaDeletions: { pendingOver7Days: stalledMetaDeletions },
            errors: { total: errors.total, bySource: errors.bySource, top: errors.top.map(({ stack, ...e }) => e) },
        });
    } catch (error) {
        next(error);
    }
});

adminRoutes.post(
    '/ingest/paired-video',
    (req, res, next) => {
        uploadAdminVideo(req, res, (err) => {
            if (err) return next(err);
            next();
        });
    },
    postPairedVideo
);

adminRoutes.post(
    '/creator-videos/upload',
    (req, res, next) => {
        uploadAdminCreatorVideo(req, res, (err) => {
            if (err) return next(err);
            next();
        });
    },
    postCreatorVideoUpload
);

adminRoutes.post(
    '/ingest/knowledge',
    (req, res, next) => {
        uploadAdminKnowledge(req, res, (err) => {
            if (err) return next(err);
            next();
        });
    },
    postKnowledge
);

// Library review (Phase 3). Works regardless of LIBRARY_ENABLED so items can be curated before launch.
adminRoutes.get('/library/items', listLibraryItemsAdmin);
adminRoutes.patch('/library/items/:id', patchLibraryItemAdmin);
adminRoutes.post('/library/items/from-kb/:kbId', createLibraryItemFromKb);
adminRoutes.get('/library/kb-search', searchKnowledgeBaseAdmin);

// Knowledge research agent: web lessons wait in a review queue until approved into the knowledge base.
adminRoutes.post('/kb-research/run', postResearchRun);
adminRoutes.get('/kb-research/runs', getResearchRuns);
adminRoutes.get('/kb-candidates', listCandidates);
adminRoutes.post('/kb-candidates/approve-batch', postApproveBatch);
adminRoutes.post('/kb-candidates/:id/approve', postApproveCandidate);
adminRoutes.post('/kb-candidates/:id/reject', postRejectCandidate);

// AI responses: every stored model call (prompt, output, tokens, cost, latency) for review.
adminRoutes.get('/ai-responses', listAiResponsesAdmin);
adminRoutes.get('/ai-responses/stats', getAiResponseStatsAdmin);
adminRoutes.get('/ai-responses/:id', getAiResponseAdmin);
adminRoutes.patch('/ai-responses/:id/review', reviewAiResponseAdmin);

// Autonomous research ingest: read-only stats (no approval actions; the pipeline has no human step).
adminRoutes.get('/research/stats', getResearchStatsAdmin);

// Editor tab training data (/admin/editor page)
const withUpload = (mw) => (req, res, next) => mw(req, res, (err) => (err ? next(err) : next()));
adminRoutes.get('/editor/examples', listExamples);
adminRoutes.post('/editor/examples', withUpload(uploadAdminExample), createExample);
adminRoutes.post('/editor/examples/:id/reprofile', reprofileExample);
adminRoutes.patch('/editor/examples/:id', updateExample);
adminRoutes.delete('/editor/examples/:id', deleteExample);
adminRoutes.get('/editor/sounds', listSounds);
adminRoutes.post('/editor/sounds', withUpload(uploadAdminSound), createSound);
adminRoutes.patch('/editor/sounds/:id', updateSound);

export default adminRoutes;
