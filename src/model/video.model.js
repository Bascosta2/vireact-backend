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
            analyzedAt: {
                type: Date,
                default: Date.now
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
    uploader_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    }
}, { timestamps: true });

export const Video = mongoose.model('Video', videoSchema);

