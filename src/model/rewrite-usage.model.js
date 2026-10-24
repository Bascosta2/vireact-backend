import mongoose from 'mongoose';

/** Daily hook-rewrite counters keyed by `ip:<hash>` or `user:<id>`. Expire two days after the day starts. */
const rewriteUsageSchema = new mongoose.Schema(
    {
        key: { type: String, required: true },
        day: { type: String, required: true },
        count: { type: Number, default: 0, min: 0 },
        expireAt: { type: Date, required: true },
    },
    { collection: 'hook_rewrite_usage' }
);

rewriteUsageSchema.index({ key: 1, day: 1 }, { unique: true });
rewriteUsageSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export const RewriteUsage = mongoose.model('RewriteUsage', rewriteUsageSchema);
