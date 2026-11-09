import {
    // generatePresignedUploadUrlService,
    confirmVideoUploadService,
    getUserVideosService,
    getUserVideoSummariesService,
    deleteVideoService,
    markAnalysisViewedService,
    uploadVideoToTwelveLabsService,
    uploadVideoUrlToTwelveLabsService,
    ensureVideoIndexed,
    waitForAssetReady
} from '../service/video.service.js';
import { transcribeVideoWithPegasus } from '../lib/twelve-labs-analyze.js';
import { getVideoScenes } from '../service/video-scenes.service.js';
import { notifyUserShortsReady } from '../service/notification.service.js';
import { User } from '../model/user.model.js';
import { getVideoFeedbackService } from '../service/video-feedback.service.js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { Video } from '../model/video.model.js';
import { Chat } from '../model/chat.model.js';
import { ANALYSIS_STATUS, allowedFeaturesForPlan, SUBSCRIPTION_PLANS } from '../constants.js';
import { publishVideoAnalysisJob } from '../queue/video.queue.js';
import { isShuttingDown, trackJobStart, trackJobEnd } from '../queue/analysis-runtime.js';
import { createSemaphore } from '../utils/semaphore.js';

/** Concurrent analyses per server instance (each runs ~6 parallel AI calls). */
const analysisGate = createSemaphore(Number(process.env.ANALYSIS_CONCURRENCY) || 8);
export const analysisQueueStats = () => analysisGate.stats();
import { removeUploadedFile } from '../middleware/fileUpload.js';
import { alertFailure } from '../service/ops-monitoring.service.js';
import { startHeartbeat } from '../service/analysis-recovery.service.js';
import { getOrCreateSubscription } from '../service/subscription.service.js';
import { analyzeHook } from '../service/analyzer/hook.analyzer.js';
import { analyzeCaption } from '../service/analyzer/caption.analyzer.js';
import { analyzePacing } from '../service/analyzer/pacing.analyzer.js';
import { analyzeAudio } from '../service/analyzer/audio.analyzer.js';
import { analyzeAdvancedAnalytics } from '../service/analyzer/advanced-analytics.analyzer.js';
import { analyzeViewsPredictor } from '../service/analyzer/views-predictor.analyzer.js';
import { computeRetentionCurve } from '../service/retention-curve.service.js';
import { buildVideoWithAnalysisResponse } from '../service/video-analysis-dto.service.js';
import { predictViewBand, normalizeFollowers, normalizePlatform } from '../service/view-prediction.service.js';
import { buildInitialAnalysisMessage } from '../service/initial-analysis-message.js';
import {
    generateScriptOptions,
    toScriptSuggestionsResponse,
    MAX_SCRIPT_REGENERATIONS,
} from '../service/script-suggestions.service.js';
import { fetchIndexedVideoMedia } from '../service/transcript.service.js';
import { TWELVELABS_USER_INDEX } from '../config/index.js';
import { withAiContext, newTraceId } from '../lib/ai-tracking.js';
import { addSnapshot, deleteSnapshot, setPostDetails, getPerformance } from '../service/performance.service.js';
import { captureServerEvent } from '../lib/analytics.js';
import { buildFeedbackId, buildScriptRewriteId } from '../service/analyzer/feedback-schema.js';

export const getPresignedUploadUrl = async (req, res) => {
    return res.status(410).json(
        ApiResponse.error(
            410,
            'Presigned URL upload flow is no longer supported. Use /videos/upload-file.'
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

        // ?view=summary: list fields only (badge, Home, Library). Default: full documents (chat page).
        const summary = req.query?.view === 'summary';
        const videos = summary
            ? (await getUserVideoSummariesService(userId)).map(({ lastError, ...v }) => {
                const errorSummary = getVideoStatusErrorSummary(v.analysisStatus, lastError);
                return errorSummary ? { ...v, errorSummary } : v;
            })
            : await getUserVideosService(userId);

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

/**
 * Fallback scenes when Twelve Labs' scene breakdown is unavailable: one scene per transcript segment,
 * carrying the real time range and the verbatim words. First segment is the hook, last is the close.
 */
export function buildScenesFromTranscript(rawTranscript) {
    if (!Array.isArray(rawTranscript) || rawTranscript.length === 0) return [];
    const last = rawTranscript.length - 1;
    return rawTranscript.map((segment, index) => ({
        sceneNumber: index + 1,
        startTime: segment.tStart,
        endTime: Math.max(segment.tEnd, segment.tStart),
        visualDescription: '',
        onScreenText: '',
        audioSummary: `Spoken: "${segment.text}"`,
        // Used as the hook text for the first scene, so it carries the actual words.
        primaryAction: `Says "${segment.text}"`,
        emotionalTone: '',
        purpose: index === 0 ? 'hook' : index === last && last > 0 ? 'cta' : 'context',
    }));
}

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

        // Plan is resolved here (not in the service) so a subscription read failure
        // degrades to the Free allowed set — Advanced Analytics feedback is then
        // stripped, matching GET /videos/:videoId.
        let userPlan = SUBSCRIPTION_PLANS.FREE;
        try {
            const subscription = await getOrCreateSubscription(userId);
            if (subscription?.plan) {
                userPlan = subscription.plan;
            }
        } catch {
            // least-privilege: Free allowed set
        }

        const feedback = await getVideoFeedbackService(videoId, userId, userPlan);

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

        let userPlan = SUBSCRIPTION_PLANS.FREE;
        try {
            const subscription = await getOrCreateSubscription(userId);
            if (subscription?.plan) {
                userPlan = subscription.plan;
            }
        } catch {
            // least-privilege: Free allowed set; DTO will strip Pro-only fields
        }

        const payload = buildVideoWithAnalysisResponse(video, userPlan);
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

        // An asset that reached Twelve Labs but never finished indexing can be retried: the job
        // indexes it (or resumes the pending indexing run) before analyzing.
        if (!video.twelveLabsVideoId && !video.twelveLabsAssetId) {
            return res.status(400).json(
                ApiResponse.error(
                    400,
                    'This video never reached Twelve Labs. Please delete it and upload it again.'
                )
            );
        }

        video.analysisStatus = ANALYSIS_STATUS.QUEUED;
        video.lastError = null;
        video.lastErrorAt = null;
        video.analysisAttempts = 0;
        video.analysisHeartbeatAt = null;
        await video.save();

        await publishVideoAnalysisJob({
            videoId: video._id.toString(),
            twelveLabsVideoId: video.twelveLabsVideoId || null,
            twelveLabsAssetId: video.twelveLabsAssetId || null,
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

    // During a deploy this instance is going away: a non-2xx makes QStash retry, and the retry lands
    // on the new instance. The video stays "queued" until then.
    if (isShuttingDown()) {
        console.warn(`[QStash] Shutting down; asking QStash to retry video ${videoId} later`);
        return res.status(503).json({ received: false, retry: true });
    }

    res.status(200).json({ received: true, videoId });
    console.log('[QStash] Acknowledged to QStash, starting background analysis:', videoId);

    // At most ANALYSIS_CONCURRENCY jobs run at once on this instance; the rest wait here still "queued"
    // (the claim below is atomic, so a sweeper re-queue of a waiting job can never run it twice).
    // Every model call in this job is tracked as one AI trace for this user and video (lib/ai-tracking.js).
    const aiContext = { feature: 'video_analysis', videoId, userId, distinctId: userId, traceId: newTraceId(`video-${videoId}`) };
    setImmediate(() => void analysisGate.run(() => withAiContext(aiContext, async () => {
        let video;
        let stopHeartbeat = null;
        try {
            console.log('[QStash] Background analysis started for:', videoId);
            // Waited for a slot while a deploy began: leave it queued for the next instance (sweeper re-queues it).
            if (isShuttingDown()) return;
            try {
                video = await Video.findOneAndUpdate(
                    {
                        _id: videoId,
                        analysisStatus: ANALYSIS_STATUS.QUEUED
                    },
                    { $set: { analysisStatus: ANALYSIS_STATUS.PROCESSING, analysisHeartbeatAt: new Date() } },
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
            trackJobStart(videoId);
            stopHeartbeat = startHeartbeat(videoId);

            if (!video.twelveLabsVideoId && twelveLabsVideoId) {
                video.twelveLabsVideoId = twelveLabsVideoId;
            }

            console.log(`[QStash] Processing analysis for video ${videoId} (asset ${video.twelveLabsAssetId || 'n/a'})`);
            if (userId) {
                console.log(`[QStash] User ID: ${userId}`);
            }

            // Pegasus reads the uploaded asset, which must be `ready` first.
            if (video.twelveLabsAssetId) {
                await waitForAssetReady(video.twelveLabsAssetId, null);
            }

            // Indexing supplies the player stream and the transcript. Since Pegasus 1.5 the analysis itself
            // no longer needs the index, so an indexing failure only loses those extras (when we have an asset).
            let indexedVideoId = video.twelveLabsVideoId || null;
            try {
                indexedVideoId = await ensureVideoIndexed(video);
            } catch (indexError) {
                if (!video.twelveLabsAssetId) throw indexError;
                console.error(`[QStash] Indexing failed for video ${videoId}; analyzing the asset without index extras:`, indexError.message);
            }

            // Transcript + HLS stream from the index (segment-level; source of truth for verbatim quotes).
            let rawTranscript = [];
            let streamUrl = null;
            let thumbnailUrl = null;
            if (indexedVideoId) {
                ({ rawTranscript, streamUrl, thumbnailUrl } = await fetchIndexedVideoMedia(TWELVELABS_USER_INDEX, indexedVideoId));
            }

            // Scene breakdown (Pegasus structured JSON, text breakdown as fallback) and, when the index had
            // no transcription, a Pegasus transcript. Both requested in parallel.
            const pegasusSource = { assetId: video.twelveLabsAssetId, streamUrl: streamUrl || video.streamUrl || null };
            const [sceneResult, pegasusTranscript] = await Promise.all([
                getVideoScenes(pegasusSource),
                rawTranscript.length === 0 ? transcribeVideoWithPegasus(pegasusSource) : Promise.resolve([]),
            ]);
            if (rawTranscript.length === 0 && pegasusTranscript.length > 0) {
                rawTranscript = pegasusTranscript;
                console.log(`[QStash] Using Pegasus transcript (${rawTranscript.length} segments) for video ${videoId}`);
            }

            video.rawTranscript = rawTranscript;
            if (streamUrl) video.streamUrl = streamUrl;
            if (thumbnailUrl) video.thumbnailUrl = thumbnailUrl;
            console.log(`[QStash] Transcript segments: ${rawTranscript.length}, stream URL: ${streamUrl ? 'yes' : 'no'}`);

            let scenes = sceneResult.scenes;
            console.log(`[QStash] Scene breakdown for video ${videoId}: ${scenes.length} scenes via ${sceneResult.via}${sceneResult.error ? ` (${sceneResult.error})` : ''}`);

            video.scenes = scenes;

            // With neither a scene breakdown nor speech there is nothing real to analyze; failing with a
            // clear reason (user can Re-analyze) beats a report of invented feedback.
            if (scenes.length === 0 && rawTranscript.length === 0) {
                throw new Error('Twelve Labs returned no scene breakdown and no transcript for this video.');
            }

            // No scene breakdown but we have speech: build one scene per spoken segment (real times,
            // verbatim words) so every analyzer still has grounded input instead of failing.
            if (scenes.length === 0) {
                scenes = buildScenesFromTranscript(rawTranscript);
                video.scenes = scenes;
                console.warn(`[QStash] Using ${scenes.length} transcript-derived scenes for video ${videoId} (no Twelve Labs scene breakdown)`);
            }

            console.log(`[QStash] Storing ${video.scenes.length} scenes in video document`);
            await video.save();

            const savedVideo = await Video.findById(videoId);
            console.log(`[QStash] Verified: Video document now has ${savedVideo?.scenes?.length || 0} scenes`);

            const selectedFeatures = video.selectedFeatures && video.selectedFeatures.length > 0
                ? video.selectedFeatures
                : ['hook', 'caption', 'pacing', 'audio', 'advanced_analytics', 'views_predictor'];

            // Dispatch-time tier gate (security backstop). Re-validates the
            // feature set against the live subscription — defends against
            // downgrade attacks (user uploads as Pro, downgrades before QStash
            // runs) and any future code path that bypasses the upload-time
            // filter. Silent: skipped analyzers are treated as if never
            // selected (no FAILED stub pushed into video.analysis).
            //
            // Subscription read is wrapped in try/catch — a transient DB blip
            // falls back to the FREE allowed set (least-privilege) rather than
            // accidentally granting Pro features.
            let allowedFeatures;
            try {
                const uploaderId = video.uploader_id || userId;
                const subscription = await getOrCreateSubscription(uploaderId);
                allowedFeatures = allowedFeaturesForPlan(subscription.plan);
            } catch (gateError) {
                console.error(
                    `[QStash] Dispatch-time gate failed to load subscription, defaulting to FREE allowed set:`,
                    gateError.message
                );
                allowedFeatures = allowedFeaturesForPlan(SUBSCRIPTION_PLANS.FREE);
            }
            const gatedFeatures = selectedFeatures.filter(f => allowedFeatures.includes(f));
            const droppedFeatures = selectedFeatures.filter(f => !allowedFeatures.includes(f));
            if (droppedFeatures.length > 0) {
                console.warn(
                    `[QStash] Dispatch-time gate dropped features (plan-based filter): ${droppedFeatures.join(', ')}`
                );
            }

            const hookScene = scenes.find(s => s.purpose?.toLowerCase() === 'hook') || scenes[0];
            // Without a scene breakdown, the opening spoken line is the hook.
            const hook =
                hookScene?.primaryAction ||
                hookScene?.visualDescription ||
                (video.rawTranscript?.[0]?.text ? `Opening line: "${video.rawTranscript[0].text}"` : '');

            video.analysis = [];
            const featureOutputs = {};

            // Frame-level feedback and script rewrites are collected across all
            // analyzers, then re-indexed so ids are unique per video.
            const collectedFrameFeedback = [];
            const collectedScriptRewrites = [];
            const analyzerContext = {
                rawTranscript: video.rawTranscript,
                duration: video.duration || scenes[scenes.length - 1]?.endTime,
                videoId,
            };

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

            // Analyzers are independent, so they run in parallel (results are applied below in the
            // original order). A failing analyzer never fails the video.
            const runAnalyzer = async (feature) => {
                switch (feature) {
                    case 'hook':
                        return hook ? analyzeHook(hook, scenes, analyzerContext) : null;
                    case 'caption':
                        return analyzeCaption(scenes, analyzerContext);
                    case 'pacing':
                        return analyzePacing(scenes, analyzerContext);
                    case 'audio':
                        return analyzeAudio(scenes, analyzerContext);
                    case 'advanced_analytics':
                        return analyzeAdvancedAnalytics(scenes, analyzerContext);
                    case 'views_predictor':
                        return analyzeViewsPredictor(scenes, analyzerContext);
                    default:
                        console.warn(`[QStash] Unknown feature: ${feature}`);
                        return null;
                }
            };
            const settled = await Promise.allSettled(gatedFeatures.map((feature) => runAnalyzer(feature)));

            for (const [index, feature] of gatedFeatures.entries()) {
                try {
                    const outcome = settled[index];
                    if (outcome.status === 'rejected') throw outcome.reason;
                    const analysisResult = outcome.value ?? null;
                    if (analysisResult !== null) featureOutputs[feature] = analysisResult;

                    if (analysisResult !== null) {
                        // Validated frame feedback / rewrites from this analyzer.
                        // Already tagged with `sourceFeature`, so the DTO can strip
                        // advanced-analytics items for Free/Premium.
                        if (Array.isArray(analysisResult.frameFeedback)) {
                            collectedFrameFeedback.push(...analysisResult.frameFeedback);
                        }
                        if (Array.isArray(analysisResult.scriptRewrites)) {
                            collectedScriptRewrites.push(...analysisResult.scriptRewrites);
                        }

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
                    const featureMessage = featureError instanceof Error ? featureError.message : String(featureError);
                    console.error(`[QStash] Error analyzing feature ${feature}:`, featureMessage);
                    featureOutputs[feature] = {
                        error: `Analysis failed: ${featureMessage}`
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

            // Re-index ids across analyzers (each analyzer numbers from 1) and order
            // by time so the report reads top-to-bottom through the video.
            video.timestampFeedback = collectedFrameFeedback
                .sort((a, b) => a.tStart - b.tStart || b.severity - a.severity)
                .map((item, index) => ({ ...item, id: buildFeedbackId(index) }));

            video.scriptRewrites = collectedScriptRewrites
                .sort((a, b) => a.timestamp - b.timestamp)
                .map((item, index) => ({ ...item, lineId: buildScriptRewriteId(index) }));

            console.log(
                `[QStash] Stored ${video.timestampFeedback.length} frame feedback items and ${video.scriptRewrites.length} script rewrites for ${videoId}`
            );

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

            // Predicted views from the best evidence available: comparable real results scaled to the
            // creator's followers, a follower-based estimate, or the model's band capped by the score.
            if (video.predictedViewsLow != null || video.predictedViewsHigh != null || video.creatorFollowers) {
                const views = await predictViewBand({
                    viralityScore: video.viralityScore,
                    followers: video.creatorFollowers,
                    platform: video.creatorPlatform,
                    modelBand: { low: video.predictedViewsLow, expected: video.predictedViewsExpected, high: video.predictedViewsHigh },
                    excludeVideoId: video._id,
                });
                console.log(`[Analysis] Views for ${videoId} via ${views.method} (${views.comparables} comparables): ${views.low}-${views.high}, expected ${views.expected}`);
                video.predictedViewsLow = views.low;
                video.predictedViewsExpected = views.expected;
                video.predictedViewsHigh = views.high;
                video.viewPredictionMethod = views.method;
                video.viewPredictionComparables = views.comparables;
            }

            video.retentionCurve = computeRetentionCurve(video);

            const nullScoreFeatures = video.analysis.filter(a => a.score == null).map(a => a.feature);
            if (nullScoreFeatures.length > 0) {
                console.warn('[Analysis] Null score persisted for features:', nullScoreFeatures);
            }

            video.analysisStatus = ANALYSIS_STATUS.COMPLETED;
            video.isAnalysisReady = true;
            video.analysisHeartbeatAt = null;
            video.analysisAttempts = 0;
            await video.save();

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
                    v.analysisHeartbeatAt = null;
                    await v.save();
                    console.log('[QStash] Video marked as failed in DB:', videoId);
                }
                void alertFailure({ stage: 'analysis', videoId, userId: userId || v?.uploader_id, error: bgError });
            } catch (saveErr) {
                console.error('[QStash] Failed to save error state:', saveErr.message);
            }
        } finally {
            if (stopHeartbeat) stopHeartbeat();
            trackJobEnd(videoId);
        }
    })));
};

export const uploadVideoToTwelveLabs = async (req, res, next) => {
    try {
        const userId = req.user._id;
        const file = req.file || req.files?.file;

        if (!file) {
            throw new ApiError(400, 'Video file is required');
        }

        // Use original filename from multer if available, otherwise from body
        const filename = file.originalname || req.body.filename;
        const { selectedFeatures } = req.body;

        if (!filename) {
            throw new ApiError(400, 'Filename is required');
        }

        // Log file info for debugging
        console.log(`📁 File received: ${filename}, size: ${file.size}, mimetype: ${file.mimetype}, stored ${file.path ? 'on disk' : 'in memory'}`);

        const selectedFeaturesArray = selectedFeatures
            ? (Array.isArray(selectedFeatures) ? selectedFeatures : JSON.parse(selectedFeatures))
            : [];

        // Pass the entire file object so service can handle buffer/stream conversion
        const video = await uploadVideoToTwelveLabsService(
            userId,
            file,
            filename,
            selectedFeaturesArray,
            { platform: req.body.platform, followers: req.body.followers }
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
    } finally {
        // The file is on Twelve Labs (or the upload failed): the temp copy is no longer needed.
        await removeUploadedFile(req.file || req.files?.file);
    }
};

export const uploadVideoUrlToTwelveLabs = async (req, res, next) => {
    return res.status(410).json(
        ApiResponse.error(
            410,
            'URL-based video upload is no longer supported. Please upload your video file directly.'
        )
    );

    // Original handler preserved below for trivial restorability if the URL
    // ingest flow is ever revived. Unreachable while the early 410 return
    // above stands; do not rely on this path without re-enabling the route.
    /* eslint-disable no-unreachable */
    if (false) {
        try {
            const { url, filename, selectedFeatures } = req.body;
            const userId = req.user._id;

            if (!url || !filename) {
                throw new ApiError(400, 'URL and filename are required');
            }

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
    }
    /* eslint-enable no-unreachable */
};

// ─── Scripts tab ───────────────────────────────────────────────────────────

/** Videos with a script generation in flight on this instance (stops double-clicks from paying twice). */
const scriptGenerationsInFlight = new Set();

export const getScriptSuggestions = async (req, res, next) => {
    try {
        const { videoId } = req.params;
        const video = await Video.findOne({ _id: videoId, uploader_id: req.user._id }).select('scriptSuggestions').lean();
        if (!video) {
            throw new ApiError(404, 'Video not found');
        }
        res.status(200).json(
            ApiResponse.success(200, 'Script suggestions retrieved', toScriptSuggestionsResponse(video.scriptSuggestions))
        );
    } catch (error) {
        next(error);
    }
};

export const createScriptSuggestions = async (req, res, next) => {
    const { videoId } = req.params;
    const regenerate = req.body?.regenerate === true;
    let locked = false;
    try {
        const video = await Video.findOne({ _id: videoId, uploader_id: req.user._id });
        if (!video) {
            throw new ApiError(404, 'Video not found');
        }
        if (video.analysisStatus !== ANALYSIS_STATUS.COMPLETED) {
            throw new ApiError(409, 'Scripts are available once the analysis has finished.');
        }
        if ((video.scenes || []).length === 0 && (video.rawTranscript || []).length === 0) {
            throw new ApiError(409, 'This video has no scene breakdown or transcript to write scripts from. Re-analyze it first.');
        }

        const existing = video.scriptSuggestions;
        const hasExisting = Array.isArray(existing?.options) && existing.options.length > 0;
        if (hasExisting && !regenerate) {
            return res.status(200).json(ApiResponse.success(200, 'Script suggestions retrieved', toScriptSuggestionsResponse(existing)));
        }
        const generationCount = existing?.generationCount ?? 0;
        if (hasExisting && generationCount - 1 >= MAX_SCRIPT_REGENERATIONS) {
            throw new ApiError(429, `You have used all ${MAX_SCRIPT_REGENERATIONS} script refreshes for this video.`);
        }

        if (scriptGenerationsInFlight.has(videoId)) {
            throw new ApiError(409, 'Scripts are already being written for this video. Give it a few seconds.');
        }
        scriptGenerationsInFlight.add(videoId);
        locked = true;

        const { targetSeconds, options } = await withAiContext(
            { feature: 'scripts', videoId, userId: req.user._id, distinctId: req.user._id, traceId: newTraceId(`scripts-${videoId}`) },
            () => generateScriptOptions(video)
        );
        video.scriptSuggestions = {
            generatedAt: new Date(),
            generationCount: generationCount + 1,
            targetSeconds,
            options,
        };
        await video.save();

        res.status(200).json(
            ApiResponse.success(200, 'Script suggestions generated', toScriptSuggestionsResponse(video.scriptSuggestions))
        );
    } catch (error) {
        if (!(error instanceof ApiError)) {
            console.error(`[Scripts] Generation failed for video ${videoId}:`, error?.message);
            return next(new ApiError(502, 'We could not write scripts right now. Try again in a moment.'));
        }
        next(error);
    } finally {
        if (locked) scriptGenerationsInFlight.delete(videoId);
    }
};

// ─── Real results ──────────────────────────────────────────────────────────

/**
 * The creator reports how many views the video actually got. Kept for older clients: it now appends
 * a performance snapshot (service/performance.service.js), which also keeps actualViews in sync.
 */
export const reportActualViews = async (req, res, next) => {
    try {
        const result = await addSnapshot(req.user._id, req.params.videoId, {
            views: req.body?.views,
            platform: req.body?.platform,
            followers: req.body?.followers,
        });
        res.status(200).json(ApiResponse.success(200, 'Thanks, your result was saved', result));
    } catch (error) {
        next(error);
    }
};

/** Analytics tab: post date / URL / platform for a video. */
export const updateVideoPost = async (req, res, next) => {
    try {
        const result = await setPostDetails(req.user._id, req.params.videoId, req.body ?? {});
        res.status(200).json(ApiResponse.success(200, 'Post details saved', result));
    } catch (error) {
        next(error);
    }
};

export const getVideoPerformance = async (req, res, next) => {
    try {
        res.status(200).json(ApiResponse.success(200, 'Performance retrieved', await getPerformance(req.user._id, req.params.videoId)));
    } catch (error) {
        next(error);
    }
};

export const createPerformanceSnapshot = async (req, res, next) => {
    try {
        const result = await addSnapshot(req.user._id, req.params.videoId, req.body ?? {});
        captureServerEvent(String(req.user._id), 'results_logged', { videoId: req.params.videoId, snapshots: result.snapshots.length });
        res.status(201).json(ApiResponse.success(201, 'Result saved', result));
    } catch (error) {
        next(error);
    }
};

export const removePerformanceSnapshot = async (req, res, next) => {
    try {
        const result = await deleteSnapshot(req.user._id, req.params.videoId, req.params.snapshotId);
        res.status(200).json(ApiResponse.success(200, 'Entry removed', result));
    } catch (error) {
        next(error);
    }
};
