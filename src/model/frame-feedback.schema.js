import mongoose from 'mongoose';
import {
    FRAME_FEEDBACK_CATEGORIES,
    FRAME_FEEDBACK_FIX_TYPES,
    FEEDBACK_SOURCE_FEATURES,
    FEEDBACK_SEVERITY_MIN,
    FEEDBACK_SEVERITY_MAX
} from '../constants.js';

/**
 * Shared frame-level feedback sub-schemas.
 *
 * Used by `Video` (analysis output) and `Chat` (fixes authored inside a reply) so
 * the two cannot drift. Both shapes are produced under OpenAI structured outputs
 * and pass `analyzer/feedback-validator.js` before they are persisted.
 *
 * Timestamps are numeric seconds throughout; display timecodes are derived at
 * the DTO boundary. Severity is 1-5 and maps to the documented
 * critical|important|minor contract in the video DTO.
 */

/**
 * A single actionable moment: exact range, concrete observation, literal fix.
 * `fix.type` is a field genuinely named `type`; Mongoose treats it as a nested
 * path (not a type declaration) because its value object itself has a `type` key.
 */
export const frameFeedbackSchema = new mongoose.Schema({
    /** Stable per-document id (`fb_0001` / `cfb_0001`), server-assigned. */
    id: {
        type: String,
        required: true
    },
    /** Start of the cited range, in seconds. */
    tStart: {
        type: Number,
        required: true
    },
    /** End of the cited range, in seconds. */
    tEnd: {
        type: Number,
        required: true
    },
    category: {
        type: String,
        enum: FRAME_FEEDBACK_CATEGORIES,
        required: true
    },
    /** 1-5; 5 = kills retention outright. */
    severity: {
        type: Number,
        min: FEEDBACK_SEVERITY_MIN,
        max: FEEDBACK_SEVERITY_MAX,
        required: true
    },
    /** Authoring analyzer — drives plan-aware stripping in the DTO. */
    sourceFeature: {
        type: String,
        enum: FEEDBACK_SOURCE_FEATURES,
        required: true
    },
    /** What literally happens in the range (verbatim quotes, measured facts). */
    observed: {
        type: String,
        required: true
    },
    /** Why this specific moment costs retention. */
    issue: {
        type: String,
        required: true
    },
    fix: {
        type: {
            type: String,
            enum: FRAME_FEEDBACK_FIX_TYPES,
            required: true
        },
        /** Verbatim existing content; null only for additive fix types. */
        before: {
            type: String,
            default: null
        },
        /** Literal drop-in replacement the creator can use as-is. */
        after: {
            type: String,
            required: true
        }
    },
    expectedImpact: {
        type: String
    },
    /** 0-1 confidence that the cited moment and fix are correct. */
    sourceConfidence: {
        type: Number,
        min: 0,
        max: 1,
        default: 0.5
    }
}, { _id: false });

/**
 * A rewritten spoken line. Separate from general frame feedback so the report and
 * chat can render a script diff without filtering `timestampFeedback`.
 */
export const scriptRewriteSchema = new mongoose.Schema({
    lineId: {
        type: String,
        required: true
    },
    timestamp: {
        type: Number,
        required: true
    },
    /** Quoted verbatim from `Video.rawTranscript` — never paraphrased. */
    originalTranscript: {
        type: String,
        required: true
    },
    /** The actual words the creator should say instead. */
    rewrittenLine: {
        type: String,
        required: true
    },
    rationale: {
        type: String
    },
    deliveryNote: {
        type: String
    },
    sourceFeature: {
        type: String,
        enum: FEEDBACK_SOURCE_FEATURES,
        required: true
    }
}, { _id: false });

/**
 * Timestamped transcript segment. SEGMENT-level granularity is the Twelve Labs
 * SDK ceiling (`TranscriptionDataItem = { start, end, value }`), so a "line" here
 * is a spoken segment, not a word token.
 */
export const transcriptSegmentSchema = new mongoose.Schema({
    text: {
        type: String,
        required: true
    },
    tStart: {
        type: Number,
        required: true
    },
    tEnd: {
        type: Number,
        required: true
    }
}, { _id: false });
