/**
 * Learning engine stores (docs/learning-engine/PLAN.md, section 5.1).
 *
 *   VideoFeatures    one shared description per analyzed video, whatever its source
 *   OutcomeSnapshot  a real measurement of a video's results at a point in time
 *   SocialCreator    a public creator we track (baseline = their typical views)
 *   SocialVideo      a public video collected from the data provider
 *   LearningRun      one run of the daily learning job, with its report card
 *
 * Subjects: 'video' = a user's upload (Video), 'dataset' = admin viral example
 * (VideoPerformanceDataset), 'social' = SocialVideo.
 */
import mongoose from 'mongoose';

export const SUBJECT_TYPES = Object.freeze(['video', 'dataset', 'social']);
export const OUTCOME_SOURCES = Object.freeze(['user_reported', 'api_verified', 'provider', 'dataset']);

const videoFeaturesSchema = new mongoose.Schema({
    subjectType: { type: String, enum: SUBJECT_TYPES, required: true },
    subjectId: { type: mongoose.Schema.Types.ObjectId, required: true },
    /** Owner of a user upload (so deleting or opting out can remove it). */
    userId: { type: mongoose.Schema.Types.ObjectId, default: null },
    /** Groups videos by the same creator: user:<id>, social:<platform>:<id>, handle:<handle>. */
    creatorKey: { type: String, default: null },
    platform: { type: String, default: null },
    featureVersion: { type: Number, required: true },
    /** Flat map of numeric / categorical features (features.js). */
    features: { type: mongoose.Schema.Types.Mixed, default: {} },
    taxonomyVersion: { type: Number, default: null },
    niche: { type: String, default: null },
    subNiche: { type: String, default: null },
    format: { type: String, default: null },
    hookPattern: { type: String, default: null },
    labelConfidence: { type: Number, default: null },
    labelSource: { type: String, enum: ['ai', 'creator_profile', 'admin', 'strategy', null], default: null },
    followers: { type: Number, default: null },
    postedAt: { type: Date, default: null },
    extractedAt: { type: Date, default: Date.now },
}, { timestamps: true });
videoFeaturesSchema.index({ subjectType: 1, subjectId: 1 }, { unique: true });
videoFeaturesSchema.index({ niche: 1, format: 1 });
videoFeaturesSchema.index({ creatorKey: 1 });
videoFeaturesSchema.index({ taxonomyVersion: 1 });

const outcomeSnapshotSchema = new mongoose.Schema({
    subjectType: { type: String, enum: SUBJECT_TYPES, required: true },
    subjectId: { type: mongoose.Schema.Types.ObjectId, required: true },
    creatorKey: { type: String, default: null },
    platform: { type: String, default: null },
    capturedAt: { type: Date, required: true },
    /** Hours since posting when measured; null when the post time is unknown. */
    ageHours: { type: Number, default: null },
    views: { type: Number, required: true, min: 0 },
    likes: { type: Number, default: null },
    comments: { type: Number, default: null },
    shares: { type: Number, default: null },
    saves: { type: Number, default: null },
    followers: { type: Number, default: null },
    source: { type: String, enum: OUTCOME_SOURCES, required: true },
    /** Idempotency key within a subject (e.g. the performance snapshot id, or provider + capture day). */
    sourceRef: { type: String, required: true },
}, { timestamps: true });
outcomeSnapshotSchema.index({ subjectType: 1, subjectId: 1, sourceRef: 1 }, { unique: true });
outcomeSnapshotSchema.index({ creatorKey: 1, capturedAt: -1 });
outcomeSnapshotSchema.index({ source: 1, capturedAt: -1 });

const socialCreatorSchema = new mongoose.Schema({
    platform: { type: String, required: true },
    externalId: { type: String, required: true },
    handle: { type: String, default: null },
    followers: { type: Number, default: null },
    followersAt: { type: Date, default: null },
    niche: { type: String, default: null },
    /** Median views of their settled videos (7+ days old). */
    baselineViews: { type: Number, default: null },
    baselineN: { type: Number, default: 0 },
    baselineAt: { type: Date, default: null },
    backfilledAt: { type: Date, default: null },
    provider: { type: String, default: null },
}, { timestamps: true });
socialCreatorSchema.index({ platform: 1, externalId: 1 }, { unique: true });

const socialVideoSchema = new mongoose.Schema({
    platform: { type: String, required: true },
    externalId: { type: String, required: true },
    creatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialCreator', default: null },
    creatorExternalId: { type: String, default: null },
    url: { type: String, default: null },
    caption: { type: String, default: null, maxlength: 2200 },
    hashtags: { type: [String], default: [] },
    soundId: { type: String, default: null },
    soundTitle: { type: String, default: null },
    durationSec: { type: Number, default: null },
    postedAt: { type: Date, default: null },
    region: { type: String, default: null },
    language: { type: String, default: null },
    provider: { type: String, required: true },
    discoveredVia: { type: String, enum: ['search', 'creator_backfill', 'trending'], required: true },
    query: { type: String, default: null },
    nicheHint: { type: String, default: null },
    latest: {
        type: new mongoose.Schema({ views: Number, likes: Number, comments: Number, shares: Number, saves: Number, at: Date }, { _id: false }),
        default: undefined,
    },
    checks: { type: Number, default: 0 },
    lastCheckedAt: { type: Date, default: null },
    /** When the re-checker should read its numbers again (null = done). */
    nextCheckAt: { type: Date, default: null },
}, { timestamps: true });
socialVideoSchema.index({ platform: 1, externalId: 1 }, { unique: true });
socialVideoSchema.index({ nextCheckAt: 1 });
socialVideoSchema.index({ creatorId: 1, postedAt: -1 });

const learningRunSchema = new mongoose.Schema({
    kind: { type: String, default: 'daily' },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    ok: { type: Boolean, default: null },
    provider: { type: String, default: null },
    recordsUsed: { type: Number, default: 0 },
    steps: {
        type: [new mongoose.Schema({
            name: String, ok: Boolean, ms: Number, detail: String, counts: mongoose.Schema.Types.Mixed,
        }, { _id: false })],
        default: [],
    },
    inventory: { type: mongoose.Schema.Types.Mixed, default: null },
    reportCard: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true });
learningRunSchema.index({ startedAt: -1 });

export const VideoFeatures = mongoose.model('VideoFeatures', videoFeaturesSchema);
export const OutcomeSnapshot = mongoose.model('OutcomeSnapshot', outcomeSnapshotSchema);
export const SocialCreator = mongoose.model('SocialCreator', socialCreatorSchema);
export const SocialVideo = mongoose.model('SocialVideo', socialVideoSchema);
export const LearningRun = mongoose.model('LearningRun', learningRunSchema);
