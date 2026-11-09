import fs from 'fs';
import { createSemaphore } from '../utils/semaphore.js';
import { alertFailure } from './ops-monitoring.service.js';
import { normalizePlatform, normalizeFollowers } from './view-prediction.service.js';
import { Video } from '../model/video.model.js';
import { Chat } from '../model/chat.model.js';
// import { uploadFileUrl, deleteFile } from '../lib/aws_s3.js';
import { ApiError } from '../utils/ApiError.js';
import { UPLOAD_STATUS, ANALYSIS_STATUS, allowedFeaturesForPlan } from '../constants.js';
import { publishVideoAnalysisJob } from '../queue/video.queue.js';
import {
    claimVideoMonthlySlot,
    releaseVideoMonthlySlot,
    incrementLifetimeFreeVideoCount,
    assertLifetimeFreeTrialAvailable,
    getOrCreateSubscription,
} from './subscription.service.js';
import mongoose from 'mongoose';
import { AWS_S3_BUCKET_NAME, TWELVELABS_USER_INDEX } from '../config/index.js';
import TwelveLabsClient from '../lib/twelve-labs.js';
import {
    twelveLabsCreateDirectAsset,
    twelveLabsCreateUrlAsset,
} from '../lib/twelve-labs-ingest.helper.js';
import { isAllowedSocialVideoUrl } from '../lib/social-video-url.js';
import { downloadSocialVideoForIngest } from './social-video-fetch.service.js';
import { Readable } from 'stream';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * At most this many uploads are sent to Twelve Labs at once (TWELVELABS_MAX_CONCURRENT_UPLOADS, default 2).
 * The SDK keeps a copy of each file in memory while sending it, so this bounds memory under bursts.
 */
const twelveLabsUploadSlots = createSemaphore(process.env.TWELVELABS_MAX_CONCURRENT_UPLOADS || 2);

/**
 * Twelve Labs readiness limits. Indexing a short video usually takes 1-4 minutes but can take
 * longer under load, so the background job waits generously. (The old 2.5-minute cap, enforced
 * inside the upload HTTP request, failed uploads whose indexing ran long.)
 */
export const TWELVE_LABS_ASSET_MAX_WAIT_MS = 10 * 60 * 1000;
export const TWELVE_LABS_INDEX_MAX_WAIT_MS = 20 * 60 * 1000;

export const waitForAssetReady = async (
    assetId,
    initialStatus,
    { maxWaitMs = TWELVE_LABS_ASSET_MAX_WAIT_MS, pollMs = 5000 } = {}
) => {
    let assetStatus = initialStatus;
    const deadline = Date.now() + maxWaitMs;
    let attempts = 0;

    while (assetStatus !== 'ready') {
        if (assetStatus === 'failed') {
            throw new Error(`Twelve Labs could not process asset ${assetId} (status: failed).`);
        }
        if (Date.now() >= deadline) {
            throw new Error(`Asset ${assetId} did not become ready within ${Math.round(maxWaitMs / 60000)} minutes. Current status: ${assetStatus}`);
        }
        // Check immediately the first time when the status is unknown, then poll.
        if (attempts > 0 || assetStatus != null) await sleep(pollMs);
        attempts++;
        try {
            const assetCheck = await TwelveLabsClient.assets.retrieve(assetId);
            assetStatus = assetCheck?.status;
            console.log(`⏳ Asset status: ${assetStatus} (check ${attempts})`);
        } catch (error) {
            console.warn(`⚠️ Error checking asset status: ${error.message}`);
        }
    }
};

/**
 * Index an asset and wait until it is ready.
 *
 * @param {string} assetId
 * @param {string} indexId
 * @param {object} [options]
 * @param {string|null} [options.existingIndexedAssetId] Resume polling an indexing run that was already
 *   started (e.g. the job was retried after a restart) instead of indexing the asset a second time.
 * @param {(indexedAssetId: string) => Promise<void>|void} [options.onCreated] Called once the indexed
 *   asset id is known, so the caller can persist it before the (long) wait.
 * @param {number} [options.maxWaitMs]
 * @param {number} [options.pollMs]
 */
export const indexAssetWithRetry = async (
    assetId,
    indexId,
    {
        existingIndexedAssetId = null,
        onCreated,
        maxWaitMs = TWELVE_LABS_INDEX_MAX_WAIT_MS,
        pollMs = 10000,
    } = {}
) => {
    if (!indexId || String(indexId).trim() === '') {
        throw new Error('Twelve Labs index id is required for indexing.');
    }

    let indexedAssetId = existingIndexedAssetId;
    let indexedStatus = null;

    if (indexedAssetId) {
        console.log(`📚 Resuming indexing of asset ${assetId} (indexed asset ${indexedAssetId})...`);
    } else {
        console.log(`📚 Indexing asset ${assetId} into index ${indexId}...`);
        const indexResponse = await TwelveLabsClient.indexes.indexedAssets.create(
            indexId,
            {
                assetId,
                enableVideoStream: true
            }
        );

        indexedAssetId = indexResponse?.id;
        indexedStatus = indexResponse?.status;

        if (!indexedAssetId) {
            console.error('❌ Could not find indexed asset ID in response. Response structure:', indexResponse);
            throw new Error('Failed to get indexed asset ID from TwelveLabs response');
        }
        if (onCreated) await onCreated(indexedAssetId);
    }

    const deadline = Date.now() + maxWaitMs;
    let attempts = 0;

    while (indexedStatus !== 'ready') {
        if (indexedStatus === 'failed') {
            throw new Error(`Twelve Labs indexing failed for indexed asset ${indexedAssetId}.`);
        }
        if (Date.now() >= deadline) {
            throw new Error(`Indexed asset ${indexedAssetId} did not become ready within ${Math.round(maxWaitMs / 60000)} minutes. Current status: ${indexedStatus}`);
        }
        if (attempts > 0 || indexedStatus != null) await sleep(pollMs);
        attempts++;
        try {
            const indexedAsset = await TwelveLabsClient.indexes.indexedAssets.retrieve(
                indexId,
                indexedAssetId
            );
            indexedStatus = indexedAsset?.status;
            console.log(`⏳ Indexed asset status: ${indexedStatus} (check ${attempts})`);
        } catch (statusError) {
            console.warn(`⚠️ Error checking indexed asset status: ${statusError.message}`);
        }
    }

    return {
        indexedAssetId,
        indexedStatus
    };
};

/**
 * Make sure a video's Twelve Labs asset is indexed, waiting as long as needed (background job only).
 * Persists the indexed asset id as soon as indexing starts so a retried job resumes instead of
 * indexing twice. Sets `video.twelveLabsVideoId` and saves when ready.
 *
 * @param {import('mongoose').Document} video
 * @returns {Promise<string>} the indexed video id
 */
export const ensureVideoIndexed = async (video) => {
    if (video.twelveLabsVideoId) return video.twelveLabsVideoId;
    if (!video.twelveLabsAssetId) {
        throw new Error('TwelveLabs asset is missing. The upload did not reach Twelve Labs; please upload the video again.');
    }
    if (!TWELVELABS_USER_INDEX) {
        throw new Error('TWELVELABS_USER_INDEX is not configured.');
    }

    await waitForAssetReady(video.twelveLabsAssetId, null);

    const { indexedAssetId } = await indexAssetWithRetry(video.twelveLabsAssetId, TWELVELABS_USER_INDEX, {
        existingIndexedAssetId: video.twelveLabsPendingIndexId || null,
        onCreated: async (id) => {
            video.twelveLabsPendingIndexId = id;
            await video.save();
        },
    });

    video.twelveLabsVideoId = indexedAssetId;
    video.twelveLabsPendingIndexId = null;
    await video.save();
    console.log(`✅ Asset ${video.twelveLabsAssetId} indexed, video ID: ${indexedAssetId}`);
    return indexedAssetId;
};

/**
 * After the file reaches Twelve Labs, record the asset and queue the analysis job straight away.
 * Asset readiness and indexing run inside the background job, so the upload request returns in
 * seconds instead of holding a (mobile) connection open for minutes.
 *
 * @returns {Promise<void>} throws ApiError(502) when the job cannot be queued (video marked failed)
 */
const queueAnalysisForUploadedAsset = async (video, assetResponse, userId) => {
    const twelveLabsAssetId = assetResponse?.id || assetResponse?._id;
    if (!twelveLabsAssetId) {
        throw new Error('Failed to get asset ID from TwelveLabs response');
    }
    console.log(`✅ TwelveLabs upload successful, asset ID: ${twelveLabsAssetId}, status: ${assetResponse?.status || 'unknown'}`);

    video.twelveLabsAssetId = twelveLabsAssetId;
    video.uploadStatus = UPLOAD_STATUS.COMPLETED;
    // Webhook claims queued → processing, then indexes and analyzes.
    video.analysisStatus = ANALYSIS_STATUS.QUEUED;
    await video.save();

    try {
        const messageId = await publishVideoAnalysisJob({
            videoId: video._id.toString(),
            twelveLabsAssetId,
            userId: userId.toString()
        });
        console.log(`[Service] Analysis job published to QStash for video ${video._id}, asset ${twelveLabsAssetId}, messageId: ${messageId}`);
    } catch (queueError) {
        const errMsg = 'Failed to queue analysis job. Please use Re-analyze.';
        console.error(`[Service] Failed to publish analysis job to QStash for video ${video._id}:`, queueError.message);
        video.analysisStatus = ANALYSIS_STATUS.FAILED;
        video.lastError = errMsg;
        video.lastErrorAt = new Date();
        await video.save();
        throw new ApiError(502, errMsg);
    }
};

// export const generatePresignedUploadUrlService = async (userId, filename, contentType, selectedFeatures = []) => {
//     try {
//         if (!userId || !filename || !contentType) {
//             throw new ApiError(400, 'User ID, filename, and content type are required');
//         }

//         // Generate unique video ID
//         const videoId = new mongoose.Types.ObjectId();
        
//         // Generate S3 key: videos/{userId}/{videoId}
//         const s3Key = `videos/${userId}/${videoId}`;

//         // Create video record with pending status
//         const video = new Video({
//             _id: videoId,
//             s3Key,
//             s3_url: '', // Will be updated after upload
//             filename,
//             fileSize: 0, // Will be updated after upload
//             uploadStatus: UPLOAD_STATUS.PENDING,
//             selectedFeatures: Array.isArray(selectedFeatures) ? selectedFeatures : [],
//             uploader_id: userId
//         });

//         await video.save();

//         // Generate presigned URL
//         const presignedUrl = await uploadFileUrl(s3Key, contentType);
//         // console.log("Pre Signed URL Generation Response", presignedUrl)

//         return {
//             presignedUrl,
//             videoId: videoId.toString(),
//             s3Key
//         };
//     } catch (error) {
//         if (error instanceof ApiError) {
//             throw error;
//         }
//         // console.log("Pre Signed URL Generation Service Error", error)
//         throw new ApiError(500, `Failed to generate presigned URL: ${error.message}`);
//     }
// };

export const confirmVideoUploadService = async (videoId, userId, fileSize) => {
    try {
        if (!videoId || !userId) {
            throw new ApiError(400, 'Video ID and User ID are required');
        }

        const video = await Video.findOne({ _id: videoId, uploader_id: userId });

        if (!video) {
            throw new ApiError(404, 'Video not found');
        }

        // Update video status and file size
        video.uploadStatus = UPLOAD_STATUS.COMPLETED;
        if (fileSize) {
            video.fileSize = fileSize;
        }
        
        // Generate S3 URL (you might want to store the actual URL or generate signed URL on demand)
        // For now, we'll use the s3Key to generate URL when needed
        video.s3_url = `s3://${AWS_S3_BUCKET_NAME}/${video.s3Key}`;

        // Set analysis status to queued before enqueueing (webhook claims queued → processing)
        video.analysisStatus = ANALYSIS_STATUS.QUEUED;

        await video.save();

        // Publish video analysis job to QStash
        try {
            const messageId = await publishVideoAnalysisJob({
                videoId: video._id.toString(),
                videoUrl: video.s3_url
            });
            console.log(`[Service] Analysis job published to QStash for video ${video._id}, messageId: ${messageId}`);
        } catch (queueError) {
            // Log error but don't fail the upload confirmation
            console.error(`[Service] Failed to publish analysis job to QStash for video ${video._id}:`, queueError.message);
            // Set status back to pending if queue fails
            video.analysisStatus = ANALYSIS_STATUS.PENDING;
            await video.save();
        }

        return video;
    } catch (error) {
        if (error instanceof ApiError) {
            throw error;
        }
        throw new ApiError(500, `Failed to confirm video upload: ${error.message}`);
    }
};

/** Fields the Home, Library and "analyzing" badge need. Keeps polling cheap as libraries grow. */
export const VIDEO_SUMMARY_FIELDS = '_id filename thumbnailUrl uploadStatus analysisStatus selectedFeatures viralityScore isAnalysisReady createdAt updatedAt lastError actualViews';
const MAX_SUMMARY_VIDEOS = 500;

export const getUserVideoSummariesService = async (userId) => {
    if (!userId) throw new ApiError(400, 'User ID is required');
    return Video.find({ uploader_id: userId })
        .select(VIDEO_SUMMARY_FIELDS)
        .sort({ createdAt: -1 })
        .limit(MAX_SUMMARY_VIDEOS)
        .lean();
};

export const getUserVideosService = async (userId) => {
    try {
        if (!userId) {
            throw new ApiError(400, 'User ID is required');
        }

        const videos = await Video.find({ uploader_id: userId })
            .sort({ createdAt: -1 })
            .lean();

        return videos;
    } catch (error) {
        if (error instanceof ApiError) {
            throw error;
        }
        throw new ApiError(500, `Failed to fetch user videos: ${error.message}`);
    }
};

export const deleteVideoService = async (videoId, userId) => {
    try {
        if (!videoId || !userId) {
            throw new ApiError(400, 'Video ID and User ID are required');
        }

        const video = await Video.findOne({ _id: videoId, uploader_id: userId });

        if (!video) {
            throw new ApiError(404, 'Video not found');
        }

        // Delete from TwelveLabs indexed video (from index) first
        if (video.twelveLabsVideoId && TWELVELABS_USER_INDEX) {
            try {
                console.log(`[Delete] Deleting TwelveLabs indexed video: ${video.twelveLabsVideoId} from index: ${TWELVELABS_USER_INDEX}`);
                await TwelveLabsClient.indexes.indexedAssets.delete(
                    TWELVELABS_USER_INDEX,
                    video.twelveLabsVideoId
                );
                console.log(`[Delete] Successfully deleted TwelveLabs indexed video: ${video.twelveLabsVideoId}`);
            } catch (twelveLabsIndexError) {
                // Log error but continue with other deletions
                console.error(`[Delete] Failed to delete TwelveLabs indexed video ${video.twelveLabsVideoId}:`, twelveLabsIndexError.message);
            }
        }

        // Delete from TwelveLabs asset
        if (video.twelveLabsAssetId) {
            try {
                console.log(`[Delete] Deleting TwelveLabs asset: ${video.twelveLabsAssetId}`);
                await TwelveLabsClient.assets.delete(video.twelveLabsAssetId);
                console.log(`[Delete] Successfully deleted TwelveLabs asset: ${video.twelveLabsAssetId}`);
            } catch (twelveLabsAssetError) {
                // Log error but continue with other deletions
                console.error(`[Delete] Failed to delete TwelveLabs asset ${video.twelveLabsAssetId}:`, twelveLabsAssetError.message);
            }
        }

        // Delete chat messages linked to this video
        try {
            const deletedChats = await Chat.deleteMany({ videoId: videoId });
            console.log(`[Delete] Deleted ${deletedChats.deletedCount} chat document(s) for video: ${videoId}`);
        } catch (chatError) {
            // Log error but continue with other deletions
            console.error(`[Delete] Failed to delete chat messages for video ${videoId}:`, chatError.message);
        }

        // Delete from S3
        // if (video.s3Key) {
        //     try {
                // await deleteFile(video.s3Key);
                // awai(video.s3Key);
        //         console.log(`[Delete] Successfully deleted S3 file: ${video.s3Key}`);
        //     } catch (s3Error) {
        //         // Log error but continue with DB deletion
        //         console.error(`[Delete] Failed to delete from S3: ${video.s3Key}`, s3Error.message);
        //     }
        // }

        // Delete from database
        await Video.deleteOne({ _id: videoId, uploader_id: userId });
        console.log(`[Delete] Successfully deleted video document: ${videoId}`);

        return true;
    } catch (error) {
        if (error instanceof ApiError) {
            throw error;
        }
        throw new ApiError(500, `Failed to delete video: ${error.message}`);
    }
};

export const markAnalysisViewedService = async (videoId, userId) => {
    try {
        if (!videoId || !userId) {
            throw new ApiError(400, 'Video ID and User ID are required');
        }

        const video = await Video.findOne({ _id: videoId, uploader_id: userId });

        if (!video) {
            throw new ApiError(404, 'Video not found');
        }

        video.isAnalysisReady = true;
        await video.save();

        return video;
    } catch (error) {
        if (error instanceof ApiError) {
            throw error;
        }
        throw new ApiError(500, `Failed to mark analysis as viewed: ${error.message}`);
    }
};

/**
 * Filters a user-supplied selectedFeatures array against the user's plan's
 * allowed feature set. Silently drops any feature not allowed for the plan —
 * the user is not informed which features were stripped, because the frontend
 * should never have offered them in the first place. Returns a new array
 * (does not mutate input).
 *
 * Empty/null/undefined input is preserved as-is; the dispatcher in
 * processVideoAnalysis defaults to the full allowed list when selectedFeatures
 * is empty, and that default is itself filtered by the dispatch-time gate.
 */
const filterFeaturesForUser = async (userId, selectedFeatures) => {
    if (!Array.isArray(selectedFeatures) || selectedFeatures.length === 0) {
        return selectedFeatures;
    }
    const subscription = await getOrCreateSubscription(userId);
    const allowed = allowedFeaturesForPlan(subscription.plan);
    return selectedFeatures.filter(f => allowed.includes(f));
};

export const uploadVideoToTwelveLabsService = async (userId, file, filename, selectedFeatures = [], creator = {}) => {
    let quotaClaimed = false;
    let keepVideoQuota = false;
    try {
        if (!userId || !file || !filename) {
            throw new ApiError(400, 'User ID, file, and filename are required');
        }

        await assertLifetimeFreeTrialAvailable(userId);
        await claimVideoMonthlySlot(userId);
        quotaClaimed = true;

        // Filter selectedFeatures against the user's plan — silently drops any
        // feature their tier doesn't allow. The dispatcher re-checks at run time
        // (security backstop in processVideoAnalysis).
        const filteredFeatures = await filterFeaturesForUser(userId, selectedFeatures);

        // Get file size from multer file object or buffer
        const fileSize = file.size || file.buffer?.length || 0;

        // Generate unique video ID
        const videoId = new mongoose.Types.ObjectId();

        // Create video record with pending status
        const video = new Video({
            _id: videoId,
            filename,
            fileSize: fileSize,
            creatorPlatform: normalizePlatform(creator.platform),
            creatorFollowers: normalizeFollowers(creator.followers),
            uploadStatus: UPLOAD_STATUS.UPLOADING,
            selectedFeatures: Array.isArray(filteredFeatures) ? filteredFeatures : [],
            uploader_id: userId
        });

        await video.save();

        try {
            if (!TWELVELABS_USER_INDEX) {
                throw new ApiError(500, 'TWELVELABS_USER_INDEX is not configured. Please set it in your environment variables.');
            }

            // Upload to TwelveLabs using direct method
            // Convert buffer to Stream as TwelveLabs SDK expects a Stream
            let fileToUpload;
            
            if (file?.path) {
                // Disk upload (multer diskStorage): stream from the temp file, never load it into memory.
                fileToUpload = fs.createReadStream(file.path);
            } else if (Buffer.isBuffer(file)) {
                // Convert Buffer to Readable Stream
                fileToUpload = Readable.from(file);
            } else if (file.buffer) {
                // Multer provides file.buffer, convert to Stream
                fileToUpload = Readable.from(file.buffer);
            } else if (file instanceof Readable) {
                // Already a stream
                fileToUpload = file;
            } else {
                // Try to create stream from file
                fileToUpload = Readable.from(Buffer.from(file));
            }
            
            console.log(`📤 Uploading file to TwelveLabs: ${filename}, size: ${file.size || file.buffer?.length || 'unknown'}`);

            const slots = twelveLabsUploadSlots.stats();
            if (slots.active >= slots.limit) {
                console.log(`[Upload] ${slots.active} uploads already sending to Twelve Labs; ${filename} waits for a free slot`);
            }
            const assetResponse = await twelveLabsUploadSlots.run(() => twelveLabsCreateDirectAsset(fileToUpload));

            console.log(`📦 TwelveLabs response:`, JSON.stringify(assetResponse, null, 2));
            // Readiness + indexing now run in the background job (see ensureVideoIndexed).
            let queueError = null;
            try {
                await queueAnalysisForUploadedAsset(video, assetResponse, userId);
            } catch (err) {
                if (err instanceof ApiError && err.statusCode === 502) {
                    queueError = err;
                } else {
                    throw err;
                }
            }

            // The file reached Twelve Labs: the upload counts against quota even if queueing failed
            // (the user can Re-analyze without uploading again).
            keepVideoQuota = true;
            try {
                await incrementLifetimeFreeVideoCount(userId);
            } catch (err) {
                console.error(`[Upload] Failed to increment lifetime counter for ${userId}:`, err.message);
            }
            if (queueError) throw queueError;
            return video;
        } catch (twelveLabsError) {
            if (twelveLabsError instanceof ApiError && twelveLabsError.statusCode === 502) {
                throw twelveLabsError;
            }
            // If TwelveLabs upload fails, mark video as failed (both statuses, so it never shows as "analyzing")
            video.uploadStatus = UPLOAD_STATUS.FAILED;
            video.analysisStatus = ANALYSIS_STATUS.FAILED;
            video.lastError = 'The upload did not finish. Please upload the video again.';
            video.lastErrorAt = new Date();
            await video.save();

            void alertFailure({ stage: 'upload', videoId: String(video._id), userId: String(userId), error: twelveLabsError });
            console.error("❌ TwelveLabs upload error:", {
                message: twelveLabsError.message,
                statusCode: twelveLabsError.statusCode,
                body: twelveLabsError.body,
                rawResponse: twelveLabsError.rawResponse,
                stack: twelveLabsError.stack
            });

            const errorMessage = twelveLabsError.message || 'Failed to upload to TwelveLabs';
            throw new ApiError(500, `Failed to upload to TwelveLabs: ${errorMessage}`);
        }
    } catch (error) {
        try {
            if (quotaClaimed && !keepVideoQuota) {
                await releaseVideoMonthlySlot(userId);
            }
        } catch {
            /* ignore release errors */
        }
        if (error instanceof ApiError) {
            throw error;
        }
        throw new ApiError(500, `Failed to upload video: ${error.message}`);
    }
};

export const uploadVideoUrlToTwelveLabsService = async (userId, url, filename, selectedFeatures = []) => {
    let quotaClaimed = false;
    let keepVideoQuota = false;
    try {
        if (!userId || !url || !filename) {
            throw new ApiError(400, 'User ID, URL, and filename are required');
        }

        // Validate URL format
        try {
            new URL(url);
        } catch (urlError) {
            throw new ApiError(400, 'Invalid URL format');
        }

        await assertLifetimeFreeTrialAvailable(userId);
        await claimVideoMonthlySlot(userId);
        quotaClaimed = true;

        // Filter selectedFeatures against the user's plan — silently drops any
        // feature their tier doesn't allow. The dispatcher re-checks at run time
        // (security backstop in processVideoAnalysis).
        const filteredFeatures = await filterFeaturesForUser(userId, selectedFeatures);

        // Generate unique video ID
        const videoId = new mongoose.Types.ObjectId();

        // Create video record with pending status
        const video = new Video({
            _id: videoId,
            filename,
            fileSize: 0, // URL uploads don't have file size initially
            uploadStatus: UPLOAD_STATUS.UPLOADING,
            selectedFeatures: Array.isArray(filteredFeatures) ? filteredFeatures : [],
            uploader_id: userId
        });

        await video.save();

        try {
            if (!TWELVELABS_USER_INDEX) {
                throw new ApiError(500, 'TWELVELABS_USER_INDEX is not configured. Please set it in your environment variables.');
            }

            let assetResponse;
            if (isAllowedSocialVideoUrl(url)) {
                const { buffer, metadata, byteLength } = await downloadSocialVideoForIngest(url);
                video.fileSize = byteLength;
                video.sourceUrl = url;
                if (metadata.title) video.sourceTitle = metadata.title;
                if (metadata.description) video.sourceDescription = metadata.description;
                await video.save();
                assetResponse = await twelveLabsCreateDirectAsset(Readable.from(buffer));
                console.log(`📦 TwelveLabs direct upload (social URL fetch), asset status: ${assetResponse?.status || 'unknown'}`);
            } else {
                assetResponse = await twelveLabsCreateUrlAsset(url);
                console.log(`📦 TwelveLabs URL upload response:`, JSON.stringify(assetResponse, null, 2));
            }
            // Readiness + indexing now run in the background job (see ensureVideoIndexed).
            let queueError = null;
            try {
                await queueAnalysisForUploadedAsset(video, assetResponse, userId);
            } catch (err) {
                if (err instanceof ApiError && err.statusCode === 502) {
                    queueError = err;
                } else {
                    throw err;
                }
            }

            // The file reached Twelve Labs: the upload counts against quota even if queueing failed
            // (the user can Re-analyze without uploading again).
            keepVideoQuota = true;
            try {
                await incrementLifetimeFreeVideoCount(userId);
            } catch (err) {
                console.error(`[Upload] Failed to increment lifetime counter for ${userId}:`, err.message);
            }
            if (queueError) throw queueError;
            return video;
        } catch (ingestErr) {
            if (ingestErr instanceof ApiError && ingestErr.statusCode === 502) {
                throw ingestErr;
            }
            video.uploadStatus = UPLOAD_STATUS.FAILED;
            video.analysisStatus = ANALYSIS_STATUS.FAILED;
            video.lastError = 'The upload did not finish. Please upload the video again.';
            video.lastErrorAt = new Date();
            await video.save();
            if (ingestErr instanceof ApiError) {
                throw ingestErr;
            }
            throw new ApiError(500, `Failed to upload URL to TwelveLabs: ${ingestErr.message}`);
        }
    } catch (error) {
        try {
            if (quotaClaimed && !keepVideoQuota) {
                await releaseVideoMonthlySlot(userId);
            }
        } catch {
            /* ignore */
        }
        if (error instanceof ApiError) {
            throw error;
        }
        throw new ApiError(500, `Failed to upload video URL: ${error.message}`);
    }
};

