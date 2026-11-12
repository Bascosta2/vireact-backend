import mongoose from 'mongoose';

/** Lifecycle of one AI edit (Editor tab). Renders have their own status in `renders[]`. */
export const EDIT_STATUS = Object.freeze({
    AWAITING_UPLOAD: 'awaiting_upload',
    QUEUED: 'queued',
    PREPROCESSING: 'preprocessing',
    PLANNING: 'planning',
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
    error: String,
    createdAt: { type: Date, default: Date.now },
    finishedAt: Date,
}, { _id: false });

const editProjectSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, maxlength: 200, default: 'Untitled edit' },
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

    media: {
        words: { type: [wordSchema], default: undefined },
        silences: { type: [rangeSchema], default: undefined },
        sceneCuts: { type: [Number], default: undefined },
        loudnessLufs: Number,
        frameSheets: { type: [new mongoose.Schema({ key: String, from: Number, to: Number, cols: Number, rows: Number, intervalSec: Number }, { _id: false })], default: undefined },
        cutCandidates: { type: [mongoose.Schema.Types.Mixed], default: undefined },
        transcriptLanguage: String,
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
    pendingRevision: { type: new mongoose.Schema({ note: String, previousPlan: mongoose.Schema.Types.Mixed }, { _id: false }), default: null },
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
