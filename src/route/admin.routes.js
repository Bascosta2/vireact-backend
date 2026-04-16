import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth.js';
import { uploadAdminVideo, uploadAdminCreatorVideo, uploadAdminKnowledge } from '../middleware/adminUpload.js';
import { postPairedVideo, postCreatorVideoUpload, postKnowledge } from '../controller/admin.controller.js';

const adminRoutes = Router();

adminRoutes.use(adminAuth);

adminRoutes.get('/ping', (req, res) => {
    res.status(200).json({ ok: true });
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

export default adminRoutes;
