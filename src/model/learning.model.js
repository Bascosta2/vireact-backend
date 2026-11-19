/**
 * Learning engine stores (docs/learning-engine/PLAN.md, section 5.1).
 *
 *   VideoFeatures    one shared description per analyzed video, whatever its source
 *   OutcomeSnapshot  a real measurement of a video's results at a point in time
 *   SocialCreator    a public creator we track (baseline = their typical views)
 *   SocialVideo      a public video collected from the data provider
 *   LearningRun      one run of the daily learning job, with its report card
 *   SocialVideoAnalysis  deep analysis of a public video: measured cuts, Twelve Labs scenes and
 *                    transcript, and the shot-by-shot timeline
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
    /** Set when a public video's features include the deep (Twelve Labs + measured cuts) analysis. */
    deepAt: { type: Date, default: null },
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
    /** TikTok's auto-captions (what is said, timed), from the full Posts dataset. */
    captions: { type: [new mongoose.Schema({ text: String, tStart: Number, tEnd: Number }, { _id: false })], default: undefined },
    captionsLang: { type: String, default: null },
    /** Top comments by likes: text and counts only, never shown to users. */
    topComments: { type: [new mongoose.Schema({ text: String, likes: Number, replies: Number, at: Date }, { _id: false })], default: undefined },
    /** Share of top comments per intent (comments.js). A result, never a model input. */
    commentIntents: { type: mongoose.Schema.Types.Mixed, default: null },
    /** Deep analysis state (the analysis itself is in SocialVideoAnalysis). */
    deep: {
        type: new mongoose.Schema({ status: { type: String, enum: ['done', 'failed'] }, at: Date, error: String, role: String }, { _id: false }),
        default: undefined,
    },
}, { timestamps: true });
socialVideoSchema.index({ platform: 1, externalId: 1 }, { unique: true });
socialVideoSchema.index({ nextCheckAt: 1 });
socialVideoSchema.index({ creatorId: 1, postedAt: -1 });

/**
 * Deep analysis of one public video (deep-analyzer.js): exact cuts measured by ffmpeg, the Twelve Labs
 * scene breakdown and transcript, and the timeline that lines them up shot by shot. The video file itself
 * is never kept: it is deleted locally and from Twelve Labs once analyzed.
 */
const socialVideoAnalysisSchema = new mongoose.Schema({
    socialVideoId: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialVideo', required: true },
    platform: { type: String, default: 'tiktok' },
    externalId: { type: String, required: true },
    creatorId: { type: mongoose.Schema.Types.ObjectId, ref: 'SocialCreator', default: null },
    niche: { type: String, default: null },
    /** Why it was picked: the creator's best ('hit') or worst ('miss') video, compared with their baseline. */
    role: { type: String, enum: ['hit', 'miss', 'viral', 'other'], default: 'other' },
    views: { type: Number, default: null },
    baselineViews: { type: Number, default: null },
    outperformance: { type: Number, default: null },
    /** 'download' = file measured here (exact cuts); 'url' = Twelve Labs fetched it (scene times only). */
    via: { type: String, enum: ['download', 'url'], required: true },
    cutsSource: { type: String, enum: ['ffmpeg', 'pegasus'], required: true },
    model: { type: String, default: null },
    media: { type: mongoose.Schema.Types.Mixed, default: {} },
    cuts: { type: [Number], default: [] },
    silences: { type: [new mongoose.Schema({ start: Number, end: Number }, { _id: false })], default: [] },
    scenes: { type: [mongoose.Schema.Types.Mixed], default: [] },
    transcript: { type: [new mongoose.Schema({ text: String, tStart: Number, tEnd: Number }, { _id: false })], default: [] },
    timeline: { type: [mongoose.Schema.Types.Mixed], default: [] },
    features: { type: mongoose.Schema.Types.Mixed, default: {} },
    /** The hook-frame description (hook-vision.js), closed-list answers. */
    hookVision: { type: mongoose.Schema.Types.Mixed, default: null },
    language: { type: String, default: null },
    ms: { type: Number, default: null },
    analyzedAt: { type: Date, default: Date.now },
}, { timestamps: true });
socialVideoAnalysisSchema.index({ socialVideoId: 1 }, { unique: true });
socialVideoAnalysisSchema.index({ creatorId: 1 });
socialVideoAnalysisSchema.index({ analyzedAt: -1 });

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
/** A sound's recent use in collected public videos and how those videos did (trends.js). */
const soundTrendSchema = new mongoose.Schema({
    soundId: { type: String, required: true },
    title: { type: String, default: null },
    last14: Number,
    prior14: Number,
    uses56: Number,
    medianOutperformance: Number,
    measured: Number,
    stage: { type: String, enum: ['emerging', 'rising', 'peak', 'fading'] },
    updatedAt: Date,
});
soundTrendSchema.index({ soundId: 1 }, { unique: true });
soundTrendSchema.index({ stage: 1, last14: -1 });

/**
 * A confirmed factor (insights.js): within-creator hit-vs-miss evidence that passed the sign test, per niche
 * ('all' = every niche). Only these reach the analyzers.
 */
const learningInsightSchema = new mongoose.Schema({
    niche: { type: String, required: true },
    feature: { type: String, required: true },
    pairs: Number,
    hitHigherShare: Number,
    p: Number,
    medianHit: Number,
    medianMiss: Number,
    correlation: Number,
    /** Coefficient from the within-creator matrix model, when it agrees in sign (model/trainer.js). */
    modelEffect: { type: Number, default: null },
    updatedAt: Date,
});
learningInsightSchema.index({ niche: 1, feature: 1 }, { unique: true });

/**
 * One trained model or analysis run of the matrix engine (model/trainer.js): metrics on held-out creators,
 * coefficients, the partial-correlation network, style components. status: candidate | shadow | champion | retired.
 */
const learningModelSchema = new mongoose.Schema({
    kind: { type: String, required: true },
    version: { type: Number, required: true },
    status: { type: String, enum: ['candidate', 'shadow', 'champion', 'retired'], default: 'candidate' },
    trainedAt: { type: Date, default: Date.now },
    n: Number,
    p: Number,
    creators: Number,
    columns: [String],
    standardization: mongoose.Schema.Types.Mixed,
    lambda: Number,
    coefficients: mongoose.Schema.Types.Mixed,
    metrics: mongoose.Schema.Types.Mixed,
    network: mongoose.Schema.Types.Mixed,
    components: mongoose.Schema.Types.Mixed,
    weights: mongoose.Schema.Types.Mixed,
    promotion: mongoose.Schema.Types.Mixed,
    notes: [String],
}, { timestamps: true });
learningModelSchema.index({ kind: 1, trainedAt: -1 });
learningModelSchema.index({ status: 1, kind: 1 });

export const LearningRun = mongoose.model('LearningRun', learningRunSchema);
export const SoundTrend = mongoose.model('SoundTrend', soundTrendSchema);
export const LearningInsight = mongoose.model('LearningInsight', learningInsightSchema);
export const LearningModel = mongoose.model('LearningModel', learningModelSchema);
export const SocialVideoAnalysis = mongoose.model('SocialVideoAnalysis', socialVideoAnalysisSchema);
