import mongoose from 'mongoose';
import { ScheduledPost, POST_STATUS, TARGET_STATUS, PUBLISH_PLATFORMS, PUBLISH_MODES } from '../../model/scheduled-post.model.js';
import { ConnectedAccount, ACCOUNT_STATUS } from '../../model/connected-account.model.js';
import { EditProject, EDIT_STATUS, RENDER_STATUS } from '../../model/edit-project.model.js';
import { storage } from '../../lib/storage.js';
import { ApiError } from '../../utils/ApiError.js';
import { hasPublishingAccess, isPublishingDryRun } from '../../config/flags.js';
import { PROVIDERS, accessTokenFor } from '../accounts/accounts.service.js';
import { PUBLISHERS, PLATFORM_NAMES, scheduleRun, cancelRun } from './publish-job.js';
import { PublishError } from './publishers/index.js';
import { creatorInfoView, isDirectPostAudited, privacyLabel, queryCreatorInfo } from './publishers/tiktok.js';

/**
 * Scheduled posting (API: /api/v1/posts, route/posts.route.js). The user picks a finished editor export (or
 * one of their own videos in our bucket), a caption, platforms and a time; publish-job.js posts it then.
 * Behind PUBLISHING_ENABLED / PUBLISHING_BETA_EMAILS (config/flags.js). Posting needs the platform's posting
 * permission, which the user grants separately (Accounts connect with scopes=publish); PUBLISHING_DRY_RUN
 * simulates everything.
 *
 * TikTok Direct Post follows TikTok's content sharing guidelines: the web app shows a fresh creator_info
 * (GET /tiktok/creator-info) and the creator makes every choice (privacy with no default, interactions,
 * commercial disclosure, music declaration); POST/PATCH validate those choices (`tiktok`) against it.
 */

const MAX_CAPTION = 2200;
const MAX_ACTIVE_POSTS = 200;
const MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
const PAST_GRACE_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Keys the user owns and may post: their editor exports and editor uploads. */
const OWNED_KEY = /^editor\/(renders|sources)\/([a-f0-9]{24})\/([a-f0-9]{24})\/[A-Za-z0-9._-]+$/;

// ---- capabilities

const hasAll = (account, scopes) => {
    const granted = new Set(account?.tokens?.scopes ?? []);
    return scopes.every((s) => granted.has(s));
};

/** Scopes that allow at least one mode (TikTok: drafts with video.upload, posts with video.publish). */
const canPostAnyMode = (platform, account) => PUBLISH_MODES.some((m) => hasAll(account, PUBLISHERS[platform].requiredScopes(m)));

/** One platform's row in GET /capabilities (pure; exported for tests). */
export const platformCapability = ({ platform, account = null, providerAvailable = true, dryRun = false }) => {
    const name = PLATFORM_NAMES[platform];
    const connected = Boolean(account) && providerAvailable;
    if (!providerAvailable) return { platform, connected: false, canPublish: false, reason: `${name} connections are not available yet.` };
    if (dryRun) return { platform, connected, canPublish: true, reason: 'Test mode: posts are simulated and nothing is sent.' };
    if (!account) return { platform, connected: false, canPublish: false, reason: `Connect your ${name} account in the Accounts tab first.` };
    if (account.status === ACCOUNT_STATUS.NEEDS_REAUTH) return { platform, connected, canPublish: false, reason: `Reconnect your ${name} account in the Accounts tab.` };
    if (!canPostAnyMode(platform, account)) return { platform, connected, canPublish: false, reason: `Reconnect ${name} and allow posting to schedule posts there.` };
    return { platform, connected, canPublish: true };
};

/** The account a platform posts from: the newest active connection, else the newest one. */
const pickAccounts = (accounts) => Object.fromEntries(PUBLISH_PLATFORMS.map((p) => {
    const mine = accounts.filter((a) => a.platform === p);
    return [p, mine.find((a) => a.status === ACCOUNT_STATUS.ACTIVE) ?? mine[0] ?? null];
}));

const userAccounts = async (userId) => pickAccounts(await ConnectedAccount.find({ userId, platform: { $in: PUBLISH_PLATFORMS } }).sort({ connectedAt: -1 }).lean());

export const getCapabilities = async (user, { dryRun = isPublishingDryRun() } = {}) => {
    if (!hasPublishingAccess(user)) return { enabled: false, platforms: [] };
    const accounts = await userAccounts(user._id);
    return {
        enabled: true,
        platforms: PUBLISH_PLATFORMS.map((platform) => platformCapability({ platform, account: accounts[platform], providerAvailable: Boolean(PROVIDERS[platform]), dryRun })),
    };
};

// ---- media ownership

/**
 * The bucket key a media URL points at, or null when it is not our bucket. Accepts s3://bucket/key and
 * virtual-hosted or path-style https S3 URLs (signed query strings are ignored).
 */
export const keyFromMediaUrl = (mediaUrl, env = process.env) => {
    const bucket = String(env.AWS_S3_BUCKET_NAME ?? '').trim();
    if (!bucket || typeof mediaUrl !== 'string' || mediaUrl.length > 4096) return null;
    let u;
    try { u = new URL(mediaUrl); } catch { return null; }
    let key = null;
    if (u.protocol === 's3:') {
        if (u.hostname === bucket) key = u.pathname.slice(1);
    } else if (u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443')) {
        const host = u.hostname.toLowerCase();
        if (host.startsWith(`${bucket.toLowerCase()}.s3.`) || host.startsWith(`${bucket.toLowerCase()}.s3-`)) {
            if (/\.amazonaws\.com$/.test(host)) key = u.pathname.slice(1);
        } else if (/^s3([.-][a-z0-9-]+)?\.amazonaws\.com$/.test(host) && u.pathname.startsWith(`/${bucket}/`)) {
            key = u.pathname.slice(bucket.length + 2);
        }
    }
    if (!key) return null;
    try { key = decodeURIComponent(key); } catch { return null; }
    if (key.includes('..') || key.includes('//') || key.startsWith('/') || key.includes('\\')) return null;
    return key;
};

/** True when the key is one of this user's editor exports or uploads. */
export const ownsKey = (userId, key) => {
    const m = OWNED_KEY.exec(String(key ?? ''));
    return Boolean(m) && m[2] === String(userId);
};

/**
 * The video to post: exactly one of projectId (an editor project of the user with a finished export) or
 * mediaUrl (the user's own object in our bucket). Never an arbitrary URL.
 */
export const resolveMedia = async (userId, { projectId, mediaUrl } = {}, { findProject, storageImpl = storage, env = process.env } = {}) => {
    const hasProject = projectId != null && projectId !== '';
    const hasUrl = mediaUrl != null && mediaUrl !== '';
    if (hasProject === hasUrl) throw new ApiError(400, 'Choose either an edit or a video to post, not both.');
    let key;
    let fromProject = null;
    if (hasProject) {
        if (!mongoose.isValidObjectId(projectId)) throw new ApiError(404, 'Edit not found');
        const find = findProject ?? ((id) => EditProject.findOne({ _id: id, userId, status: { $ne: EDIT_STATUS.DELETED } }).select('_id userId renders').lean());
        const project = await find(projectId);
        if (!project || String(project.userId) !== String(userId)) throw new ApiError(404, 'Edit not found');
        const render = [...(project.renders ?? [])].reverse().find((r) => r.status === RENDER_STATUS.DONE && r.key);
        if (!render) throw new ApiError(400, 'This edit has no finished export yet. Export it first, then schedule it.');
        key = render.key;
        fromProject = String(project._id);
    } else {
        key = keyFromMediaUrl(mediaUrl, env);
        if (!key || !ownsKey(userId, key)) throw new ApiError(400, 'You can only post videos from your own Vireact edits.');
    }
    if (!ownsKey(userId, key)) throw new ApiError(400, 'You can only post videos from your own Vireact edits.');
    const head = await storageImpl.head(key);
    if (!head) throw new ApiError(400, 'We could not find that video. Export it again, then schedule it.');
    if (head.contentType && !/^video\/|^application\/octet-stream/.test(head.contentType)) throw new ApiError(400, 'That file is not a video.');
    return { projectId: fromProject, media: { key, sizeBytes: head.sizeBytes ?? null, contentType: head.contentType || 'video/mp4' } };
};

/**
 * Length in seconds of one of the user's editor videos (export or upload), or null when unknown (exports made
 * before lengths were stored). Used to check TikTok's max_video_post_duration_sec.
 */
export const mediaDurationSec = async (userId, key, { findProject } = {}) => {
    const m = OWNED_KEY.exec(String(key ?? ''));
    if (!m || m[2] !== String(userId)) return null;
    const find = findProject ?? ((id) => EditProject.findOne({ _id: id, userId }).select('source.key source.masterKey source.durationSec renders.key renders.durationSec').lean());
    const project = await find(m[3]);
    if (!project) return null;
    const render = (project.renders ?? []).find((r) => r.key === key);
    const value = render ? render.durationSec : ([project.source?.key, project.source?.masterKey].includes(key) ? project.source?.durationSec : null);
    return Number(value) > 0 ? Number(value) : null;
};

// ---- validation (pure)

const parseTime = (v) => {
    const t = typeof v === 'string' || v instanceof Date ? new Date(v).getTime() : NaN;
    return Number.isFinite(t) ? t : null;
};

export const validateCaption = (caption, platforms = []) => {
    if (caption != null && typeof caption !== 'string') throw new ApiError(400, 'The caption must be text.');
    const text = String(caption ?? '');
    if (text.length > MAX_CAPTION) throw new ApiError(400, `Captions can be up to ${MAX_CAPTION} characters.`);
    if (platforms.includes('instagram')) {
        if ((text.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > 30) throw new ApiError(400, 'Instagram allows up to 30 hashtags in a caption.');
        if ((text.match(/@[\w.]+/g) ?? []).length > 20) throw new ApiError(400, 'Instagram allows up to 20 @mentions in a caption.');
    }
    return text;
};

export const validatePlatforms = (platforms) => {
    if (!Array.isArray(platforms) || !platforms.length) throw new ApiError(400, 'Choose at least one platform.');
    const list = [...new Set(platforms.map((p) => String(p).toLowerCase()))];
    const unknown = list.find((p) => !PUBLISH_PLATFORMS.includes(p));
    if (unknown) throw new ApiError(400, `Posting to "${unknown}" is not supported.`);
    return list;
};

/** scheduledAt as a Date: a few minutes in the past means "now"; up to a year ahead. */
export const validateScheduledAt = (value, now = Date.now()) => {
    const t = parseTime(value);
    if (t == null) throw new ApiError(400, 'Choose a valid date and time.');
    if (t < now - PAST_GRACE_MS) throw new ApiError(400, 'That time has already passed. Choose a time in the future.');
    if (t > now + MAX_AHEAD_MS) throw new ApiError(400, 'Posts can be scheduled up to a year ahead.');
    return new Date(Math.max(t, now));
};

const tiktokError = (field, message) => new ApiError(400, message, { code: 'TIKTOK_SETTINGS_INVALID', field });
const INTERACTIONS = [['allowComment', 'comment_disabled', 'comments'], ['allowDuet', 'duet_disabled', 'duets'], ['allowStitch', 'stitch_disabled', 'stitches']];

/**
 * The creator's TikTok Direct Post choices checked against their current creator_info (raw TikTok `data`).
 * Returns the settings to store, or a 400 naming the field with a plain-English reason (pure; tests).
 */
export const validateTikTokSettings = (input, creator, { durationSec = null, env = process.env } = {}) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw tiktokError('tiktok', 'Choose your TikTok settings (who can watch, comments, duets and stitches) before posting to TikTok.');
    }
    const options = creator?.privacy_level_options ?? [];
    const { privacyLevel } = input;
    if (typeof privacyLevel !== 'string' || !privacyLevel) throw tiktokError('tiktok.privacyLevel', 'Choose who can watch this TikTok video.');
    if (!options.includes(privacyLevel)) {
        throw tiktokError('tiktok.privacyLevel', `Your TikTok account does not offer that privacy setting right now. Choose one of: ${options.map(privacyLabel).join(', ')}.`);
    }
    if (privacyLevel !== 'SELF_ONLY' && !isDirectPostAudited(env)) {
        throw tiktokError('tiktok.privacyLevel', 'Until TikTok approves Vireact for public posts, TikTok posts can only be "Only me". Choose "Only me", or "Save as draft" to finish the post in the TikTok app.');
    }
    for (const [key, disabled, what] of INTERACTIONS) {
        if (typeof input[key] !== 'boolean') throw tiktokError(`tiktok.${key}`, `Choose whether to allow ${what} on this TikTok video.`);
        if (input[key] && creator?.[disabled]) throw tiktokError(`tiktok.${key}`, `You turned ${what} off in your TikTok settings, so they cannot be allowed on this video.`);
    }
    const c = input.commercial;
    if (!c || typeof c !== 'object' || Array.isArray(c) || ![c.enabled, c.yourBrand, c.brandedContent].every((v) => typeof v === 'boolean')) {
        throw tiktokError('tiktok.commercial', 'Say whether this video promotes a brand, product or service.');
    }
    const commercial = c.enabled ? { enabled: true, yourBrand: c.yourBrand, brandedContent: c.brandedContent } : { enabled: false, yourBrand: false, brandedContent: false };
    if (commercial.enabled && !commercial.yourBrand && !commercial.brandedContent) {
        throw tiktokError('tiktok.commercial', 'You need to indicate if your content promotes yourself, a third party, or both.');
    }
    if (commercial.brandedContent && privacyLevel === 'SELF_ONLY') {
        throw tiktokError('tiktok.commercial.brandedContent', 'Branded content visibility cannot be set to private. Choose who can watch it other than "Only me".');
    }
    if (input.musicConfirmed !== true) {
        throw tiktokError('tiktok.musicConfirmed', commercial.brandedContent
            ? 'To post, agree to TikTok\'s Branded Content Policy and Music Usage Confirmation.'
            : 'To post, agree to TikTok\'s Music Usage Confirmation.');
    }
    const max = Number(creator?.max_video_post_duration_sec);
    if (max > 0 && Number(durationSec) > max) {
        throw tiktokError('media', `Your TikTok account accepts videos up to ${max} seconds, and this one is ${Math.ceil(durationSec)} seconds. Trim it and export again.`);
    }
    return { privacyLevel, allowComment: input.allowComment, allowDuet: input.allowDuet, allowStitch: input.allowStitch, commercial, musicConfirmed: true };
};

/**
 * Targets for the chosen platforms, or a 400 with the reason a platform cannot be used (pure; tests).
 * `capabilities` is { [platform]: { canPublish, reason } }, `accounts` is { [platform]: account }.
 */
export const buildTargets = ({ platforms, mode, accounts, capabilities, dryRun = false, pageId = null }) => {
    if (!PUBLISH_MODES.includes(mode)) throw new ApiError(400, 'Choose whether to post now or save as a draft.');
    return platforms.map((platform) => {
        const name = PLATFORM_NAMES[platform];
        const cap = capabilities[platform];
        if (mode === 'draft' && PUBLISHERS[platform].supportsDraft === false) {
            throw new ApiError(400, `${name} does not support saving drafts from other apps. Choose "Publish" for ${name}, or leave it out.`);
        }
        if (!cap?.canPublish) throw new ApiError(400, cap?.reason ?? `${name} is not ready for posting.`);
        const account = accounts[platform] ?? null;
        if (!dryRun && !hasAll(account, PUBLISHERS[platform].requiredScopes(mode))) {
            throw new ApiError(400, mode === 'draft'
                ? `${name} is connected without permission to save drafts. Reconnect ${name} and allow posting.`
                : `${name} is connected for drafts only. Reconnect ${name} and allow posting, or choose "Save as draft".`);
        }
        return { platform, accountId: account?._id ?? null, ...(platform === 'facebook' ? { pageId } : {}), status: TARGET_STATUS.PENDING, attempts: 0, state: {} };
    });
};

/**
 * The Facebook Page a post goes to: the requested one if the connected login shares it, else the only Page.
 * The facebook provider (providers/facebook.js) must exist; its pages() lists the shared Pages (up to 5).
 */
export const resolveFacebookPage = async ({ account, pageId, dryRun = false, provider = PROVIDERS.facebook, accessToken = accessTokenFor }) => {
    if (!provider?.pages) throw new ApiError(400, 'Facebook connections are not available yet.');
    const wanted = pageId != null && pageId !== '' ? String(pageId) : null;
    if (wanted && !/^\d{1,32}$/.test(wanted)) throw new ApiError(400, 'That Facebook Page id is not valid.');
    if (dryRun && !account) return wanted;
    let pages;
    try {
        pages = await provider.pages({ access: await accessToken(account) });
    } catch (e) {
        if (e.reauth) throw new ApiError(400, 'Reconnect your Facebook account in the Accounts tab.');
        throw new ApiError(502, 'We could not reach Facebook to list your Pages. Try again in a moment.');
    }
    const ids = (pages ?? []).map((p) => String(p.id));
    if (wanted) {
        if (!ids.includes(wanted)) throw new ApiError(400, 'That Facebook Page is not shared with Vireact. Reconnect Facebook and share it.');
        return wanted;
    }
    if (ids.length === 1) return ids[0];
    if (!ids.length) throw new ApiError(400, 'No Facebook Page is shared with Vireact. Reconnect Facebook and share a Page.');
    throw new ApiError(400, 'You manage more than one Facebook Page. Choose which Page to post to.', { code: 'FACEBOOK_PAGE_REQUIRED', pages: (pages ?? []).map((p) => ({ id: String(p.id), name: p.name ?? null })) });
};

// ---- TikTok creator info

/** creator_info answers are reused this long (TikTok allows 20 calls a minute per user; the guide wants fresh). */
export const CREATOR_INFO_TTL_MS = 30 * 1000;
const creatorInfoCache = new Map();
/** Tests: forget cached creator_info answers. */
export const clearCreatorInfoCache = () => creatorInfoCache.clear();

const NO_CREATOR = Object.freeze({
    nickname: null, avatarUrl: null, privacyLevelOptions: [], commentDisabled: true, duetDisabled: true, stitchDisabled: true, maxVideoPostDurationSec: null,
});

/** Test mode: a simulated creator so the whole flow can be tried before TikTok approves the app. */
const simulatedCreator = (account) => ({
    creator_nickname: account?.displayName || account?.handle || 'Test creator',
    creator_avatar_url: account?.avatarUrl ?? null,
    privacy_level_options: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
    comment_disabled: false,
    duet_disabled: false,
    stitch_disabled: false,
    max_video_post_duration_sec: 600,
});

/**
 * The creator's current TikTok posting options: `view` is what GET /tiktok/creator-info returns, `creator` the
 * raw creator_info data (null when the creator cannot post now; `view.reason` says why in plain English).
 */
export const loadTikTokCreator = async ({ account, dryRun = false, providerAvailable = Boolean(PROVIDERS.tiktok), accessToken = accessTokenFor, fetchImpl = fetch, now = Date.now(), cache = creatorInfoCache } = {}) => {
    const cannot = (reason) => ({ view: { ...NO_CREATOR, canPost: false, reason }, creator: null });
    if (dryRun) {
        const creator = simulatedCreator(account);
        return { view: creatorInfoView(creator), creator };
    }
    if (!providerAvailable) return cannot('TikTok connections are not available yet.');
    if (!account) return cannot('Connect your TikTok account in the Accounts tab first.');
    if (account.status === ACCOUNT_STATUS.NEEDS_REAUTH) return cannot('Reconnect your TikTok account in the Accounts tab.');
    if (!hasAll(account, PUBLISHERS.tiktok.requiredScopes('publish'))) return cannot('Reconnect TikTok and allow posting to post directly. You can still choose "Save as draft".');
    const id = String(account._id);
    const hit = cache.get(id);
    if (hit && now - hit.at < CREATOR_INFO_TTL_MS) return hit.value;
    let creator;
    try {
        creator = await queryCreatorInfo({ access: await accessToken(account, { fetchImpl }), fetchImpl });
    } catch (e) {
        if (e.reauth) return cannot('Reconnect your TikTok account in the Accounts tab.');
        if (e instanceof PublishError && !e.retry) return cannot(e.message);
        return cannot('TikTok did not answer just now. Try again in a moment.');
    }
    const view = creatorInfoView(creator);
    const value = { view, creator: view.canPost ? creator : null };
    if (cache.size > 5000) cache.clear();
    cache.set(id, { at: now, value });
    return value;
};

/** GET /api/v1/posts/tiktok/creator-info for the account TikTok posts would use. */
export const getTikTokCreatorInfo = async (userId, { dryRun = isPublishingDryRun() } = {}) => {
    const accounts = await userAccounts(userId);
    return (await loadTikTokCreator({ account: accounts.tiktok, dryRun })).view;
};

/**
 * Validated TikTok settings to store on the target, from a fresh creator_info. `media.durationSec` is filled in
 * when it can be found. Throws a 400 with a plain-English reason.
 */
export const checkTikTokSettings = async ({ userId, input, account, dryRun, media, now, loadCreator = loadTikTokCreator }) => {
    if (input == null) throw tiktokError('tiktok', 'Choose your TikTok settings (who can watch, comments, duets and stitches) before posting to TikTok.');
    const { view, creator } = await loadCreator({ account, dryRun });
    if (!view.canPost) throw new ApiError(400, view.reason, { code: 'TIKTOK_CANNOT_POST', field: 'tiktok' });
    if (media.durationSec == null) media.durationSec = await mediaDurationSec(userId, media.key);
    return { ...validateTikTokSettings(input, creator, { durationSec: media.durationSec }), confirmedAt: new Date(now) };
};

/** Stored settings as the API returns them (the contract's `tiktok` object). */
const publicTikTok = (t) => ({
    privacyLevel: t.privacyLevel,
    allowComment: Boolean(t.allowComment),
    allowDuet: Boolean(t.allowDuet),
    allowStitch: Boolean(t.allowStitch),
    commercial: { enabled: Boolean(t.commercial?.enabled), yourBrand: Boolean(t.commercial?.yourBrand), brandedContent: Boolean(t.commercial?.brandedContent) },
    musicConfirmed: Boolean(t.musicConfirmed),
});

// ---- what the web app sees

const signed = async (key, storageImpl) => {
    try { return await storageImpl.presignDownload(key, { expiresIn: 3600 }); } catch { return null; }
};

/** ScheduledPost as the API returns it (never tokens or internal progress). Absent optional fields are omitted. */
export const toPublicPost = async (p, { storageImpl = storage } = {}) => ({
    id: String(p._id),
    ...(p.projectId ? { projectId: String(p.projectId) } : {}),
    mediaUrl: await signed(p.media?.key, storageImpl),
    caption: p.caption ?? '',
    scheduledAt: p.scheduledAt,
    status: p.status,
    mode: p.mode,
    targets: (p.targets ?? []).map((t) => ({
        platform: t.platform,
        ...(t.pageId ? { pageId: t.pageId } : {}),
        ...(t.tiktok?.privacyLevel ? { tiktok: publicTikTok(t.tiktok) } : {}),
        status: t.status,
        ...(t.externalId ? { externalId: t.externalId } : {}),
        ...(t.url ? { url: t.url } : {}),
        ...(t.error ? { error: t.error } : {}),
    })),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
});

// ---- API

export const listScheduledPosts = async (userId, { from, to } = {}, { now = Date.now() } = {}) => {
    const start = from ? parseTime(from) : now - 30 * DAY_MS;
    const end = to ? parseTime(to) : now + 90 * DAY_MS;
    if (start == null || end == null) throw new ApiError(400, 'from and to must be ISO dates.');
    if (end < start) throw new ApiError(400, '"to" must be after "from".');
    if (end - start > 400 * DAY_MS) throw new ApiError(400, 'Ask for at most 400 days at a time.');
    const posts = await ScheduledPost.find({ userId, scheduledAt: { $gte: new Date(start), $lte: new Date(end) } }).sort({ scheduledAt: 1 }).limit(500).lean();
    return { posts: await Promise.all(posts.map((p) => toPublicPost(p))) };
};

const readiness = async (userId, dryRun) => {
    const accounts = await userAccounts(userId);
    const capabilities = Object.fromEntries(PUBLISH_PLATFORMS.map((platform) => [platform, platformCapability({ platform, account: accounts[platform], providerAvailable: Boolean(PROVIDERS[platform]), dryRun })]));
    return { accounts, capabilities };
};

const scheduleOrFail = async (post) => {
    try {
        return await scheduleRun({ postId: post._id, version: post.scheduleVersion, at: new Date(post.scheduledAt).getTime() });
    } catch (e) {
        console.error('[publish] could not queue post:', e.message);
        return undefined;
    }
};

export const createScheduledPost = async (userId, body = {}, { now = Date.now(), dryRun = isPublishingDryRun() } = {}) => {
    const platforms = validatePlatforms(body.platforms);
    const caption = validateCaption(body.caption, platforms);
    const scheduledAt = validateScheduledAt(body.scheduledAt, now);
    const mode = String(body.mode ?? '');
    const { accounts, capabilities } = await readiness(userId, dryRun);
    buildTargets({ platforms, mode, accounts, capabilities, dryRun });
    const pageId = platforms.includes('facebook') ? await resolveFacebookPage({ account: accounts.facebook, pageId: body.pageId, dryRun }) : null;
    const targets = buildTargets({ platforms, mode, accounts, capabilities, dryRun, pageId });
    const { projectId, media } = await resolveMedia(userId, { projectId: body.projectId, mediaUrl: body.mediaUrl });
    const tiktokTarget = mode === 'publish' ? targets.find((t) => t.platform === 'tiktok') : null;
    if (tiktokTarget) tiktokTarget.tiktok = await checkTikTokSettings({ userId, input: body.tiktok, account: accounts.tiktok, dryRun, media, now });
    const active = await ScheduledPost.countDocuments({ userId, status: { $in: [POST_STATUS.SCHEDULED, POST_STATUS.PUBLISHING] } });
    if (active >= MAX_ACTIVE_POSTS) throw new ApiError(429, `You can have up to ${MAX_ACTIVE_POSTS} posts waiting at once.`);
    const post = await ScheduledPost.create({ userId, projectId, media, caption, scheduledAt, mode, targets, dryRun });
    const messageId = await scheduleOrFail(post);
    if (messageId === undefined) {
        await ScheduledPost.deleteOne({ _id: post._id });
        throw new ApiError(503, 'Scheduling is not available right now. Try again in a few minutes.');
    }
    await ScheduledPost.updateOne({ _id: post._id }, { $set: { queueMessageId: messageId } });
    return toPublicPost(post.toObject());
};

const ownedPost = async (userId, id) => {
    if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Post not found');
    const post = await ScheduledPost.findOne({ _id: id, userId }).lean();
    if (!post) throw new ApiError(404, 'Post not found');
    return post;
};

const notChangeable = (post) => (post.status === POST_STATUS.PUBLISHING
    ? new ApiError(409, 'This post is already being published, so it can no longer be changed.')
    : new ApiError(409, post.status === POST_STATUS.CANCELLED ? 'This post was cancelled.' : 'This post has already been sent and can no longer be changed.'));

/** Caption, time, platforms or TikTok settings, only while the post is still scheduled. */
export const updateScheduledPost = async (userId, id, body = {}, { now = Date.now(), dryRun = isPublishingDryRun() } = {}) => {
    const post = await ownedPost(userId, id);
    if (post.status !== POST_STATUS.SCHEDULED) throw notChangeable(post);
    const set = {};
    const platforms = body.platforms !== undefined ? validatePlatforms(body.platforms) : post.targets.map((t) => t.platform);
    if (body.caption !== undefined || body.platforms !== undefined) set.caption = validateCaption(body.caption !== undefined ? body.caption : post.caption, platforms);
    const testMode = dryRun || Boolean(post.dryRun);
    const currentTikTok = post.targets.find((t) => t.platform === 'tiktok') ?? null;
    const tiktokDirect = post.mode === 'publish' && platforms.includes('tiktok');
    const media = { ...post.media };
    if (body.platforms !== undefined || body.pageId !== undefined) {
        const { accounts, capabilities } = await readiness(userId, testMode);
        buildTargets({ platforms, mode: post.mode, accounts, capabilities, dryRun: testMode });
        const currentPage = post.targets.find((t) => t.platform === 'facebook')?.pageId ?? null;
        const pageId = platforms.includes('facebook') ? await resolveFacebookPage({ account: accounts.facebook, pageId: body.pageId ?? currentPage, dryRun: testMode }) : null;
        set.targets = buildTargets({ platforms, mode: post.mode, accounts, capabilities, dryRun: testMode, pageId });
        const target = tiktokDirect ? set.targets.find((t) => t.platform === 'tiktok') : null;
        // New settings, or the stored ones checked again against the creator's options today.
        if (target) {
            const kept = body.tiktok === undefined && currentTikTok?.tiktok ? currentTikTok.tiktok : null;
            const checked = await checkTikTokSettings({ userId, input: kept ? publicTikTok(kept) : body.tiktok, account: accounts.tiktok, dryRun: testMode, media, now });
            // Kept settings keep the time the creator agreed to the declaration.
            target.tiktok = kept?.confirmedAt ? { ...checked, confirmedAt: kept.confirmedAt } : checked;
        }
    } else if (body.tiktok !== undefined && tiktokDirect && currentTikTok) {
        const account = currentTikTok.accountId ? await ConnectedAccount.findOne({ _id: currentTikTok.accountId, userId }).lean() : null;
        const tiktok = await checkTikTokSettings({ userId, input: body.tiktok, account, dryRun: testMode, media, now });
        set.targets = post.targets.map((t) => (t.platform === 'tiktok' ? { ...t, tiktok } : t));
    }
    if (media.durationSec != null && media.durationSec !== post.media?.durationSec) set['media.durationSec'] = media.durationSec;
    const moved = body.scheduledAt !== undefined && validateScheduledAt(body.scheduledAt, now).getTime() !== new Date(post.scheduledAt).getTime();
    if (moved) {
        set.scheduledAt = validateScheduledAt(body.scheduledAt, now);
        set.scheduleVersion = (post.scheduleVersion ?? 1) + 1;
    }
    if (!Object.keys(set).length) return toPublicPost(post);
    const updated = await ScheduledPost.findOneAndUpdate({ _id: post._id, userId, status: POST_STATUS.SCHEDULED, scheduleVersion: post.scheduleVersion }, { $set: set }, { new: true, lean: true });
    if (!updated) throw notChangeable(await ownedPost(userId, id));
    if (!moved) return toPublicPost(updated);
    const messageId = await scheduleOrFail(updated);
    if (messageId === undefined) {
        // Keep the old time (its queued message is still valid) rather than a time nothing will act on.
        await ScheduledPost.updateOne({ _id: post._id, scheduleVersion: updated.scheduleVersion }, { $set: { scheduledAt: post.scheduledAt, scheduleVersion: post.scheduleVersion } });
        throw new ApiError(503, 'Rescheduling is not available right now. Your post keeps its previous time.');
    }
    await ScheduledPost.updateOne({ _id: post._id }, { $set: { queueMessageId: messageId } });
    await cancelRun(post.queueMessageId);
    return toPublicPost({ ...updated, queueMessageId: messageId });
};

/** Cancels a post that has not started publishing. Cancelling twice returns the cancelled post. */
export const cancelScheduledPost = async (userId, id) => {
    const post = await ownedPost(userId, id);
    if (post.status === POST_STATUS.CANCELLED) return toPublicPost(post);
    const updated = await ScheduledPost.findOneAndUpdate(
        { _id: post._id, userId, status: POST_STATUS.SCHEDULED },
        { $set: { status: POST_STATUS.CANCELLED, 'targets.$[].status': TARGET_STATUS.CANCELLED, completedAt: new Date() } },
        { new: true, lean: true },
    );
    if (!updated) throw notChangeable(await ownedPost(userId, id));
    await cancelRun(post.queueMessageId);
    return toPublicPost(updated);
};
