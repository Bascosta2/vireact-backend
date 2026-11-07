import mongoose from 'mongoose';

/** Unreviewed responses are deleted after this many days; reviewing one keeps it (expiresAt is cleared). */
export const AI_RESPONSE_RETENTION_DAYS = 30;

/**
 * One model call (OpenAI or Twelve Labs): what was sent, what came back, tokens, cost and timing.
 * Written by lib/ai-tracking.js; read by the admin "AI responses" page.
 */
const aiResponseSchema = new mongoose.Schema({
    provider: { type: String, required: true },          // openai | twelvelabs
    model: { type: String, default: '' },
    /** What this call does, e.g. hook_analysis, chat_response, chat_intent, scene_analysis. */
    label: { type: String, default: '' },
    /** Product feature that triggered it, e.g. video_analysis, chat, scripts, hook_rewrite, kb_research. */
    feature: { type: String, default: 'other' },
    traceId: { type: String, default: '' },
    sessionId: { type: String, default: null },
    distinctId: { type: String, default: '' },
    userId: { type: String, default: null },
    videoId: { type: String, default: null },
    chatId: { type: String, default: null },
    /** 1 for the first try, 2 for a correction retry. */
    attempt: { type: Number, default: 1 },

    input: { type: [{ _id: false, role: String, content: mongoose.Schema.Types.Mixed }], default: [] },
    output: { type: String, default: '' },
    outputPreview: { type: String, default: '' },

    inputTokens: { type: Number, default: null },
    outputTokens: { type: Number, default: null },
    cachedInputTokens: { type: Number, default: null },
    reasoningTokens: { type: Number, default: null },
    totalTokens: { type: Number, default: null },
    /** Only set when AI_MODEL_PRICES has a price for the model (PostHog computes its own cost). */
    costUsd: { type: Number, default: null },
    latencyMs: { type: Number, default: null },
    stopReason: { type: String, default: null },
    isError: { type: Boolean, default: false },
    error: { type: String, default: null },
    params: {
        temperature: { type: Number, default: null },
        maxTokens: { type: Number, default: null },
        reasoningEffort: { type: String, default: null },
    },

    /** Our own quality gate (feedback-validator) result for analyzer/chat outputs. */
    validation: {
        status: { type: String, enum: ['passed', 'failed', null], default: null },
        issues: { type: [String], default: [] },
    },
    /** Admin review from the admin panel. */
    review: {
        rating: { type: String, enum: ['good', 'bad', null], default: null },
        note: { type: String, default: '' },
        reviewedAt: { type: Date, default: null },
    },
    expiresAt: { type: Date, default: () => new Date(Date.now() + AI_RESPONSE_RETENTION_DAYS * 24 * 60 * 60 * 1000) },
}, { timestamps: true });

aiResponseSchema.index({ createdAt: -1 });
aiResponseSchema.index({ feature: 1, createdAt: -1 });
aiResponseSchema.index({ label: 1, createdAt: -1 });
aiResponseSchema.index({ userId: 1, createdAt: -1 });
aiResponseSchema.index({ videoId: 1, createdAt: -1 });
aiResponseSchema.index({ traceId: 1 });
// Documents without expiresAt (reviewed ones) are kept.
aiResponseSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ttl_expiresAt' });

export const AiResponse = mongoose.model('AiResponse', aiResponseSchema);
