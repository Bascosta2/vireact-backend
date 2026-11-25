import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { ConnectedAccount, ConnectedPost, AccountOAuthState, ACCOUNT_STATUS } from '../../model/connected-account.model.js';
import { Video } from '../../model/video.model.js';
import { ANALYSIS_STATUS } from '../../constants.js';
import { ApiError } from '../../utils/ApiError.js';
import { decryptToken, encryptToken, isTokenKeyConfigured } from './token-crypto.js';
import { tiktok, TIKTOK_PUBLISH_SCOPES } from './providers/tiktok.js';
import { youtube, YOUTUBE_PUBLISH_SCOPES } from './providers/youtube.js';
import { instagram, INSTAGRAM_PUBLISH_SCOPES } from './providers/instagram.js';
import { facebook } from './providers/facebook.js';
import { recordConnectedReadings } from '../performance.service.js';

/**
 * Connected accounts (Accounts tab). A user signs in with TikTok, YouTube, Instagram or Facebook; we store the
 * tokens encrypted, read their recent posts and each post's numbers every day, and copy readings at
 * 24 h, 3 d, 7 d, 30 d and 90 d after posting into the matching Vireact upload, where the report, the
 * prediction learning loop and the learning engine pick them up as verified results.
 *
 * A post is matched to an upload automatically when exactly one upload fits (same length within
 * 1.5 s, uploaded up to 30 days before the post); otherwise the user picks in the Accounts tab.
 *
 * Settings: ACCOUNTS_TOKEN_KEY (required), BACKEND_URL (callback base), FRONTEND_URL (where the user
 * returns), the platform keys (providers/*.js), ACCOUNTS_ENABLED / ACCOUNTS_BETA_EMAILS (config/flags.js).
 */

export const PROVIDERS = Object.freeze({ tiktok, youtube, instagram, facebook });
export const MILESTONE_HOURS = Object.freeze([24, 72, 168, 720, 2160]);
const STATE_TTL_MS = 15 * 60 * 1000;
const MAX_READINGS = 120;
const MAX_POSTS = 60;
const MIN_MANUAL_SYNC_MS = 10 * 60 * 1000;
/** Refresh access tokens this long before they expire. */
const REFRESH_EARLY_MS = 10 * 60 * 1000;
/** Instagram long-lived tokens (60 days) are refreshed once they are this old. */
const IG_REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const providerFor = (platform) => {
    const p = PROVIDERS[platform];
    if (!p) throw new ApiError(404, 'Unknown platform');
    return p;
};

export const callbackUrl = (platform, env = process.env) => `${String(env.BACKEND_URL ?? '').replace(/\/+$/, '')}/api/v1/accounts/callback/${platform}`;
export const returnUrl = (query, env = process.env) => `${String(env.FRONTEND_URL ?? '').replace(/\/+$/, '')}/accounts?${new URLSearchParams(query)}`;

/** Which platforms can be connected right now (keys present, token key and callback base set). */
export const platformStatus = (env = process.env) => {
    const base = isTokenKeyConfigured(env) && Boolean(String(env.BACKEND_URL ?? '').trim());
    return Object.values(PROVIDERS).map((p) => ({ id: p.id, name: p.name, configured: base && p.isConfigured(env) }));
};

/** What the web app may see of an account (never tokens). */
export const toPublicAccount = (a, counts = {}) => ({
    id: String(a._id), platform: a.platform, handle: a.handle ?? null, displayName: a.displayName ?? null, avatarUrl: a.avatarUrl ?? null,
    followers: a.followers ?? null, status: a.status, connectedAt: a.connectedAt, lastSyncAt: a.lastSyncAt ?? null, lastSyncError: a.lastSyncError ?? null,
    posts: counts.posts ?? 0, linked: counts.linked ?? 0,
});

/**
 * Extra scopes asked for only when the user opts in to scheduled posting (startConnect scopes 'publish').
 * The normal connect flow stays read-only. Facebook's provider lives in providers/facebook.js when present;
 * its Page posting permission is listed here so publishing does not depend on that file's contents.
 */
export const PUBLISH_SCOPES = Object.freeze({
    tiktok: TIKTOK_PUBLISH_SCOPES,
    youtube: YOUTUBE_PUBLISH_SCOPES,
    instagram: INSTAGRAM_PUBLISH_SCOPES,
    facebook: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
});

/** Adds scopes to a sign-in URL's `scope` parameter, keeping the provider's own list and separator. */
export const withExtraScopes = (url, extra = []) => {
    const u = new URL(url);
    const current = u.searchParams.get('scope') ?? '';
    const sep = current.includes(' ') || current.includes('/') ? ' ' : ',';
    const all = [...new Set([...current.split(/[,\s]+/).filter(Boolean), ...extra])];
    u.searchParams.set('scope', all.join(sep));
    return u.toString();
};

// ---- sign-in

/**
 * Starts a sign-in: stores a one-time state (and PKCE verifier) and returns the platform's sign-in URL.
 * `scopes: 'publish'` also asks for the platform's posting permission (PUBLISH_SCOPES); the default is read-only.
 */
export const startConnect = async (userId, platform, { env = process.env, scopes = 'read' } = {}) => {
    const p = providerFor(platform);
    if (!platformStatus(env).find((s) => s.id === platform)?.configured) {
        throw new ApiError(503, `${p.name} connections are not available yet.`, { code: 'PLATFORM_NOT_CONFIGURED' });
    }
    if (scopes === 'publish' && !PUBLISH_SCOPES[platform]) throw new ApiError(400, `Posting to ${p.name} is not available yet.`);
    const state = b64url(crypto.randomBytes(24));
    const codeVerifier = p.usesPkce ? b64url(crypto.randomBytes(48)) : null;
    await AccountOAuthState.create({ stateHash: sha256(state), userId, platform, codeVerifier, expiresAt: new Date(Date.now() + STATE_TTL_MS) });
    const codeChallenge = codeVerifier ? b64url(crypto.createHash('sha256').update(codeVerifier).digest()) : undefined;
    const url = p.authUrl({ state, redirectUri: callbackUrl(platform, env), codeChallenge, env });
    return { url: scopes === 'publish' ? withExtraScopes(url, PUBLISH_SCOPES[platform]) : url };
};

const sealTokens = (t) => ({
    access: encryptToken(t.access), refresh: encryptToken(t.refresh), accessExpiresAt: t.accessExpiresAt ?? null,
    refreshExpiresAt: t.refreshExpiresAt ?? null, scopes: t.scopes ?? [],
});

/**
 * The platform sent the user back. Verifies the state, exchanges the code, stores the account and starts a
 * first sync in the background. Returns the URL to send the browser to (the Accounts tab, with the outcome).
 */
export const finishConnect = async (platform, { code, state, error, errorDescription } = {}, { env = process.env, fetchImpl, syncInBackground = true } = {}) => {
    const p = PROVIDERS[platform];
    if (!p) return returnUrl({ error: 'unknown_platform' }, env);
    if (!state) return returnUrl({ error: 'missing_state', platform }, env);
    const pending = await AccountOAuthState.findOneAndDelete({ stateHash: sha256(String(state)), platform });
    if (!pending || pending.expiresAt < new Date()) return returnUrl({ error: 'expired', platform }, env);
    if (error || !code) return returnUrl({ error: error === 'access_denied' ? 'denied' : 'failed', platform, ...(errorDescription ? { detail: String(errorDescription).slice(0, 120) } : {}) }, env);
    try {
        const tokens = await p.exchangeCode({ code: String(code), redirectUri: callbackUrl(platform, env), codeVerifier: pending.codeVerifier, env, fetchImpl });
        const profile = await p.profile({ access: tokens.access, env, fetchImpl });
        if (!profile?.externalId) throw new Error('the platform returned no account id');
        const account = await ConnectedAccount.findOneAndUpdate(
            { userId: pending.userId, platform, externalId: String(profile.externalId) },
            {
                $set: {
                    handle: profile.handle ?? null, displayName: profile.displayName ?? null, avatarUrl: profile.avatarUrl ?? null,
                    followers: profile.followers ?? null, uploadsPlaylistId: profile.uploadsPlaylistId ?? null, tokens: sealTokens(tokens),
                    status: ACCOUNT_STATUS.ACTIVE, lastSyncError: null,
                },
                $setOnInsert: { connectedAt: new Date() },
            },
            { upsert: true, new: true },
        );
        if (syncInBackground) {
            syncAccount(account._id, { env, fetchImpl }).catch((e) => console.warn(`[accounts] first sync of ${account._id} failed: ${e.message}`));
        }
        return returnUrl({ connected: platform }, env);
    } catch (e) {
        console.warn(`[accounts] ${platform} sign-in failed: ${e.message}`);
        return returnUrl({ error: 'failed', platform }, env);
    }
};

// ---- tokens

/** A valid access token for the account, refreshing it when it is about to expire. */
export const accessTokenFor = async (account, { env = process.env, fetchImpl, now = Date.now() } = {}) => {
    const p = providerFor(account.platform);
    const access = decryptToken(account.tokens?.access);
    const expires = account.tokens?.accessExpiresAt ? new Date(account.tokens.accessExpiresAt).getTime() : null;
    const stale = p.refreshesWithAccessToken
        ? expires != null && expires - now < 60 * DAY_MS - IG_REFRESH_AFTER_MS
        : expires != null && expires - now < REFRESH_EARLY_MS;
    if (!stale) return access;
    if (p.refreshesWithAccessToken) {
        if (expires <= now) return access; // expired: the next call fails and asks the user to reconnect
        const t = await p.refresh({ access, env, fetchImpl });
        await ConnectedAccount.updateOne({ _id: account._id }, { $set: { 'tokens.access': encryptToken(t.access), 'tokens.accessExpiresAt': t.accessExpiresAt } });
        return t.access;
    }
    const refreshToken = decryptToken(account.tokens?.refresh);
    if (!refreshToken) return access;
    const t = await p.refresh({ refreshToken, env, fetchImpl });
    await ConnectedAccount.updateOne({ _id: account._id }, {
        $set: {
            'tokens.access': encryptToken(t.access), 'tokens.accessExpiresAt': t.accessExpiresAt ?? null,
            ...(t.refresh ? { 'tokens.refresh': encryptToken(t.refresh) } : {}), ...(t.refreshExpiresAt ? { 'tokens.refreshExpiresAt': t.refreshExpiresAt } : {}),
        },
    });
    return t.access;
};

// ---- matching posts to uploads

/**
 * Uploads a post could be: analyzed uploads by the same user, made in the 30 days before the post (or a
 * day after), ranked by how close their length is. `clear` is set when exactly one is within 1.5 s.
 */
export const matchCandidates = (post, videos) => {
    const posted = post.postedAt ? new Date(post.postedAt).getTime() : null;
    const scored = videos
        .filter((v) => {
            if (!posted) return true;
            const made = new Date(v.createdAt).getTime();
            return made <= posted + DAY_MS && made >= posted - 30 * DAY_MS;
        })
        .map((v) => ({ v, gap: post.durationSec != null && v.duration != null ? Math.abs(Number(v.duration) - Number(post.durationSec)) : null }))
        .filter((x) => x.gap == null || x.gap <= 3)
        .sort((a, b) => (a.gap ?? 99) - (b.gap ?? 99));
    const close = scored.filter((x) => x.gap != null && x.gap <= 1.5);
    return { candidates: scored.slice(0, 5).map((x) => ({ videoId: String(x.v._id), title: x.v.sourceTitle || x.v.filename || 'Upload', durationSec: x.v.duration ?? null, createdAt: x.v.createdAt, gapSec: x.gap })), clear: close.length === 1 ? String(close[0].v._id) : null };
};

const ageHours = (postedAt, at) => (postedAt ? Math.max(0, (new Date(at).getTime() - new Date(postedAt).getTime()) / 3_600_000) : null);

/** Readings (newest last) that cross a milestone not sent yet: the first reading at or after each one. */
export const dueMilestones = (post) => {
    const sent = new Set(post.milestonesSent ?? []);
    const out = [];
    for (const h of MILESTONE_HOURS) {
        if (sent.has(h)) continue;
        const r = (post.readings ?? []).find((x) => x.ageHours != null && x.ageHours >= h && x.views != null);
        if (r) out.push({ hours: h, reading: r });
    }
    return out;
};

/** Copies due milestone readings into the linked upload's performance snapshots. */
const sendMilestones = async (post, account) => {
    if (!post.videoId) return 0;
    const due = dueMilestones(post);
    if (!due.length) return 0;
    await recordConnectedReadings(post.videoId, post.userId, {
        source: post.platform, postUrl: post.url, postedAt: post.postedAt, followers: account?.followers ?? null,
        readings: due.map((d) => ({ capturedAt: d.reading.at, views: d.reading.views, likes: d.reading.likes, comments: d.reading.comments, shares: d.reading.shares, saves: d.reading.saves })),
    });
    await ConnectedPost.updateOne({ _id: post._id }, { $addToSet: { milestonesSent: { $each: due.map((d) => d.hours) } } });
    return due.length;
};

// ---- sync

/**
 * Reads the account's recent posts and their numbers, stores a reading per post, matches new posts to
 * uploads, and sends due milestones. Returns counts. A refused token marks the account needs_reauth.
 */
export const syncAccount = async (accountId, { env = process.env, fetchImpl, now = Date.now() } = {}) => {
    const account = await ConnectedAccount.findById(accountId);
    if (!account) throw new ApiError(404, 'Account not found');
    const p = providerFor(account.platform);
    const counts = { posts: 0, newPosts: 0, autoLinked: 0, milestones: 0 };
    try {
        const access = await accessTokenFor(account, { env, fetchImpl, now });
        const profile = await p.profile({ access, env, fetchImpl }).catch(() => null);
        if (profile) {
            Object.assign(account, { followers: profile.followers ?? account.followers, handle: profile.handle ?? account.handle, avatarUrl: profile.avatarUrl ?? account.avatarUrl, ...(profile.uploadsPlaylistId ? { uploadsPlaylistId: profile.uploadsPlaylistId } : {}) });
        }
        const posts = await p.listPosts({ access, account, maxPosts: MAX_POSTS, env, now, fetchImpl });
        const uploads = await Video.find({ uploader_id: account.userId, analysisStatus: ANALYSIS_STATUS.COMPLETED })
            .select('_id duration createdAt sourceTitle filename').sort({ createdAt: -1 }).limit(300).lean();
        const taken = new Set((await ConnectedPost.find({ userId: account.userId, videoId: { $ne: null } }).select('videoId').lean()).map((x) => String(x.videoId)));
        const at = new Date(now);
        for (const item of posts) {
            const reading = { at, ageHours: ageHours(item.postedAt, at), ...pickStats(item.stats) };
            const existing = await ConnectedPost.findOne({ accountId: account._id, externalId: item.externalId });
            const doc = existing ?? new ConnectedPost({ accountId: account._id, userId: account.userId, platform: account.platform, externalId: item.externalId });
            Object.assign(doc, {
                url: item.url ?? doc.url, caption: item.caption ?? doc.caption, postedAt: item.postedAt ?? doc.postedAt, durationSec: item.durationSec ?? doc.durationSec,
                thumbnailUrl: item.thumbnailUrl ?? doc.thumbnailUrl, mediaType: item.mediaType ?? doc.mediaType, latest: reading,
                ...(item.retention ? { retention: item.retention } : {}),
            });
            // One reading per day is enough; a manual sync the same day replaces that day's reading.
            const sameDay = doc.readings.length && new Date(doc.readings.at(-1).at).toISOString().slice(0, 10) === at.toISOString().slice(0, 10);
            if (sameDay) doc.readings.pop();
            doc.readings.push(reading);
            if (doc.readings.length > MAX_READINGS) doc.readings.splice(0, doc.readings.length - MAX_READINGS);
            if (!existing) {
                counts.newPosts += 1;
                const { clear } = matchCandidates(doc, uploads.filter((u) => !taken.has(String(u._id))));
                if (clear) {
                    doc.videoId = clear;
                    doc.linkSource = 'auto';
                    taken.add(clear);
                    counts.autoLinked += 1;
                }
            }
            await doc.save();
            counts.milestones += await sendMilestones(doc, account);
            counts.posts += 1;
        }
        Object.assign(account, { lastSyncAt: at, lastSyncError: null, lastSyncCounts: counts, status: ACCOUNT_STATUS.ACTIVE });
        await account.save();
        return counts;
    } catch (e) {
        await ConnectedAccount.updateOne({ _id: account._id }, {
            $set: { lastSyncAt: new Date(now), lastSyncError: String(e.message).slice(0, 300), ...(e.reauth ? { status: ACCOUNT_STATUS.NEEDS_REAUTH } : {}) },
        });
        throw e;
    }
};

const pickStats = (s = {}) => Object.fromEntries(['views', 'likes', 'comments', 'shares', 'saves', 'reach', 'avgWatchSec', 'avgViewPct'].map((k) => [k, s[k] ?? null]));

/** Daily: every active account, one at a time. Never throws. */
export const syncAllAccounts = async ({ env = process.env, fetchImpl, now = Date.now(), log = () => {} } = {}) => {
    const out = { accounts: 0, synced: 0, failed: 0, needsReauth: 0, posts: 0, milestones: 0 };
    if (!isTokenKeyConfigured(env)) return { ...out, skipped: 'ACCOUNTS_TOKEN_KEY not set' };
    const accounts = await ConnectedAccount.find({ status: ACCOUNT_STATUS.ACTIVE }).select('_id').lean();
    out.accounts = accounts.length;
    for (const a of accounts) {
        try {
            const c = await syncAccount(a._id, { env, fetchImpl, now });
            out.synced += 1;
            out.posts += c.posts;
            out.milestones += c.milestones;
        } catch (e) {
            out.failed += 1;
            if (e.reauth) out.needsReauth += 1;
            log(`accounts: ${a._id} failed: ${e.message}`);
        }
    }
    return out;
};

// ---- the Accounts tab

export const listAccounts = async (userId, { env = process.env } = {}) => {
    const accounts = await ConnectedAccount.find({ userId }).sort({ connectedAt: 1 }).lean();
    const counts = await ConnectedPost.aggregate([
        { $match: { userId: new mongoose.Types.ObjectId(String(userId)) } },
        { $group: { _id: '$accountId', posts: { $sum: 1 }, linked: { $sum: { $cond: [{ $ne: ['$videoId', null] }, 1, 0] } } } },
    ]);
    const byId = new Map(counts.map((c) => [String(c._id), c]));
    return { platforms: platformStatus(env), accounts: accounts.map((a) => toPublicAccount(a, byId.get(String(a._id)))) };
};

const ownedAccount = async (userId, id) => {
    if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Account not found');
    const a = await ConnectedAccount.findOne({ _id: id, userId });
    if (!a) throw new ApiError(404, 'Account not found');
    return a;
};

export const syncNow = async (userId, id, { env = process.env, fetchImpl, now = Date.now() } = {}) => {
    const a = await ownedAccount(userId, id);
    if (a.lastSyncAt && now - new Date(a.lastSyncAt).getTime() < MIN_MANUAL_SYNC_MS && a.status === ACCOUNT_STATUS.ACTIVE && !a.lastSyncError) {
        throw new ApiError(429, 'This account was refreshed a few minutes ago. Try again shortly.');
    }
    try {
        await syncAccount(a._id, { env, fetchImpl, now });
    } catch (e) {
        if (e.reauth) throw new ApiError(409, `${providerFor(a.platform).name} needs you to connect again.`, { code: 'NEEDS_REAUTH' });
        throw new ApiError(502, `Could not reach ${providerFor(a.platform).name} right now. Try again later.`);
    }
    return toPublicAccount(await ConnectedAccount.findById(a._id).lean());
};

/** Disconnect: revoke at the platform when it allows, then delete the tokens and the post readings. */
export const disconnect = async (userId, id, { env = process.env, fetchImpl } = {}) => {
    const a = await ownedAccount(userId, id);
    const p = providerFor(a.platform);
    if (p.revoke) {
        try { await p.revoke({ access: decryptToken(a.tokens?.access), env, fetchImpl }); } catch { /* best effort */ }
    }
    await ConnectedPost.deleteMany({ accountId: a._id });
    await ConnectedAccount.deleteOne({ _id: a._id });
    return { ok: true };
};

const toPublicPost = (p, candidates = []) => ({
    id: String(p._id), accountId: String(p.accountId), platform: p.platform, url: p.url, caption: p.caption, postedAt: p.postedAt,
    durationSec: p.durationSec ?? null, thumbnailUrl: p.thumbnailUrl, mediaType: p.mediaType, latest: p.latest ?? null,
    readings: (p.readings ?? []).map((r) => ({ at: r.at, ageHours: r.ageHours, views: r.views })),
    retention: p.retention ?? null, videoId: p.videoId ? String(p.videoId) : null, linkSource: p.linkSource ?? null, candidates,
});

export const listPosts = async (userId, { accountId = null, limit = 60 } = {}) => {
    const filter = { userId };
    if (accountId) {
        if (!mongoose.isValidObjectId(accountId)) throw new ApiError(404, 'Account not found');
        filter.accountId = accountId;
    }
    const posts = await ConnectedPost.find(filter).sort({ postedAt: -1 }).limit(Math.min(200, Math.max(1, Number(limit) || 60))).lean();
    const unlinked = posts.filter((p) => !p.videoId);
    let uploads = [];
    if (unlinked.length) {
        const taken = new Set((await ConnectedPost.find({ userId, videoId: { $ne: null } }).select('videoId').lean()).map((x) => String(x.videoId)));
        uploads = (await Video.find({ uploader_id: userId, analysisStatus: ANALYSIS_STATUS.COMPLETED }).select('_id duration createdAt sourceTitle filename').sort({ createdAt: -1 }).limit(300).lean())
            .filter((u) => !taken.has(String(u._id)));
    }
    const titles = new Map((await Video.find({ _id: { $in: posts.filter((p) => p.videoId).map((p) => p.videoId) } }).select('sourceTitle filename').lean())
        .map((v) => [String(v._id), v.sourceTitle || v.filename || 'Upload']));
    return {
        posts: posts.map((p) => ({ ...toPublicPost(p, p.videoId ? [] : matchCandidates(p, uploads).candidates), videoTitle: p.videoId ? titles.get(String(p.videoId)) ?? null : null })),
    };
};

/** The user links a post to one of their uploads (or unlinks it with videoId null). */
export const linkPost = async (userId, postId, videoId) => {
    if (!mongoose.isValidObjectId(postId)) throw new ApiError(404, 'Post not found');
    const post = await ConnectedPost.findOne({ _id: postId, userId });
    if (!post) throw new ApiError(404, 'Post not found');
    if (videoId == null) {
        post.videoId = null;
        post.linkSource = null;
        post.milestonesSent = [];
        await post.save();
        return toPublicPost(post.toObject());
    }
    if (!mongoose.isValidObjectId(videoId) || !(await Video.exists({ _id: videoId, uploader_id: userId }))) throw new ApiError(404, 'Video not found');
    await ConnectedPost.updateMany({ userId, videoId, _id: { $ne: post._id } }, { $set: { videoId: null, linkSource: null, milestonesSent: [] } });
    post.videoId = videoId;
    post.linkSource = 'user';
    post.milestonesSent = [];
    await post.save();
    const account = await ConnectedAccount.findById(post.accountId).select('followers').lean();
    await sendMilestones(post, account);
    return toPublicPost((await ConnectedPost.findById(post._id).lean()));
};

/** Account deletion: remove every connection and reading of the user. */
export const removeUserAccounts = async (userId) => {
    await ConnectedPost.deleteMany({ userId });
    await ConnectedAccount.deleteMany({ userId });
    await AccountOAuthState.deleteMany({ userId });
};
