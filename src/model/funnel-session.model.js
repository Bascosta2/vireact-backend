import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { QUIZ_OPTIONS, FUNNEL_STATUSES } from '../constants/funnel-quiz.js';
import { SUBSCRIPTION_PLANS } from '../constants.js';

export const ANON_SESSION_TTL_SECONDS = 180 * 24 * 60 * 60;

const answersSchema = new mongoose.Schema(
    Object.fromEntries(Object.entries(QUIZ_OPTIONS).map(([key, values]) => [key, { type: String, enum: values }])),
    { _id: false }
);

/**
 * One quiz run (plan §5.2). The uuid `_id` is the client's handle; it never
 * carries PII. Sessions with no email and no user are purged after 180 days
 * through the `purgeable` TTL index (a partial TTL index cannot test $exists).
 */
const funnelSessionSchema = new mongoose.Schema(
    {
        _id: { type: String, default: () => randomUUID() },
        status: { type: String, enum: FUNNEL_STATUSES, default: 'started', index: true },
        answers: { type: answersSchema, default: () => ({}) },
        segment: String,
        highIntent: { type: Boolean, default: false },
        recommendedPlan: { type: String, enum: [SUBSCRIPTION_PLANS.PREMIUM, SUBSCRIPTION_PLANS.PRO] },
        matchedItemSlugs: { type: [String], default: [] },
        entryItemSlug: String,
        email: { type: String, lowercase: true, trim: true },
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
        attribution: { type: mongoose.Schema.Types.Mixed },
        steps: {
            type: [{ _id: false, step: String, at: { type: Date, default: Date.now } }],
            default: [],
        },
        rewritesUsed: { type: Number, default: 0, min: 0 },
        ipHash: String,
        purgeable: { type: Boolean, default: true },
    },
    { timestamps: true, collection: 'funnel_sessions' }
);

funnelSessionSchema.index(
    { createdAt: 1 },
    { expireAfterSeconds: ANON_SESSION_TTL_SECONDS, partialFilterExpression: { purgeable: true } }
);

export const FunnelSession = mongoose.model('FunnelSession', funnelSessionSchema);
