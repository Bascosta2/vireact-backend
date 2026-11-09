import mongoose from 'mongoose';
import { UPLOAD_STATUS, ANALYSIS_STATUS } from '../constants.js';
import {
    frameFeedbackSchema,
    scriptRewriteSchema,
    transcriptSegmentSchema
} from './frame-feedback.schema.js';

const videoSchema = new mongoose.Schema({
    s3Key: {
        type: String,
    },
    s3_url: {
        type: String,
    },
    filename: {
        type: String,
        required: true
    },
    fileSize: {
        type: Number,
        required: true
    },
    duration: {
        type: Number
    },
    uploadStatus: {
        type: String,
        enum: Object.values(UPLOAD_STATUS),
        default: UPLOAD_STATUS.PENDING,
        required: true
    },
    selectedFeatures: {
        type: [String],
        default: []
    },
    analysisStatus: {
        type: String,
        enum: Object.values(ANALYSIS_STATUS),
        default: ANALYSIS_STATUS.PENDING,
        required: true
    },
    /** Creator context given at upload, used to size predicted views (see view-prediction.service.js). */
    creatorPlatform: {
        type: String,
        enum: ['tiktok', 'instagram', 'youtube', 'facebook', 'other', null],
        default: null
    },
    creatorFollowers: {
        type: Number,
        default: null,
        min: 0
    },
    /** How predictedViews* were produced: score (capped model guess), followers (heuristic) or dataset. */
    viewPredictionMethod: {
        type: String,
        enum: ['score', 'followers', 'dataset', null],
        default: null
    },
    viewPredictionComparables: {
        type: Number,
        default: null
    },
    /** Real result the creator reported after posting; feeds future predictions. */
    actualViews: {
        type: Number,
        default: null,
        min: 0
    },
    actualViewsReportedAt: {
        type: Date,
        default: null
    },
    /** When and where the creator posted it (Analytics tab). */
    postedAt: {
        type: Date,
        default: null
    },
    postUrl: {
        type: String,
        default: null,
        maxlength: 500
    },
    /**
     * Real results over time (24h, 7d, 30d...). actualViews / actualViewsReportedAt always mirror the
     * newest snapshot (see service/performance.service.js), so older prediction code keeps working.
     */
    performanceSnapshots: {
        type: [{
            capturedAt: { type: Date, required: true },
            views: { type: Number, required: true, min: 0 },
            likes: { type: Number, default: null, min: 0 },
            comments: { type: Number, default: null, min: 0 },
            shares: { type: Number, default: null, min: 0 },
            saves: { type: Number, default: null, min: 0 },
            source: { type: String, enum: ['manual', 'tiktok', 'instagram', 'youtube'], default: 'manual' }
        }],
        default: []
    },
    /** Cached AI tags used by the content strategy (filled lazily, see content-strategy.service.js). */
    contentProfile: {
        type: new mongoose.Schema({
            topic: String,
            format: String,
            hookType: String,
            profiledAt: Date
        }, { _id: false }),
        default: undefined
    },
    /** Automatic recovery attempts after a job was interrupted (see analysis-recovery.service.js). */
    analysisAttempts: {
        type: Number,
        default: 0
    },
    /** Written every minute while an analysis runs; a stale value means the job died. */
    analysisHeartbeatAt: {
        type: Date,
        default: null
    },
    isAnalysisReady: {
        type: Boolean,
        default: false
    },
    scenes: {
        type: [{
            sceneNumber: {
                type: Number,
                required: true
            },
            startTime: {
                type: Number,
                required: true
            },
            endTime: {
                type: Number,
                required: true
            },
            visualDescription: {
                type: String
            },
            onScreenText: {
                type: String
            },
            audioSummary: {
                type: String
            },
            primaryAction: {
                type: String
            },
            emotionalTone: {
                type: String
            },
            purpose: {
                type: String
            }
        }],
        default: []
    },
    analysis: {
        type: [{
            feature: {
                type: String,
                required: true,
                enum: ['hook', 'caption', 'pacing', 'audio', 'advanced_analytics', 'views_predictor']
            },
            score: {
                type: Number,
                min: 0,
                max: 100
            },
            rating: {
                type: String
            },
            feedback: {
                type: String
            },
            suggestions: {
                type: [String],
                default: []
            },
            emotionalTriggers: {
                type: [String],
            },
            retentionDrivers: {
                type: [String],
            },
            psychologicalProfile: {
                type: String,
            },
            weakestMoment: {
                type: String,
            },
            analyzedAt: {
                type: Date,
                default: Date.now
            }
        }],
        default: []
    },
    viralityScore: {
        type: Number,
        min: 0,
        max: 100
    },
    predictedViewsLow: {
        type: Number
    },
    predictedViewsHigh: {
        type: Number
    },
    predictedViewsExpected: {
        type: Number
    },
    retentionCurve: {
        type: [Number],
        default: []
    },
    // CHANGED: 2026-09 — freeform prose feedback replaced by FrameFeedback.
    // Every item carries a real time range, a concrete observation, and a literal
    // drop-in fix. Produced by the analyzers via OpenAI structured outputs and
    // gated by `analyzer/feedback-validator.js` before persistence.
    timestampFeedback: {
        type: [frameFeedbackSchema],
        default: []
    },
    /**
     * Pre-2026-09 prose feedback, preserved read-only by the forward-only
     * migration (`migrate-frame-feedback.js`) so historical videos keep
     * rendering without a bulk re-analysis. Never written by new code.
     */
    timestampFeedbackLegacy: {
        type: [{
            timestamp: { type: Number },
            endTimestamp: { type: Number },
            category: { type: String },
            severity: { type: String },
            issue: { type: String },
            suggestion: { type: String },
            example: { type: String }
        }],
        default: []
    },
    /**
     * Literal line rewrites, separate from general frame feedback.
     * `originalTranscript` is always quoted verbatim from `rawTranscript`.
     */
    scriptRewrites: {
        type: [scriptRewriteSchema],
        default: []
    },
    /**
     * Timestamped transcript from Twelve Labs. SEGMENT-level granularity
     * (`{ start, end, value }` is the SDK ceiling — not word-level), and the
     * single source of truth for every verbatim "before" field downstream.
     */
    /**
     * Full alternative scripts for the Scripts tab, generated on demand (not by the analysis job) and
     * cached here. `generationCount` bounds regenerations per video.
     */
    scriptSuggestions: {
        type: new mongoose.Schema({
            generatedAt: { type: Date },
            generationCount: { type: Number, default: 0 },
            targetSeconds: { type: Number },
            options: {
                type: [new mongoose.Schema({
                    id: { type: String, required: true },
                    title: { type: String, required: true },
                    angle: { type: String },
                    hookLine: { type: String },
                    beats: {
                        type: [new mongoose.Schema({
                            tStart: { type: Number, required: true },
                            tEnd: { type: Number, required: true },
                            say: { type: String, default: '' },
                            onScreenText: { type: String, default: '' },
                            visual: { type: String, default: '' },
                        }, { _id: false })],
                        default: [],
                    },
                    cta: { type: String },
                    whyItWorks: { type: String },
                }, { _id: false })],
                default: [],
            },
        }, { _id: false }),
        default: null,
    },
    rawTranscript: {
        type: [transcriptSegmentSchema],
        default: []
    },
    /** Twelve Labs HLS stream URL (indexing sets enableVideoStream) for click-to-seek playback. */
    streamUrl: {
        type: String,
        default: null
    },
    /** Twelve Labs generated thumbnail, when the stream encode provides one. */
    thumbnailUrl: {
        type: String,
        default: null
    },
    twelveLabsAssetId: {
        type: String,
        default: null,
        index: true,
        sparse: true
    },
    /**
     * Indexed-asset id while Twelve Labs indexing is still running (background job). Lets a retried
     * job resume the same indexing run instead of indexing the asset twice. Cleared when ready.
     */
    twelveLabsPendingIndexId: {
        type: String,
        default: null
    },
    twelveLabsVideoId: {
        type: String,
        default: null,
        index: true, // Add index for faster queries
        sparse: true // Allow null values but index non-null values
    },
    lastError: {
        type: String,
        default: null
    },
    lastErrorAt: {
        type: Date,
        default: null
    },
    uploader_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    /** Original pasted URL when ingest used server-side social download */
    sourceUrl: {
        type: String,
        default: null,
    },
    /** Platform title from yt-dlp metadata when available */
    sourceTitle: {
        type: String,
        default: null,
    },
    /** Platform description/caption from yt-dlp metadata when available */
    sourceDescription: {
        type: String,
        default: null,
    },
}, { timestamps: true });

videoSchema.index({ uploader_id: 1, createdAt: -1 });
videoSchema.index({ uploader_id: 1, postedAt: -1 });
// Stuck-analysis sweeper (every 5 minutes) and ops stats filter on status, then age.
videoSchema.index({ analysisStatus: 1, updatedAt: 1 });

export const Video = mongoose.model('Video', videoSchema);
