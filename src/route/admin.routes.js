import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.js';
import mongoose from 'mongoose';
import { getAnalysisStats } from '../service/ops-monitoring.service.js';
import { getErrorReport } from '../service/error-log.service.js';
import { runningJobIds } from '../queue/analysis-runtime.js';
import { analysisQueueStats } from '../controller/video.controller.js';
import { Video } from '../model/video.model.js';
import { ANALYSIS_STATUS } from '../constants.js';
import { RECOVERY } from '../service/analysis-recovery.service.js';
import { uploadAdminVideo, uploadAdminCreatorVideo, uploadAdminKnowledge } from '../middleware/adminUpload.js';
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
import { withAiContext, newTraceId } from '../lib/ai-tracking.js';

const adminRoutes = Router();

adminRoutes.use(adminAuth);

// Model calls made by admin work (ingest, research runs) are tracked as system work, one trace per request.
adminRoutes.use((req, res, next) => withAiContext({ feature: 'admin', distinctId: 'system:admin', traceId: newTraceId('admin') }, next));

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
        const [analysis, errors, stuckNow] = await Promise.all([
            getAnalysisStats({ since }),
            getErrorReport({ since, limit: 10 }),
            Video.countDocuments({ analysisStatus: ANALYSIS_STATUS.PROCESSING, analysisHeartbeatAt: { $lt: staleHeartbeat } }),
        ]);
        const mem = process.memoryUsage();
        const mb = (n) => Math.round(n / 1024 / 1024);
        const warnings = [];
        if (analysis.uploads >= 5 && analysis.failed / analysis.uploads > 0.2) warnings.push('More than 20% of analyses failed');
        if (stuckNow > 0) warnings.push(`${stuckNow} analyses look stuck (the sweeper retries them every 5 minutes)`);
        if (mb(mem.rss) > 900) warnings.push(`High memory use: ${mb(mem.rss)} MB`);
        if ((errors.bySource.server || 0) + (errors.bySource.process || 0) > 50) warnings.push('Many server errors');
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

export default adminRoutes;
