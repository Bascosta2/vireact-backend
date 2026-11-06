import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.js';
import { getAnalysisStats } from '../service/ops-monitoring.service.js';
import { uploadAdminVideo, uploadAdminCreatorVideo, uploadAdminKnowledge } from '../middleware/adminUpload.js';
import { postPairedVideo, postCreatorVideoUpload, postKnowledge } from '../controller/admin.controller.js';
import {
    listLibraryItemsAdmin,
    patchLibraryItemAdmin,
    createLibraryItemFromKb,
    searchKnowledgeBaseAdmin,
} from '../controller/admin-library.controller.js';

const adminRoutes = Router();

adminRoutes.use(adminAuth);

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

export default adminRoutes;
