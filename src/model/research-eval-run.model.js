import mongoose from 'mongoose';

/**
 * One run of the research ingest (pull -> gates -> ingest -> retrieval health check -> retire),
 * with the before/after retrieval snapshots and the summary sent to PostHog.
 */
const researchEvalRunSchema = new mongoose.Schema({
    runId: { type: String, required: true, unique: true },
    trigger: { type: String, default: 'script' },
    dryRun: { type: Boolean, default: true },
    status: { type: String, enum: ['running', 'completed', 'rolled_back', 'failed', 'skipped'], default: 'running', index: true },
    /** approved/<date> folders read this run; the newest is the next run's starting point. */
    batches: [String],
    retireFiles: [String],
    summary: mongoose.Schema.Types.Mixed,
    evalResult: {
        passed: { type: Boolean, default: null },
        reasons: [String],
    },
    before: mongoose.Schema.Types.Mixed,
    after: mongoose.Schema.Types.Mixed,
    error: { type: String, default: '' },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
}, { timestamps: true, collection: 'research_eval_runs' });

researchEvalRunSchema.index({ startedAt: -1 });

export const ResearchEvalRun = mongoose.model('ResearchEvalRun', researchEvalRunSchema);
