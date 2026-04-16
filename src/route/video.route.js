import { Router } from 'express';
import {
    getPresignedUploadUrl,
    confirmVideoUpload,
    getUserVideos,
    deleteVideo,
    markAnalysisViewed,
    reanalyzeVideo,
    uploadVideoToTwelveLabs,
    uploadVideoUrlToTwelveLabs,
    getVideoFeedback,
    getVideoStatus,
    getVideoById
} from '../controller/video.controller.js';
import { authenticateToken } from '../middleware/auth.js';
import { uploadSingle } from '../middleware/fileUpload.js';

const videoRoutes = Router();

// QStash webhook: registered in app.js with raw body + verifyQStashAndParseBody (before express.json)

// All other video routes require authentication
videoRoutes.use(authenticateToken);

// Get presigned URL for upload
videoRoutes.post('/presigned-url', getPresignedUploadUrl);

// Re-queue analysis for an existing indexed video (authenticated)
videoRoutes.post('/:videoId/reanalyze', reanalyzeVideo);

// Confirm video upload
videoRoutes.patch('/:videoId/confirm', confirmVideoUpload);

// Get user's videos
videoRoutes.get('/', getUserVideos);

// Delete video
videoRoutes.delete('/:videoId', deleteVideo);

// Mark analysis as viewed
videoRoutes.patch('/:videoId/mark-viewed', markAnalysisViewed);

// Get video status (upload + analysis) for progress polling
videoRoutes.get('/:videoId/status', getVideoStatus);

// Get timestamp-specific video feedback
videoRoutes.get('/:videoId/feedback', getVideoFeedback);

// Get single video with analysis DTO (slash-doc shape)
videoRoutes.get('/:videoId', getVideoById);

// Upload video file to TwelveLabs
videoRoutes.post('/upload-file', uploadSingle, uploadVideoToTwelveLabs);

// Upload video URL to TwelveLabs
videoRoutes.post('/upload-url', uploadVideoUrlToTwelveLabs);

export default videoRoutes;

