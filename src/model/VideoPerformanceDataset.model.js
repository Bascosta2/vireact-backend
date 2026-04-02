import mongoose from 'mongoose';

const videoPerformanceDatasetSchema = new mongoose.Schema({
    sourceType: {
        type: String,
        enum: ['own_video', 'creator_video'],
        required: true,
    },
    videoUrl: { type: String },
    filename: { type: String },
    twelveLabsAssetId: { type: String },
    twelveLabsVideoId: { type: String },
    creatorHandle: { type: String },
    subscriberCount: { type: Number },
    viralCategory: {
        type: String,
        enum: [
            'hook_driven',
            'trend_based',
            'educational',
            'emotional',
            'comedic',
            'informational',
        ],
    },
    platform: {
        type: String,
        enum: ['tiktok', 'instagram', 'youtube', 'facebook'],
        required: true,
    },
    niche: { type: String, required: true },
    creatorSize: {
        type: String,
        enum: ['micro', 'small', 'medium', 'large', 'mega'],
    },
    postedAt: { type: Date },
    actualViews: { type: Number, required: true },
    // retention can exceed 100% on very short videos (e.g. 13s) due to replays — this is valid and meaningful signal.
    retentionRate: { type: Number, min: 0 },
    likeRate: { type: Number },
    shareRate: { type: Number },
    commentRate: { type: Number },
    followRate: { type: Number },
    swipeRate: { type: Number }, // % of users who swiped in first 1-3s and stayed past hook
    durationSeconds: { type: Number },
    viralityScore: { type: Number },
    hookScore: { type: Number },
    pacingScore: { type: Number },
    audioScore: { type: Number },
    captionScore: { type: Number },
    viewsPredictorScore: { type: Number },
    scenes: { type: Array, default: [] },
    analysis: { type: Array, default: [] },
    status: {
        type: String,
        enum: ['pending', 'processing', 'complete', 'failed'],
        default: 'pending',
    },
    errorMessage: { type: String },
    ingestedAt: { type: Date, default: Date.now },
    analyzedAt: { type: Date },
}, { timestamps: true });

export const VideoPerformanceDataset = mongoose.model(
    'VideoPerformanceDataset',
    videoPerformanceDatasetSchema
);
