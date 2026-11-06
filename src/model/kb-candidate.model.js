import mongoose from 'mongoose';

/**
 * A lesson the research agent extracted from a public web source, waiting for human review.
 * Nothing here reaches analyzers or chat until it is approved and copied into `knowledgebases`.
 */
const kbCandidateSchema = new mongoose.Schema({
    runId: { type: String, index: true },
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },

    topic: {
        type: String,
        enum: ['hook', 'caption', 'pacing', 'audio', 'advanced_analytics', 'views_predictor', 'general'],
        required: true,
        index: true,
    },
    layer: { type: String, enum: ['pattern', 'example'], required: true },
    specificity: { type: String, enum: ['literal', 'directional'], required: true },

    /** Exactly what gets embedded and, once approved, stored in the knowledge base. */
    content: { type: String, required: true },
    /** The lesson, in our own words. */
    claim: { type: String, required: true },
    /** What the source shows for it (numbers only when the source states them). */
    evidence: { type: String, default: '' },
    /** Short example line or quote (25 words max). */
    example: { type: String, default: '' },
    appliesTo: { type: String, default: '' },
    metrics: {
        views: { type: Number, default: null },
        retentionPercent: { type: Number, default: null },
    },
    confidence: { type: Number, min: 0, max: 1, default: 0.5 },

    sourceUrl: { type: String, required: true },
    sourceTitle: { type: String, default: '' },
    sourceDomain: { type: String, default: '', index: true },

    /** Embedding of `content` computed at extraction, reused on approval. */
    embedding: { type: [Number], select: false },
    /** Closest existing knowledge-base entry and its similarity, for the reviewer. */
    nearestKbId: { type: mongoose.Schema.Types.ObjectId, default: null },
    nearestKbScore: { type: Number, default: null },

    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: '' },
    knowledgeBaseId: { type: mongoose.Schema.Types.ObjectId, default: null },
}, { timestamps: true });

kbCandidateSchema.index({ status: 1, createdAt: -1 });

export const KbCandidate = mongoose.model('KbCandidate', kbCandidateSchema);
