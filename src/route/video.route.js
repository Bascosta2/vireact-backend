import { Router } from 'express';
import {
    // getPresignedUploadUrl,
    confirmVideoUpload,
    getUserVideos,
    deleteVideo,
    markAnalysisViewed,
    processVideoAnalysis,
    uploadVideoToTwelveLabs,
    uploadVideoUrlToTwelveLabs
} from '../controller/video.controller.js';
import { authenticateToken } from '../middleware/auth.js';
import { uploadSingle } from '../middleware/fileUpload.js';

const videoRoutes = Router();

// QStash webhook endpoint (no authentication - QStash signature verification handles security)
videoRoutes.post('/analyze', processVideoAnalysis);

// All other video routes require authentication
videoRoutes.use(authenticateToken);

// Get presigned URL for upload
// videoRoutes.post('/presigned-url', getPresignedUploadUrl);

// Confirm video upload
videoRoutes.patch('/:videoId/confirm', confirmVideoUpload);

// Get user's videos
videoRoutes.get('/', getUserVideos);

// Delete video
videoRoutes.delete('/:videoId', deleteVideo);

// Mark analysis as viewed
videoRoutes.patch('/:videoId/mark-viewed', markAnalysisViewed);

// Upload video file to TwelveLabs
videoRoutes.post('/upload-file', uploadSingle, uploadVideoToTwelveLabs);

// Upload video URL to TwelveLabs
videoRoutes.post('/upload-url', uploadVideoUrlToTwelveLabs);

export default videoRoutes;

