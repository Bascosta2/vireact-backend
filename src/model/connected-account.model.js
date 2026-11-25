import mongoose from 'mongoose';

/**
 * Connected accounts (Accounts tab): a user's own TikTok, YouTube or Instagram account, linked with the
 * platform's sign-in so their posts' real numbers arrive without typing (services/accounts/).
 *
 * Tokens are stored encrypted (token-crypto.js, AES-256-GCM with ACCOUNTS_TOKEN_KEY) and never leave
 * the server: API responses use toPublicAccount().
 */

export const ACCOUNT_PLATFORMS = Object.freeze(['tiktok', 'youtube', 'instagram', 'facebook']);
export const ACCOUNT_STATUS = Object.freeze({ ACTIVE: 'active', NEEDS_REAUTH: 'needs_reauth' });

const tokensSchema = new mongoose.Schema({
    access: { type: String, default: null },
    refresh: { type: String, default: null },
    accessExpiresAt: { type: Date, default: null },
    refreshExpiresAt: { type: Date, default: null },
    scopes: { type: [String], default: [] },
}, { _id: false });

const connectedAccountSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    platform: { type: String, enum: ACCOUNT_PLATFORMS, required: true },
    /** The platform's id for the account: TikTok open_id, YouTube channel id, Instagram user id. */
    externalId: { type: String, required: true },
    handle: { type: String, default: null },
    displayName: { type: String, default: null },
    avatarUrl: { type: String, default: null },
    followers: { type: Number, default: null },
    /** YouTube only: the channel's uploads playlist. */
    uploadsPlaylistId: { type: String, default: null },
    tokens: { type: tokensSchema, default: () => ({}) },
    status: { type: String, enum: Object.values(ACCOUNT_STATUS), default: ACCOUNT_STATUS.ACTIVE },
    connectedAt: { type: Date, default: Date.now },
    lastSyncAt: { type: Date, default: null },
    lastSyncError: { type: String, default: null },
    lastSyncCounts: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true });

connectedAccountSchema.index({ userId: 1, platform: 1, externalId: 1 }, { unique: true });
connectedAccountSchema.index({ status: 1, lastSyncAt: 1 });

const readingSchema = new mongoose.Schema({
    at: { type: Date, required: true },
    ageHours: { type: Number, default: null },
    views: { type: Number, default: null },
    likes: { type: Number, default: null },
    comments: { type: Number, default: null },
    shares: { type: Number, default: null },
    saves: { type: Number, default: null },
    reach: { type: Number, default: null },
    avgWatchSec: { type: Number, default: null },
    avgViewPct: { type: Number, default: null },
}, { _id: false });

/** One post on a connected account, with a daily reading of its numbers (newest last, capped). */
const connectedPostSchema = new mongoose.Schema({
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'ConnectedAccount', required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    platform: { type: String, enum: ACCOUNT_PLATFORMS, required: true },
    externalId: { type: String, required: true },
    url: { type: String, default: null },
    caption: { type: String, default: null },
    postedAt: { type: Date, default: null },
    durationSec: { type: Number, default: null },
    thumbnailUrl: { type: String, default: null },
    mediaType: { type: String, default: null },
    latest: { type: readingSchema, default: null },
    readings: { type: [readingSchema], default: [] },
    /** YouTube connected channels: share of viewers still watching at each 1% of the video (0-100). */
    retention: { type: [Number], default: undefined },
    /** The Vireact upload this post is (set automatically when the match is clear, or by the user). */
    videoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Video', default: null, index: true },
    linkSource: { type: String, enum: ['auto', 'user', null], default: null },
    /** Milestones (hours after posting) already copied to the linked video's performance snapshots. */
    milestonesSent: { type: [Number], default: [] },
}, { timestamps: true });

connectedPostSchema.index({ accountId: 1, externalId: 1 }, { unique: true });
connectedPostSchema.index({ userId: 1, postedAt: -1 });

/** A sign-in in progress: the random state sent to the platform, and the PKCE verifier. 15-minute life. */
const oauthStateSchema = new mongoose.Schema({
    stateHash: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    platform: { type: String, enum: ACCOUNT_PLATFORMS, required: true },
    codeVerifier: { type: String, default: null },
    expiresAt: { type: Date, required: true },
});
oauthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ConnectedAccount = mongoose.model('ConnectedAccount', connectedAccountSchema);
export const ConnectedPost = mongoose.model('ConnectedPost', connectedPostSchema);
export const AccountOAuthState = mongoose.model('AccountOAuthState', oauthStateSchema);
