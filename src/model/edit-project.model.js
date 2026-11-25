import mongoose from 'mongoose';

/** Lifecycle of one AI edit (Editor tab). Renders have their own status in `renders[]`. */
export const EDIT_STATUS = Object.freeze({
    AWAITING_UPLOAD: 'awaiting_upload',
    QUEUED: 'queued',
    PREPROCESSING: 'preprocessing',
    PLANNING: 'planning',
    /** Story mode: the storyboards are written and wait for the creator to pick one (holds no slot). */
    CHOOSING: 'choosing',
    READY: 'ready',
    FAILED: 'failed',
    DELETED: 'deleted',
});

/** Statuses that hold the user's single in-flight slot. */
export const IN_FLIGHT_STATUSES = [EDIT_STATUS.AWAITING_UPLOAD, EDIT_STATUS.QUEUED, EDIT_STATUS.PREPROCESSING, EDIT_STATUS.PLANNING];

export const RENDER_STATUS = Object.freeze({ RENDERING: 'rendering', DONE: 'done', FAILED: 'failed' });

const wordSchema = new mongoose.Schema({ w: String, start: Number, end: Number }, { _id: false });
const rangeSchema = new mongoose.Schema({ start: Number, end: Number }, { _id: false });

const renderSchema = new mongoose.Schema({
    id: { type: String, required: true },
    status: { type: String, enum: Object.values(RENDER_STATUS), default: RENDER_STATUS.RENDERING },
    progress: { type: Number, default: 0 },
    remotionRenderId: String,
    bucketName: String,
    key: String,
    sizeBytes: Number,
    /** Length of the export (from the composition), so posting can check a platform's length limit. */
    durationSec: Number,
    error: String,
    createdAt: { type: Date, default: Date.now },
    finishedAt: Date,
}, { _id: false });

const editProjectSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, maxlength: 200, default: 'Untitled edit' },
    /** Editing skill the edit follows (service/editor/skills.js), or null for the standard editor. */
    skill: { type: String, default: null },
    /** 'upload': an edit of the creator's video; 'storyboard': a video animated from a typed idea (story mode). */
    kind: { type: String, enum: ['upload', 'storyboard'], default: 'upload' },
    /**
     * Story mode: { prompt, lengthSec, options: [3 storyboards], chosen, final: { ...option, timing },
     * rounds, note }. See service/editor/storyboard.service.js.
     */
    storyboard: { type: mongoose.Schema.Types.Mixed, default: null },
    status: { type: String, enum: Object.values(EDIT_STATUS), default: EDIT_STATUS.AWAITING_UPLOAD },
    /** True while the project holds the user's one in-flight slot (unique partial index below). */
    inFlight: { type: Boolean, default: true },
    /** Human-readable step for the progress UI, and a 0-100 estimate. */
    stage: { type: String, default: 'uploading' },
    progress: { type: Number, default: 0 },
    heartbeatAt: Date,
    attempts: { type: Number, default: 0 },
    error: { type: String, default: null },

    source: {
        key: String,
        contentType: String,
        sizeBytes: Number,
        originalName: String,
        durationSec: Number,
        width: Number,
        height: Number,
        fps: Number,
        rotation: Number,
        hasAudio: Boolean,
        proxyKey: String,
        /** Normalized copy the export renders from (see media-prep.js). */
        masterKey: String,
        thumbnailKey: String,
    },

    /** Optional second upload (EDITOR_FEATURES_V2): a screen recording the planner may cut to over the talking head. */
    screenRecording: {
        key: String,
        contentType: String,
        sizeBytes: Number,
        originalName: String,
        durationSec: Number,
        width: Number,
        height: Number,
        /** Set once prepared; absent while the upload is waiting to be prepared. */
        proxyKey: String,
        masterKey: String,
        sheetKey: String,
        /** True from attach until confirm, so each upload is confirmed (and planned) once. */
        awaitingUpload: Boolean,
    },
    /** How many screen recordings were attached to this edit (capped, see MAX_SCREEN_ATTACHES). */
    screenAttaches: { type: Number, default: 0 },

    media: {
        words: { type: [wordSchema], default: undefined },
        silences: { type: [rangeSchema], default: undefined },
        sceneCuts: { type: [Number], default: undefined },
        loudnessLufs: Number,
        frameSheets: { type: [new mongoose.Schema({ key: String, from: Number, to: Number, cols: Number, rows: Number, intervalSec: Number }, { _id: false })], default: undefined },
        cutCandidates: { type: [mongoose.Schema.Types.Mixed], default: undefined },
        transcriptLanguage: String,
        /** Background matte (graphics behind the speaker): ok with an S3 key, or failed/skipped with a plain reason. */
        matte: { type: new mongoose.Schema({ status: String, key: String, model: String, variant: String, sourceHash: String, reason: String, seconds: Number, estCostUsd: Number, cached: Boolean, requestId: String, statusUrl: String, responseUrl: String, cancelUrl: String, submittedAt: Date, updatedAt: Date }, { _id: false }), default: undefined },
    },

    /** Validated edit decision list from the planner (see service/editor/edl-validator.js). */
    plan: { type: mongoose.Schema.Types.Mixed, default: null },
    planGenerationId: { type: String, default: null },
    /** The creator's overrides on top of the plan (toggles, caption fixes, hook text, music). */
    edits: { type: mongoose.Schema.Types.Mixed, default: {} },
    revisions: [{
        _id: false,
        note: String,
        plan: mongoose.Schema.Types.Mixed,
        createdAt: { type: Date, default: Date.now },
    }],
    /** Set while a regeneration is queued, so the job (and a sweeper retry) knows to replan with the note. */
    pendingRevision: { type: new mongoose.Schema({ note: String, previousPlan: mongoose.Schema.Types.Mixed, keepEdits: mongoose.Schema.Types.Mixed, screenAttach: Boolean }, { _id: false }), default: null },
    renders: { type: [renderSchema], default: [] },

    billing: {
        kind: { type: String, enum: ['trial', 'plan', null], default: null },
        countedAt: { type: Date, default: null },
    },
    linkedVideoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Video', default: null },
    readyAt: Date,
    deletedAt: Date,
}, { timestamps: true });

editProjectSchema.index({ userId: 1, createdAt: -1 });
editProjectSchema.index({ status: 1, heartbeatAt: 1 });
editProjectSchema.index({ userId: 1, 'billing.countedAt': -1 });
// One AI edit in flight per user, enforced by the database across instances.
editProjectSchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { inFlight: true }, name: 'one_edit_in_flight_per_user' });

export const EditProject = mongoose.model('EditProject', editProjectSchema);
