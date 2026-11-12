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
    /** Set when creator file ingest completes successfully */
    uploadedAt: { type: Date },

    // Editor tab: what this viral example teaches about editing (computed at ingest from the file).
    niche: { type: String },
    followers: { type: Number },
    likes: { type: Number },
    comments: { type: Number },
    shares: { type: Number },
    saves: { type: Number },
    editProfile: {
        type: new mongoose.Schema({
            avgShotSec: Number,
            cutsPerMin: Number,
            speechWpm: Number,
            pauseRatio: Number,
            durationSec: Number,
            aspect: String,
            captionStyle: String,
            captionDensity: String,
            zoomsPerMin: Number,
            textOverlayUse: String,
            hookPattern: String,
            hookFirst2s: String,
            musicPresence: String,
            sfxUse: String,
            pacingNotes: String,
            summary: String,
            profiledAt: Date,
        }, { _id: false }),
        default: undefined,
    },
    editProfileStatus: { type: String, enum: ['none', 'pending', 'ready', 'failed'], default: 'none' },
    /** Private storage key of the uploaded file, kept so the profile can be rebuilt. */
    editorSourceKey: { type: String },
    editProfileError: { type: String },
    /** Embedding of editProfile.summary + niche, ranked in memory (the dataset is small). */
    editEmbedding: { type: [Number], default: undefined, select: false },
}, { timestamps: true });

export const VideoPerformanceDataset = mongoose.model(
    'VideoPerformanceDataset',
    videoPerformanceDatasetSchema
);
