import mongoose from 'mongoose';

/**
 * One item the cloud research/review agents staged in Bascosta2/vireact-research (approved/<date>/*.jsonl),
 * after the backend's own gates. Only `ingested` items have knowledge-base docs (kbIds, origin "research").
 * `imported` = passed every gate but waiting on the daily cap or the max-share cap; picked up on the next run.
 */
export const RESEARCH_STATUS = Object.freeze({
    IMPORTED: 'imported',
    INGESTED: 'ingested',
    REJECTED: 'rejected',
    DUPLICATE: 'duplicate',
    INVALID: 'invalid',
    RETIRED: 'retired',
    ROLLED_BACK: 'rolled_back',
});

const evidenceSchema = new mongoose.Schema({
    url: String,
    title: String,
    publisher: String,
    published_date: String,
    quote: String,
    source_tier: Number,
}, { _id: false });

const researchCandidateSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    run_date: String,
    type: String,
    title: String,
    insight: String,
    actionable_rule: String,
    example: String,
    topics: [String],
    platforms: [String],
    niches: [String],
    metrics: [mongoose.Schema.Types.Mixed],
    evidence: [evidenceSchema],
    source_tier: Number,
    confidence: Number,
    freshness: String,
    agent_notes: String,
    review: mongoose.Schema.Types.Mixed,
    reviewScore: { type: Number, default: null },

    status: { type: String, enum: Object.values(RESEARCH_STATUS), required: true, index: true },
    rejectReason: { type: String, default: '' },
    /** For duplicates: what it matched ("id", "url_title:<id>", "kb:<kbId>@0.95"). */
    duplicateOf: { type: String, default: '' },
    kbIds: [{ type: mongoose.Schema.Types.ObjectId }],
    /** approved/<batch>/ folder date (YYYY-MM-DD). */
    batch: { type: String, index: true },
    sourceFile: String,
    runId: String,
    importedAt: { type: Date, default: Date.now },
    ingestedAt: { type: Date, default: null },
    retiredAt: { type: Date, default: null },
    retireReason: { type: String, default: '' },
}, { timestamps: true, collection: 'research_candidates' });

researchCandidateSchema.index({ status: 1, reviewScore: -1 });
researchCandidateSchema.index({ status: 1, ingestedAt: -1 });

export const ResearchCandidate = mongoose.model('ResearchCandidate', researchCandidateSchema);
