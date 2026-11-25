import mongoose from 'mongoose';

/**
 * Background-matte work (fal.ai) per user + source video + model variant. The `_id` is that key, so MongoDB
 * itself guarantees one document per piece of work (no separate index needed): inserting it, or swapping it on
 * `rev`, is the atomic claim that lets exactly one job submit a paid request. `usage` is an append-only ledger
 * with one entry per claimed run; the spend caps sum it, so a later retry never hides an earlier charge.
 */
const usageSchema = new mongoose.Schema(
    {
        claimId: { type: String, required: true },
        at: { type: Date, required: true },
        seconds: { type: Number, default: 0 },
        estCostUsd: { type: Number, default: 0 },
        /** The run stopped before anything was sent to fal, so nothing was billed. */
        voided: { type: Boolean, default: false },
    },
    { _id: false }
);

const matteJobSchema = new mongoose.Schema(
    {
        _id: { type: String },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        sourceHash: { type: String, required: true },
        variant: { type: String, required: true },
        /** Bumped on every write; a claim only wins against the version it read. */
        rev: { type: Number, default: 1 },
        /** The run that holds the work; only it may save the record. */
        claimId: String,
        status: String,
        key: String,
        model: String,
        reason: String,
        seconds: Number,
        estCostUsd: Number,
        cached: Boolean,
        requestId: String,
        statusUrl: String,
        responseUrl: String,
        cancelUrl: String,
        submittedAt: Date,
        updatedAt: Date,
        usage: { type: [usageSchema], default: [] },
    },
    { collection: 'editor_matte_jobs', versionKey: false }
);

matteJobSchema.index({ userId: 1, 'usage.at': 1 });
matteJobSchema.index({ 'usage.at': 1 });

export const matteJobId = (userId, sourceHash, variant) => `${userId}:${sourceHash}:${variant}`;

export const MatteJob = mongoose.model('MatteJob', matteJobSchema);
