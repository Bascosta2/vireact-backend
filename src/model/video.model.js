import mongoose from 'mongoose';
import { UPLOAD_STATUS, ANALYSIS_STATUS } from '../constants.js';

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
    timestampFeedback: {
        type: [{
            timestamp: {
                type: Number,
                required: true
            },
            endTimestamp: {
                type: Number
            },
            category: {
                type: String,
                enum: ['pacing', 'visual', 'audio', 'engagement', 'hook', 'cta'],
                required: true
            },
            severity: {
                type: String,
                enum: ['critical', 'important', 'minor'],
                required: true
            },
            issue: {
                type: String,
                required: true
            },
            suggestion: {
                type: String,
                required: true
            },
            example: {
                type: String
            }
        }],
        default: []
    },
    twelveLabsAssetId: {
        type: String,
        default: null,
        index: true,
        sparse: true
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

export const Video = mongoose.model('Video', videoSchema);

