import mongoose from 'mongoose';

/**
 * Scheduled posts (publishing engine, src/service/publish/): one video + caption sent to one or more of the
 * user's connected accounts at a chosen time. Each platform is a target with its own status, so one
 * platform failing never blocks or repeats another. A target that reached `published` is never sent again.
 */

export const PUBLISH_PLATFORMS = Object.freeze(['tiktok', 'instagram', 'youtube', 'facebook']);
export const POST_STATUS = Object.freeze({
    SCHEDULED: 'scheduled',
    PUBLISHING: 'publishing',
    PUBLISHED: 'published',
    PARTIALLY_PUBLISHED: 'partially_published',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
});
export const TARGET_STATUS = Object.freeze({
    PENDING: 'pending',
    PUBLISHING: 'publishing',
    PUBLISHED: 'published',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
});
export const PUBLISH_MODES = Object.freeze(['draft', 'publish']);

/**
 * The creator's own choices for a TikTok Direct Post (required by TikTok's content sharing guidelines):
 * who can watch, which interactions to allow, the commercial content disclosure and the music declaration.
 * Validated against a fresh creator_info call when saved and checked again before posting; never changed by us.
 */
const tiktokSettingsSchema = new mongoose.Schema({
    privacyLevel: { type: String, required: true },
    allowComment: { type: Boolean, default: false },
    allowDuet: { type: Boolean, default: false },
    allowStitch: { type: Boolean, default: false },
    commercial: {
        enabled: { type: Boolean, default: false },
        yourBrand: { type: Boolean, default: false },
        brandedContent: { type: Boolean, default: false },
    },
    musicConfirmed: { type: Boolean, default: false },
    /** When the creator agreed to the Music Usage Confirmation (and Branded Content Policy when branded). */
    confirmedAt: { type: Date, default: null },
}, { _id: false });

const targetSchema = new mongoose.Schema({
    platform: { type: String, enum: PUBLISH_PLATFORMS, required: true },
    /** The connected account chosen when the post was scheduled (null in dry-run without an account). */
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConnectedAccount', default: null },
    /** Facebook only: the Page to post to (one of the Pages the connected login shares). */
    pageId: { type: String, default: null },
    /** TikTok Direct Post only (mode 'publish'): the creator's post settings. Drafts have none. */
    tiktok: { type: tiktokSettingsSchema, default: undefined },
    status: { type: String, enum: Object.values(TARGET_STATUS), default: TARGET_STATUS.PENDING },
    externalId: { type: String, default: null },
    url: { type: String, default: null },
    /** Plain-English reason shown to the user when the target failed. */
    error: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    /** Not before this time (retry backoff or waiting for the platform to process the video). */
    nextAttemptAt: { type: Date, default: null },
    /** Platform progress kept between passes so a retry resumes instead of posting twice (upload ids, containers). */
    state: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    publishedAt: { type: Date, default: null },
}, { _id: false, minimize: false });

const scheduledPostSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    /** Editor project whose latest finished export is posted (or null when a media key was given directly). */
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'EditProject', default: null },
    /** The user's own object in our bucket (validated on create); clients only ever see signed URLs. */
    media: {
        key: { type: String, required: true },
        sizeBytes: { type: Number, default: null },
        contentType: { type: String, default: 'video/mp4' },
        /** Length of the video when known (editor exports and uploads), checked against TikTok's limit. */
        durationSec: { type: Number, default: null },
    },
    caption: { type: String, default: '', maxlength: 2200 },
    scheduledAt: { type: Date, required: true },
    mode: { type: String, enum: PUBLISH_MODES, required: true },
    status: { type: String, enum: Object.values(POST_STATUS), default: POST_STATUS.SCHEDULED },
    /** Created in test mode (PUBLISHING_DRY_RUN): always simulated, even if the flag is turned off later. */
    dryRun: { type: Boolean, default: false },
    targets: { type: [targetSchema], default: [] },
    /** Bumped whenever scheduledAt changes, so an old queued message cannot start a second chain. */
    scheduleVersion: { type: Number, default: 1 },
    queueMessageId: { type: String, default: null },
    /** Lease held by the pass that is publishing right now (another delivery waits for it to expire). */
    lockedUntil: { type: Date, default: null },
    /** Owner of the lease: every write of a pass is conditioned on it, so a stale pass cannot overwrite a newer one. */
    lockToken: { type: String, default: null },
    completedAt: { type: Date, default: null },
}, { timestamps: true });

scheduledPostSchema.index({ userId: 1, scheduledAt: 1 });
scheduledPostSchema.index({ status: 1, scheduledAt: 1 });

export const ScheduledPost = mongoose.model('ScheduledPost', scheduledPostSchema);
