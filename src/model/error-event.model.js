import mongoose from 'mongoose';

/**
 * One kind of error (fingerprint) seen on one day, with a running count. Grouping keeps the collection
 * small even if an error repeats thousands of times. Rows expire after 30 days.
 */
const errorEventSchema = new mongoose.Schema({
    fingerprint: { type: String, required: true },
    day: { type: String, required: true }, // YYYY-MM-DD (UTC)
    source: { type: String, enum: ['server', 'client', 'upload', 'analysis', 'recovery', 'process'], required: true, index: true },
    message: { type: String, required: true },
    stack: { type: String, default: '' },
    route: { type: String, default: '' },
    status: { type: Number, default: null },
    url: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    release: { type: String, default: '' },
    count: { type: Number, default: 0 },
    /** Up to 20 distinct affected users / videos, for follow-up. */
    userIds: { type: [String], default: [] },
    videoIds: { type: [String], default: [] },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
});

errorEventSchema.index({ fingerprint: 1, day: 1 }, { unique: true });
// Also serves "most recent first" queries.
errorEventSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60, name: 'ttl_30d' });

export const ErrorEvent = mongoose.model('ErrorEvent', errorEventSchema);
