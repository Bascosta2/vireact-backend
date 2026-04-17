import {
    // generatePresignedUploadUrlService,
    confirmVideoUploadService,
    getUserVideosService,
    deleteVideoService,
    markAnalysisViewedService,
    uploadVideoToTwelveLabsService,
    uploadVideoUrlToTwelveLabsService
} from '../service/video.service.js';
import { notifyUserShortsReady } from '../service/notification.service.js';
import { User } from '../model/user.model.js';
import { generateVideoFeedbackService } from '../service/video-feedback.service.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { Video } from '../model/video.model.js';
import { Chat } from '../model/chat.model.js';
import { ANALYSIS_STATUS } from '../constants.js';
import { publishVideoAnalysisJob } from '../queue/video.queue.js';
import TwelveLabsClient from '../lib/twelve-labs.js';
import { analyzeHook } from '../service/analyzer/hook.analyzer.js';
import { analyzeCaption } from '../service/analyzer/caption.analyzer.js';
import { analyzePacing } from '../service/analyzer/pacing.analyzer.js';
import { analyzeAudio } from '../service/analyzer/audio.analyzer.js';
import { analyzeAdvancedAnalytics } from '../service/analyzer/advanced-analytics.analyzer.js';
import { analyzeViewsPredictor } from '../service/analyzer/views-predictor.analyzer.js';
import { checkVideoLimit, incrementVideoUsage } from '../service/subscription.service.js';
import { computeRetentionCurve } from '../service/retention-curve.service.js';
import { buildVideoWithAnalysisResponse } from '../service/video-analysis-dto.service.js';
import { TWELVE_LABS_SCENE_PROMPT, parseScenesWithOpenAI } from '../service/scene-parser.service.js';

export const getPresignedUploadUrl = async (req, res) => {
    return res.status(410).json(
        ApiResponse.error(
            410,
            'Presigned URL upload flow is no longer supported. Use /videos/upload-file or /videos/upload-url.'
        )
    );
};

export const confirmVideoUpload = async (req, res, next) => {
    try {
        const { videoId } = req.params;
        const { fileSize } = req.body;
        const userId = req.user._id;

        if (!videoId) {
            throw new ApiError(400, 'Video ID is required');
        }

        const video = await confirmVideoUploadService(videoId, userId, fileSize);

        res.status(200).json(
            ApiResponse.success(
                200,
                'Video upload confirmed successfully',
                { video }
            )
        );
    } catch (error) {
        next(error);
    }
};

export const getUserVideos = async (req, res, next) => {
    try {
        const userId = req.user._id;

        const videos = await getUserVideosService(userId);

        res.status(200).json(
            ApiResponse.success(
                200,
                'Videos fetched successfully',
                { videos }
            )
        );
    } catch (error) {
        next(error);
    }
};

export const deleteVideo = async (req, res, next) => {
    try {
        const { videoId } = req.params;
        const userId = req.user._id;

        if (!videoId) {
            throw new ApiError(400, 'Video ID is required');
        }

        await deleteVideoService(videoId, userId);

        res.status(200).json(
            ApiResponse.success(
                200,
                'Video deleted successfully',
                null
            )
        );
    } catch (error) {
        next(error);
    }
};

export const markAnalysisViewed = async (req, res, next) => {
    try {
        const { videoId } = req.params;
        const userId = req.user._id;

        if (!videoId) {
            throw new ApiError(400, 'Video ID is required');
        }

        const video = await markAnalysisViewedService(videoId, userId);

        res.status(200).json(
            ApiResponse.success(
                200,
                'Analysis marked as viewed successfully',
                { video }
            )
        );
    } catch (error) {
        next(error);
    }
};

/** Safe copy for clients when analysis failed — never expose raw provider strings. */
function getVideoStatusErrorSummary(analysisStatus, lastError) {
    if (analysisStatus !== ANALYSIS_STATUS.FAILED) {
        return undefined;
    }
    const q = typeof lastError === 'string' && lastError.includes('queue analysis job');
    if (q) {
        return 'Failed to queue analysis job. Please use Re-analyze.';
    }
    return 'Analysis could not be completed. Try Re-analyze, or contact support if this persists.';
}

const extractScore = (raw) => {
    if (typeof raw === 'number' && !isNaN(raw)) {
        return Math.round(Math.min(100, Math.max(0, raw)));
    }
    if (typeof raw === 'string') {
        const parsed = parseFloat(raw);
        if (!isNaN(parsed)) return Math.round(Math.min(100, Math.max(0, parsed)));
    }
    return null;
};

const ratingFallback = (rating) => {
    if (!rating) return null;
    const r = String(rating).toLowerCase().trim();
    if (['strong', 'excellent', 'high'].includes(r)) return 80;
    if (['good', 'above average'].includes(r)) return 68;
    if (['medium', 'average', 'moderate'].includes(r)) return 52;
    if (['weak', 'poor', 'low'].includes(r)) return 28;
    if (['very weak', 'very poor'].includes(r)) return 15;
    return null;
};

export const getVideoStatus = async (req, res, next) => {
    try {
        const { videoId } = req.params;
        const userId = req.user._id;

        if (!videoId) {
            throw new ApiError(400, 'Video ID is required');
        }

        const video = await Video.findOne({ _id: videoId, uploader_id: userId })
            .select('uploadStatus analysisStatus isAnalysisReady lastError lastErrorAt')
            .lean();
        if (!video) {
            throw new ApiError(404, 'Video not found');
        }

        const errorSummary = getVideoStatusErrorSummary(video.analysisStatus, video.lastError);

        res.status(200).json(
            ApiResponse.success(
                200,
                'Video status retrieved successfully',
                {
                    uploadStatus: video.uploadStatus,
                    analysisStatus: video.analysisStatus,
                    isAnalysisReady: video.isAnalysisReady,
                    ...(errorSummary ? { errorSummary } : {}),
                }
            )
        );
    } catch (error) {
        next(error);
    }
};

export const getVideoFeedback = async (req, res, next) => {
    try {
        const { videoId } = req.params;
        const userId = req.user._id;

        if (!videoId) {
            throw new ApiError(400, 'Video ID is required');
        }

        const feedback = await generateVideoFeedbackService(videoId, userId);

        res.status(200).json(
            ApiResponse.success(
                200,
                'Video feedback retrieved successfully',
                feedback
            )
        );
    } catch (error) {
        next(error);
    }
};

export const getVideoById = async (req, res, next) => {
    try {
        const { videoId } = req.params;
        const userId = req.user._id;

        if (!videoId) {
            throw new ApiError(400, 'Video ID is required');
        }

        const video = await Video.findOne({ _id: videoId, uploader_id: userId });
        if (!video) {
            throw new ApiError(404, 'Video not found');
        }

        const payload = buildVideoWithAnalysisResponse(video);
        res.status(200).json(
            ApiResponse.success(200, 'Video retrieved successfully', payload)
        );
    } catch (error) {
        next(error);
    }
};

export const reanalyzeVideo = async (req, res, next) => {
    try {
        const { videoId } = req.params;
        const userId = req.user._id;

        if (!videoId) {
            throw new ApiError(400, 'Video ID is required');
        }

        const video = await Video.findOne({ _id: videoId, uploader_id: userId });
        if (!video) {
            throw new ApiError(404, 'Video not found');
        }

        if (!video.twelveLabsVideoId) {
            return res.status(400).json(
                ApiResponse.error(
                    400,
                    'TwelveLabs indexing incomplete, please delete and re-upload this video'
                )
            );
        }

        video.analysisStatus = ANALYSIS_STATUS.QUEUED;
        await video.save();

        await publishVideoAnalysisJob({
            videoId: video._id.toString(),
            twelveLabsVideoId: video.twelveLabsVideoId,
            userId: userId.toString(),
        });

        return res.status(200).json(
            ApiResponse.success(200, 'Reanalysis job queued', {
                success: true,
                message: 'Reanalysis job queued',
            })
        );
    } catch (error) {
        next(error);
    }
};

export const processVideoAnalysis = async (req, res) => {
    console.log('[QStash] processVideoAnalysis triggered');
    try {
        console.log('[QStash] req.body:', JSON.stringify(req.body));
    } catch {
        console.log('[QStash] req.body: (could not stringify)');
    }

    const { videoId, twelveLabsVideoId, userId } = req.body || {};

    if (!videoId) {
        console.error('[QStash] Missing videoId in request body; acking without retry');
        return res.status(200).json({ received: true });
    }

    res.status(200).json({ received: true, videoId });
    console.log('[QStash] Acknowledged to QStash, starting background analysis:', videoId);

    setImmediate(async () => {
        let video;
        try {
            console.log('[QStash] Background analysis started for:', videoId);
            try {
                video = await Video.findOneAndUpdate(
                    {
                        _id: videoId,
                        analysisStatus: ANALYSIS_STATUS.QUEUED
                    },
                    { $set: { analysisStatus: ANALYSIS_STATUS.PROCESSING } },
                    { new: true }
                );
            } catch (dbErr) {
                console.error('[QStash] DB claim failed:', dbErr.message);
                return;
            }

            if (!video) {
                const existing = await Video.findById(videoId).select('analysisStatus').lean();
                if (!existing) {
                    console.error('[QStash] Background: video not found:', videoId);
                } else {
                    console.log('[QStash] Video already claimed or completed, skipping:', videoId, existing.analysisStatus);
                }
                return;
            }

            console.log('[QStash] Video claimed for processing, id:', videoId, 'analysisStatus:', video.analysisStatus);

            const indexedVideoId = video.twelveLabsVideoId || twelveLabsVideoId;

            if (!indexedVideoId) {
                if (video.twelveLabsAssetId) {
                    console.log(`[QStash] Video ${videoId} has asset ID but not indexed. Attempting to index...`);
                    throw new Error('Video has not been indexed yet. Please wait for indexing to complete.');
                }
                throw new Error('TwelveLabs video ID is required. Video may not have been uploaded to TwelveLabs.');
            }

            console.log(`[QStash] Processing analysis for video ${videoId}`);
            console.log(`[QStash] TwelveLabs Video ID (indexed): ${indexedVideoId}`);
            if (video.twelveLabsAssetId) {
                console.log(`[QStash] TwelveLabs Asset ID: ${video.twelveLabsAssetId}`);
            }
            if (userId) {
                console.log(`[QStash] User ID: ${userId}`);
            }

            console.log(`[QStash] Analyzing video using indexed video ID: ${indexedVideoId}`);

            const videoAnalysisResult = await TwelveLabsClient.analyze(
                {
                    videoId: indexedVideoId,
                    prompt: TWELVE_LABS_SCENE_PROMPT,
                    temperature: 0.2
                },
                { timeoutInSeconds: 180 }
            );

            console.log('[QStash] TwelveLabs analyze completed for video:', videoId);

            console.log('Video Analysis Result', videoAnalysisResult);
            console.log('Video Analysis Result Type:', typeof videoAnalysisResult);
            if (typeof videoAnalysisResult === 'object') {
                console.log('Video Analysis Result Keys:', Object.keys(videoAnalysisResult));
            }

            const scenes = await parseScenesWithOpenAI(videoAnalysisResult);
            console.log(`[QStash] parseScenesWithOpenAI done, scene count: ${scenes.length}`);

            if (scenes.length === 0) {
                console.warn('[QStash] No scenes were parsed from the analysis result. Raw result:', JSON.stringify(videoAnalysisResult, null, 2));
            }

            video.scenes = scenes;
            console.log(`[QStash] Storing ${video.scenes.length} scenes in video document`);
            await video.save();

            const savedVideo = await Video.findById(videoId);
            console.log(`[QStash] Verified: Video document now has ${savedVideo?.scenes?.length || 0} scenes`);

            const selectedFeatures = video.selectedFeatures && video.selectedFeatures.length > 0
                ? video.selectedFeatures
                : ['hook', 'caption', 'pacing', 'audio', 'advanced_analytics', 'views_predictor'];

            const hookScene = scenes.find(s => s.purpose?.toLowerCase() === 'hook') || scenes[0];
            const hook = hookScene?.primaryAction || hookScene?.visualDescription || '';

            video.analysis = [];
            const featureOutputs = {};

            const extractAnalysisData = (result, featureName) => {
                const analysisData = {
                    feature: featureName,
                    score: null,
                    rating: null,
                    feedback: null,
                    suggestions: [],
                    analyzedAt: new Date()
                };
                if (featureName === 'advanced_analytics') {
                    analysisData.emotionalTriggers = [];
                    analysisData.retentionDrivers = [];
                    analysisData.psychologicalProfile = null;
                    analysisData.weakestMoment = null;
                }

                if (typeof result === 'string') {
                    const ratingMatch = result.match(/rating[:\-\s]*([^\n]+)/i);
                    const reasoningMatch = result.match(/reasoning[:\-\s]*([^\n]+)/i);
                    const suggestionsMatch = result.match(/suggestions?:[\s\S]*?(-[^\n]+(?:[\s\S]*?-.*?)?)/i);
                    if (ratingMatch) analysisData.rating = ratingMatch[1].trim();
                    if (reasoningMatch) analysisData.feedback = reasoningMatch[1].trim();
                    analysisData.score = ratingFallback(analysisData.rating);
                    if (suggestionsMatch) {
                        const suggestionLines = (suggestionsMatch[1] || '').match(/-[^\n]+/g) || [];
                        analysisData.suggestions = suggestionLines.map(s => s.replace(/^-\s*/, '').trim()).filter(Boolean);
                    } else {
                        analysisData.feedback = result;
                    }
                } else if (typeof result === 'object' && result !== null) {
                    analysisData.rating = result.rating ?? null;
                    analysisData.feedback = result.reasoning ?? result.feedback ?? null;
                    analysisData.suggestions = Array.isArray(result.suggestions) ? result.suggestions : [];
                    analysisData.score = extractScore(result.score) ?? ratingFallback(result.rating);
                    if (featureName === 'advanced_analytics') {
                        analysisData.emotionalTriggers = Array.isArray(result.emotionalTriggers) ? result.emotionalTriggers : [];
                        analysisData.retentionDrivers = Array.isArray(result.retentionDrivers) ? result.retentionDrivers : [];
                        analysisData.psychologicalProfile = result.psychologicalProfile ?? null;
                        analysisData.weakestMoment = result.weakestMoment ?? null;
                    }
                }

                return analysisData;
            };

            const tierToScore = (tier) => {
                const t = (tier || '').toLowerCase();
                if (t === 'high') return 80;
                if (t === 'medium') return 55;
                if (t === 'low') return 30;
                return 55;
            };

            for (const feature of selectedFeatures) {
                try {
                    let analysisResult = null;
                    switch (feature) {
                        case 'hook':
                            if (hook) {
                                analysisResult = await analyzeHook(hook, scenes);
                                featureOutputs.hook = analysisResult;
                            }
                            break;
                        case 'caption':
                            analysisResult = await analyzeCaption(scenes);
                            featureOutputs.caption = analysisResult;
                            break;
                        case 'pacing':
                            analysisResult = await analyzePacing(scenes);
                            featureOutputs.pacing = analysisResult;
                            break;
                        case 'audio':
                            analysisResult = await analyzeAudio(scenes);
                            featureOutputs.audio = analysisResult;
                            break;
                        case 'advanced_analytics':
                            analysisResult = await analyzeAdvancedAnalytics(scenes);
                            featureOutputs.advanced_analytics = analysisResult;
                            break;
                        case 'views_predictor':
                            analysisResult = await analyzeViewsPredictor(scenes);
                            featureOutputs.views_predictor = analysisResult;
                            break;
                        default:
                            console.warn(`[QStash] Unknown feature: ${feature}`);
                    }

                    if (analysisResult !== null) {
                        if (feature === 'views_predictor' && typeof analysisResult === 'object' && analysisResult.expectedLow != null && analysisResult.expectedHigh != null) {
                            video.predictedViewsLow = analysisResult.expectedLow;
                            video.predictedViewsHigh = analysisResult.expectedHigh;
                            video.predictedViewsExpected = Math.round((analysisResult.expectedLow + analysisResult.expectedHigh) / 2);
                            video.analysis.push({
                                feature: 'views_predictor',
                                score: extractScore(tierToScore(analysisResult.tier)) ?? ratingFallback(analysisResult.tier),
                                rating: analysisResult.tier || 'medium',
                                feedback: analysisResult.reasoning || null,
                                suggestions: Array.isArray(analysisResult.suggestions) ? analysisResult.suggestions : [],
                                analyzedAt: new Date()
                            });
                        } else {
                            const analysisData = extractAnalysisData(analysisResult, feature);
                            video.analysis.push(analysisData);
                        }
                    }
                } catch (featureError) {
                    console.error(`[QStash] Error analyzing feature ${feature}:`, featureError.message);
                    featureOutputs[feature] = {
                        error: `Analysis failed: ${featureError.message}`
                    };
                    video.analysis.push({
                        feature,
                        score: null,
                        rating: null,
                        feedback: 'Analysis could not be completed for this feature.',
                        suggestions: [],
                        analyzedAt: new Date()
                    });
                }
                console.log('[QStash] Feature analyzer step completed for:', feature);
            }

            const weights = { hook: 0.35, pacing: 0.25, audio: 0.20, caption: 0.10, views_predictor: 0.10 };
            let totalWeight = 0;
            let weightedSum = 0;
            for (const a of video.analysis) {
                const w = weights[a.feature];
                if (w == null) continue;
                let s = extractScore(a.score);
                if (s == null) s = ratingFallback(a.rating);
                if (s == null) continue;
                weightedSum += w * s;
                totalWeight += w;
            }
            if (totalWeight > 0) {
                video.viralityScore = Math.round(Math.min(100, Math.max(0, weightedSum / totalWeight)));
            } else {
                video.viralityScore = null;
            }

            video.retentionCurve = computeRetentionCurve(video);

            const nullScoreFeatures = video.analysis.filter(a => a.score == null).map(a => a.feature);
            if (nullScoreFeatures.length > 0) {
                console.warn('[Analysis] Null score persisted for features:', nullScoreFeatures);
            }

            video.analysisStatus = ANALYSIS_STATUS.COMPLETED;
            video.isAnalysisReady = true;
            await video.save();

            try {
                await incrementVideoUsage(userId);
            } catch (usageError) {
                console.error(`[QStash] Failed to increment video usage for user ${userId}:`, usageError.message);
            }

            try {
                const uploaderId = video.uploader_id || userId;
                const uploader = await User.findById(uploaderId).select('email').lean();
                if (uploader?.email) {
                    await notifyUserShortsReady(uploader.email, video.filename || 'Your video');
                }
            } catch (notifyError) {
                console.error(`[QStash] Failed to send shorts ready notification:`, notifyError.message);
            }

            try {
                const updatedVideo = await Video.findById(videoId);
                const initialMessage = buildInitialAnalysisMessage(updatedVideo);
                if (initialMessage) {
                    const chat = await Chat.findOneAndUpdate(
                        { videoId, userId },
                        {
                            videoId,
                            userId,
                            $setOnInsert: { messages: [] }
                        },
                        { upsert: true, new: true }
                    );
                    chat.messages.push({
                        text: initialMessage,
                        isUser: false
                    });
                    await chat.save();
                }
            } catch (chatError) {
                console.error(`[QStash] Failed to save initial analysis message to chat for video ${videoId}:`, chatError.message);
            }

            console.log(`[QStash] Analysis completed for video ${videoId}, TwelveLabs video ID: ${indexedVideoId}`);
        } catch (bgError) {
            console.error('[QStash] Background analysis failed for:', videoId);
            console.error('[QStash] Error:', bgError instanceof Error ? bgError.message : String(bgError));
            if (bgError instanceof Error && bgError.stack) {
                console.error('[QStash] Stack:', bgError.stack);
            }
            console.error(`[QStash] Analysis failed for video ${videoId} (full error):`, bgError);
            if (bgError instanceof Error && bgError.stack) {
                console.error('[QStash] Analysis failed stack:', bgError.stack);
            }
            try {
                const v = await Video.findById(videoId);
                if (v) {
                    const errMsg = bgError instanceof Error ? bgError.message : String(bgError);
                    v.analysisStatus = ANALYSIS_STATUS.FAILED;
                    v.lastError = errMsg;
                    v.lastErrorAt = new Date();
                    await v.save();
                    console.log('[QStash] Video marked as failed in DB:', videoId);
                }
            } catch (saveErr) {
                console.error('[QStash] Failed to save error state:', saveErr.message);
            }
        }
    });
};

export const uploadVideoToTwelveLabs = async (req, res, next) => {
    try {
        const userId = req.user._id;
        const file = req.file || req.files?.file;

        if (!file) {
            throw new ApiError(400, 'Video file is required');
        }

        // Check video upload limit before processing
        await checkVideoLimit(userId);

        // Use original filename from multer if available, otherwise from body
        const filename = file.originalname || req.body.filename;
        const { selectedFeatures } = req.body;

        if (!filename) {
            throw new ApiError(400, 'Filename is required');
        }

        // Log file info for debugging
        console.log(`📁 File received: ${filename}, size: ${file.size}, mimetype: ${file.mimetype}, buffer size: ${file.buffer?.length || 'N/A'}`);

        const selectedFeaturesArray = selectedFeatures
            ? (Array.isArray(selectedFeatures) ? selectedFeatures : JSON.parse(selectedFeatures))
            : [];

        // Pass the entire file object so service can handle buffer/stream conversion
        const video = await uploadVideoToTwelveLabsService(
            userId,
            file,
            filename,
            selectedFeaturesArray
        );

        res.status(200).json(
            ApiResponse.success(
                200,
                'Video uploaded to TwelveLabs successfully',
                { video }
            )
        );
    } catch (error) {
        next(error);
    }
};

export const uploadVideoUrlToTwelveLabs = async (req, res, next) => {
    try {
        const { url, filename, selectedFeatures } = req.body;
        const userId = req.user._id;

        if (!url || !filename) {
            throw new ApiError(400, 'URL and filename are required');
        }

        // Check video upload limit before processing
        await checkVideoLimit(userId);

        const selectedFeaturesArray = Array.isArray(selectedFeatures)
            ? selectedFeatures
            : [];

        const video = await uploadVideoUrlToTwelveLabsService(
            userId,
            url,
            filename,
            selectedFeaturesArray
        );

        res.status(200).json(
            ApiResponse.success(
                200,
                'Video URL uploaded to TwelveLabs successfully',
                { video }
            )
        );
    } catch (error) {
        next(error);
    }
};

// Build initial analysis message for chat from video.analysis array
function buildInitialAnalysisMessage(video) {
    const parts = [];
    const analysisArray = video.analysis || [];

    // Feature name mapping
    const featureLabels = {
        hook: 'Hook',
        caption: 'Caption',
        pacing: 'Pacing',
        audio: 'Audio',
        advanced_analytics: 'Advanced Analytics',
        views_predictor: 'Views Predictor'
    };

    // Process each analyzed feature
    analysisArray.forEach((analysis, index) => {
        const featureName = featureLabels[analysis.feature] || analysis.feature;
        
        // Add feature name
        parts.push(featureName);
        parts.push("");
        
        // Add "What's wrong" section
        parts.push("What's wrong:");
        const feedback = analysis.feedback && analysis.feedback.trim() 
            ? analysis.feedback 
            : "No specific issues identified";
        parts.push(feedback);
        parts.push("");
        
        // Add "Suggestions to improve" section
        parts.push("Suggestions to improve:");
        if (analysis.suggestions && analysis.suggestions.length > 0) {
            analysis.suggestions.forEach(suggestion => {
                parts.push(`- ${suggestion}`);
            });
        } else {
            parts.push("- No suggestions available");
        }
        
        // Add spacing between features (except after the last one)
        if (index < analysisArray.length - 1) {
            parts.push("");
            parts.push("");
        }
    });

    return parts.join('\n');
}
