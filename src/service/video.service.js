import { Video } from '../model/video.model.js';
import { Chat } from '../model/chat.model.js';
// import { uploadFileUrl, deleteFile } from '../lib/aws_s3.js';
import { ApiError } from '../utils/ApiError.js';
import { UPLOAD_STATUS, ANALYSIS_STATUS } from '../constants.js';
import { publishVideoAnalysisJob } from '../queue/video.queue.js';
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

export const waitForAssetReady = async (assetId, initialStatus) => {
    let assetStatus = initialStatus;
    let attempts = 0;
    const maxAttempts = 30; // Wait up to 5 minutes (30 * 10 seconds)

    while (assetStatus !== 'ready' && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 10000));
        try {
            const assetCheck = await TwelveLabsClient.assets.retrieve(assetId);
            assetStatus = assetCheck?.status;
            console.log(`⏳ Asset status: ${assetStatus} (attempt ${attempts + 1}/${maxAttempts})`);
        } catch (error) {
            console.warn(`⚠️ Error checking asset status: ${error.message}`);
        }
        attempts++;
    }

    if (assetStatus !== 'ready') {
        throw new Error(`Asset ${assetId} did not become ready after ${maxAttempts} attempts. Current status: ${assetStatus}`);
    }
};

export const indexAssetWithRetry = async (assetId, indexId) => {
    if (!indexId || String(indexId).trim() === '') {
        throw new Error('Twelve Labs index id is required for indexing.');
    }

    console.log(`📚 Indexing asset ${assetId} into index ${indexId}...`);

    const indexResponse = await TwelveLabsClient.indexes.indexedAssets.create(
        indexId,
        {
            assetId,
            enableVideoStream: true
        }
    );

    const indexedAssetId = indexResponse?.id;
    let indexedStatus = indexResponse?.status;

    if (!indexedAssetId) {
        console.error('❌ Could not find indexed asset ID in response. Response structure:', indexResponse);
        throw new Error('Failed to get indexed asset ID from TwelveLabs response');
    }

    let attempts = 0;
    const maxAttempts = 30;

    while (indexedStatus !== 'ready' && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        try {
            const indexedAsset = await TwelveLabsClient.indexes.indexedAssets.retrieve(
                indexId,
                indexedAssetId
            );
            indexedStatus = indexedAsset?.status;
            console.log(`⏳ Indexed asset status: ${indexedStatus} (attempt ${attempts + 1}/${maxAttempts})`);
        } catch (statusError) {
            console.warn(`⚠️ Error checking indexed asset status: ${statusError.message}`);
        }
        attempts++;
    }

    if (indexedStatus !== 'ready') {
        throw new Error(`Indexed asset ${indexedAssetId} did not become ready after ${maxAttempts} attempts. Current status: ${indexedStatus}`);
    }

    return {
        indexedAssetId,
        indexedStatus
    };
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

export const uploadVideoToTwelveLabsService = async (userId, file, filename, selectedFeatures = []) => {
    try {
        if (!userId || !file || !filename) {
            throw new ApiError(400, 'User ID, file, and filename are required');
        }

        // Get file size from multer file object or buffer
        const fileSize = file.size || file.buffer?.length || 0;

        // Generate unique video ID
        const videoId = new mongoose.Types.ObjectId();

        // Create video record with pending status
        const video = new Video({
            _id: videoId,
            filename,
            fileSize: fileSize,
            uploadStatus: UPLOAD_STATUS.UPLOADING,
            selectedFeatures: Array.isArray(selectedFeatures) ? selectedFeatures : [],
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
            
            if (Buffer.isBuffer(file)) {
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

            const assetResponse = await twelveLabsCreateDirectAsset(fileToUpload);

            console.log(`📦 TwelveLabs response:`, JSON.stringify(assetResponse, null, 2));

            const twelveLabsAssetId = assetResponse?.id || assetResponse?._id;

            console.log(`✅ TwelveLabs upload successful, asset ID: ${twelveLabsAssetId}, status: ${assetResponse?.status || 'unknown'}`);

            // Store asset ID
            video.twelveLabsAssetId = twelveLabsAssetId;

            await waitForAssetReady(twelveLabsAssetId, assetResponse?.status);

            // Index the asset into an index to get a video ID (required for analysis)
            const { indexedAssetId } = await indexAssetWithRetry(twelveLabsAssetId, TWELVELABS_USER_INDEX);
            const twelveLabsVideoId = indexedAssetId;

            console.log(`✅ Asset indexed successfully, video ID: ${twelveLabsVideoId}`);

            // Update video with video ID and mark as completed
            video.twelveLabsVideoId = twelveLabsVideoId;
            video.uploadStatus = UPLOAD_STATUS.COMPLETED;
            
            // Set analysis status to queued before enqueueing (webhook claims queued → processing)
            video.analysisStatus = ANALYSIS_STATUS.QUEUED;
            await video.save();

            // Publish video analysis job to QStash
            try {
                const messageId = await publishVideoAnalysisJob({
                    videoId: video._id.toString(),
                    twelveLabsVideoId: twelveLabsVideoId,
                    userId: userId.toString()
                });
                console.log(`[Service] Analysis job published to QStash for video ${video._id}, TwelveLabs video ID: ${twelveLabsVideoId}, messageId: ${messageId}`);
            } catch (queueError) {
                const errMsg = 'Failed to queue analysis job. Please use Re-analyze.';
                console.error(`[Service] Failed to publish analysis job to QStash for video ${video._id}:`, queueError.message);
                video.analysisStatus = ANALYSIS_STATUS.FAILED;
                video.lastError = errMsg;
                video.lastErrorAt = new Date();
                await video.save();
                throw new ApiError(502, errMsg);
            }

            return video;
        } catch (twelveLabsError) {
            // If TwelveLabs upload fails, mark video as failed
            video.uploadStatus = UPLOAD_STATUS.FAILED;
            await video.save();
            
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
        if (error instanceof ApiError) {
            throw error;
        }
        throw new ApiError(500, `Failed to upload video: ${error.message}`);
    }
};

export const uploadVideoUrlToTwelveLabsService = async (userId, url, filename, selectedFeatures = []) => {
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

        // Generate unique video ID
        const videoId = new mongoose.Types.ObjectId();

        // Create video record with pending status
        const video = new Video({
            _id: videoId,
            filename,
            fileSize: 0, // URL uploads don't have file size initially
            uploadStatus: UPLOAD_STATUS.UPLOADING,
            selectedFeatures: Array.isArray(selectedFeatures) ? selectedFeatures : [],
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

            const twelveLabsAssetId = assetResponse?.id || assetResponse?._id;

            console.log(`✅ TwelveLabs upload successful, asset ID: ${twelveLabsAssetId}, status: ${assetResponse?.status || 'unknown'}`);

            // Store asset ID
            video.twelveLabsAssetId = twelveLabsAssetId;

            await waitForAssetReady(twelveLabsAssetId, assetResponse?.status);

            // Index the asset into an index to get a video ID (required for analysis)
            const { indexedAssetId } = await indexAssetWithRetry(twelveLabsAssetId, TWELVELABS_USER_INDEX);
            const twelveLabsVideoId = indexedAssetId;

            console.log(`✅ Asset indexed successfully, video ID: ${twelveLabsVideoId}`);

            // Update video with video ID and mark as completed
            video.twelveLabsVideoId = twelveLabsVideoId;
            video.uploadStatus = UPLOAD_STATUS.COMPLETED;
            
            // Set analysis status to queued before enqueueing (webhook claims queued → processing)
            video.analysisStatus = ANALYSIS_STATUS.QUEUED;
            await video.save();

            // Publish video analysis job to QStash
            try {
                const messageId = await publishVideoAnalysisJob({
                    videoId: video._id.toString(),
                    twelveLabsVideoId: twelveLabsVideoId,
                    userId: userId.toString()
                });
                console.log(`[Service] Analysis job published to QStash for video ${video._id}, TwelveLabs video ID: ${twelveLabsVideoId}, messageId: ${messageId}`);
            } catch (queueError) {
                const errMsg = 'Failed to queue analysis job. Please use Re-analyze.';
                console.error(`[Service] Failed to publish analysis job to QStash for video ${video._id}:`, queueError.message);
                video.analysisStatus = ANALYSIS_STATUS.FAILED;
                video.lastError = errMsg;
                video.lastErrorAt = new Date();
                await video.save();
                throw new ApiError(502, errMsg);
            }

            return video;
        } catch (ingestErr) {
            video.uploadStatus = UPLOAD_STATUS.FAILED;
            await video.save();
            if (ingestErr instanceof ApiError) {
                throw ingestErr;
            }
            throw new ApiError(500, `Failed to upload URL to TwelveLabs: ${ingestErr.message}`);
        }
    } catch (error) {
        if (error instanceof ApiError) {
            throw error;
        }
        throw new ApiError(500, `Failed to upload video URL: ${error.message}`);
    }
};

