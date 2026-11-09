import mongoose from 'mongoose';

export const STRATEGY_STATUS = Object.freeze({ GENERATING: 'generating', READY: 'ready', FAILED: 'failed' });
export const SLOT_STATUS = Object.freeze(['planned', 'posted', 'skipped']);

const evidenceItem = new mongoose.Schema({
    point: String,
    metric: String,
    evidenceVideoIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Video' }],
}, { _id: false });

const slotSchema = new mongoose.Schema({
    id: { type: String, required: true },
    date: { type: String, required: true }, // YYYY-MM-DD in the creator's time zone
    timeLocal: { type: String, required: true }, // HH:MM in the creator's time zone
    platform: String,
    pillar: String,
    title: String,
    concept: String,
    hook: String,
    beats: [String],
    lengthSec: Number,
    cta: String,
    rationale: String,
    status: { type: String, enum: SLOT_STATUS, default: 'planned' },
    linkedVideoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Video', default: null },
}, { _id: false });

/**
 * One AI content strategy for one creator (Analytics tab, Strategy). Generated on demand; the newest
 * ready one is shown, older ones stay as history. Failed generations don't count toward the plan cap.
 */
const contentStrategySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: Object.values(STRATEGY_STATUS), default: STRATEGY_STATUS.GENERATING },
    startedAt: { type: Date, default: Date.now },
    generatedAt: { type: Date, default: null },
    error: { type: String, default: null },
    confidence: { type: String, enum: ['low', 'medium', 'high', null], default: null },
    inputSummary: {
        videos: Number,
        withResults: Number,
        avgScore: Number,
        medianViews: Number,
        profile: mongoose.Schema.Types.Mixed,
    },
    diagnosis: {
        headline: String,
        strengths: [evidenceItem],
        weaknesses: [evidenceItem],
    },
    pillars: [{
        _id: false,
        name: String,
        why: String,
        targetShare: Number,
        evidenceVideoIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Video' }],
    }],
    formula: {
        hookPatterns: [String],
        idealLengthSec: Number,
        pacing: String,
        captionStyle: String,
        ctaStyle: String,
        avoid: [String],
    },
    schedule: {
        startDate: String,
        endDate: String,
        timezone: String,
        slots: [slotSchema],
    },
    experiments: [{ _id: false, hypothesis: String, howToTest: String, successMetric: String }],
    nextMilestone: { metric: String, target: Number, current: Number, basis: String },
}, { timestamps: true });

contentStrategySchema.index({ userId: 1, createdAt: -1 });
// At most one generation in flight per user, across server instances.
contentStrategySchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { status: STRATEGY_STATUS.GENERATING }, name: 'one_generating_per_user' });

export const ContentStrategy = mongoose.model('ContentStrategy', contentStrategySchema);
