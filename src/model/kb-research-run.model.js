import mongoose from 'mongoose';

/** One run of the knowledge research agent (manual, CLI or scheduled). */
const kbResearchRunSchema = new mongoose.Schema({
    runId: { type: String, required: true, unique: true },
    trigger: { type: String, enum: ['admin', 'cli', 'schedule'], default: 'admin' },
    status: { type: String, enum: ['running', 'done', 'failed'], default: 'running', index: true },
    topics: { type: [String], default: [] },
    startedAt: { type: Date, default: Date.now, index: true },
    finishedAt: { type: Date, default: null },
    stats: {
        queries: { type: Number, default: 0 },
        urlsFound: { type: Number, default: 0 },
        pagesRead: { type: Number, default: 0 },
        candidates: { type: Number, default: 0 },
        duplicates: { type: Number, default: 0 },
        skipped: { type: Number, default: 0 },
    },
    skippedSample: { type: [{ url: String, reason: String }], default: [] },
    error: { type: String, default: '' },
});

export const KbResearchRun = mongoose.model('KbResearchRun', kbResearchRunSchema);
