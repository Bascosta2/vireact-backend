import mongoose from 'mongoose';
import { frameFeedbackSchema, scriptRewriteSchema } from './frame-feedback.schema.js';

const messageSchema = new mongoose.Schema({
    text: {
        type: String,
        required: true
    },
    isUser: {
        type: Boolean,
        required: true
    },
    /**
     * Ids this reply cites: `Video.timestampFeedback[].id` and
     * `Video.scriptRewrites[].lineId`. Lets the report deep-link and highlight the
     * referenced moment without re-parsing the reply text.
     */
    feedbackRefs: {
        type: [String],
        default: []
    },
    /**
     * Fixes authored inside this reply (not already stored on the Video).
     * Persisted because chat history survives refresh (SLASH_DOC 2.3) — without
     * this the structured diff would degrade back to plain text on reload.
     */
    fixes: {
        type: [frameFeedbackSchema],
        default: []
    },
    /** Line rewrites authored inside this reply. */
    scriptRewrites: {
        type: [scriptRewriteSchema],
        default: []
    },
    /**
     * Whether the reply was answerable from this video's analysis. `not_covered`
     * means the bot said so explicitly instead of generating generic advice.
     */
    coverage: {
        type: String,
        enum: ['grounded', 'partially_grounded', 'not_covered'],
        default: null
    }
}, { timestamps: true });

const chatSchema = new mongoose.Schema({
    videoId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Video',
        required: true,
        index: true
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    messages: {
        type: [messageSchema],
        default: []
    }
}, { timestamps: true });

// Compound index for efficient querying
chatSchema.index({ videoId: 1, userId: 1 }, { unique: true });

export const Chat = mongoose.model('Chat', chatSchema);
