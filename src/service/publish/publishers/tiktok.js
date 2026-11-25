import { call, httpFailure, permanent, reconnect, transient } from './index.js';

/**
 * TikTok Content Posting API (https://developers.tiktok.com/doc/content-posting-api-get-started).
 * mode 'publish': Direct Post (scope video.publish): creator_info/query, then /post/publish/video/init/ with the
 *   creator's own choices stored on the target (`target.tiktok`: privacy, comments/duet/stitch, commercial
 *   disclosure), per the content sharing guidelines (https://developers.tiktok.com/doc/content-sharing-guidelines).
 *   We never pick or change the privacy level: a choice TikTok no longer offers fails the target in plain English.
 *   Until TikTok audits the app only SELF_ONLY works; TIKTOK_DIRECT_POST_AUDITED=true (after the audit) allows the rest.
 * mode 'draft': upload to the creator's TikTok inbox (scope video.upload): /post/publish/inbox/video/init/;
 *   the creator finishes the post in the TikTok app. "published" here means "delivered to TikTok as a draft".
 * Bytes go up with FILE_UPLOAD (chunked PUTs read from our bucket by range), so no domain verification is needed.
 */

const API = 'https://open.tiktokapis.com/v2';
const NAME = 'TikTok';
const MB = 1024 * 1024;
export const TIKTOK_CHUNK = 10 * MB;
const SINGLE_CHUNK_MAX = 64 * MB;
const STATUS_CHECK_SEC = 30;

/**
 * FILE_UPLOAD chunk plan per the media transfer guide: one chunk up to 64 MB; otherwise 10 MB chunks,
 * count = floor(size / chunk), the last chunk takes the remainder (< 20 MB, under the 128 MB cap).
 */
export const tiktokChunkPlan = (size) => {
    if (!(size > 0)) throw permanent('This video file is empty.');
    if (size <= SINGLE_CHUNK_MAX) return { chunkSize: size, totalChunkCount: 1, ranges: [[0, size - 1]] };
    const totalChunkCount = Math.floor(size / TIKTOK_CHUNK);
    const ranges = [];
    for (let i = 0; i < totalChunkCount; i++) {
        const start = i * TIKTOK_CHUNK;
        ranges.push([start, i === totalChunkCount - 1 ? size - 1 : start + TIKTOK_CHUNK - 1]);
    }
    return { chunkSize: TIKTOK_CHUNK, totalChunkCount, ranges };
};

const MESSAGES = {
    unaudited_client_can_only_post_to_private_accounts: 'TikTok only lets apps that have not finished its review post to private accounts. Choose "Save as draft" instead, or make your TikTok account private while testing.',
    spam_risk_too_many_posts: 'Your TikTok account reached its daily posting limit. Try again tomorrow.',
    spam_risk_user_banned_from_posting: 'TikTok is not letting this account post right now.',
    spam_risk_too_many_pending_share: 'You already have 5 Vireact drafts waiting in your TikTok inbox. Post or delete them in the TikTok app, then try again.',
    reached_active_user_cap: 'Vireact reached TikTok\'s daily limit for posting apps. Try again tomorrow.',
    privacy_level_option_mismatch: 'TikTok did not accept the privacy setting for this post. Check your TikTok privacy settings and try again.',
    scope_not_authorized: 'TikTok did not give Vireact permission to post. Reconnect TikTok with posting allowed in the Accounts tab.',
    url_ownership_unverified: 'TikTok could not fetch the video. Try again later.',
};

const FAIL_REASONS = {
    file_format_check_failed: 'TikTok could not read this video file. Export it again as MP4 and retry.',
    duration_check_failed: 'This video is too long or too short for your TikTok account.',
    frame_rate_check_failed: 'TikTok does not accept this video\'s frame rate.',
    picture_size_check_failed: 'TikTok does not accept this video\'s resolution.',
    publish_cancelled: 'The post was cancelled in TikTok.',
    auth_removed: 'You removed Vireact\'s access in TikTok. Reconnect your TikTok account in the Accounts tab.',
    spam_risk_too_many_posts: MESSAGES.spam_risk_too_many_posts,
    spam_risk_user_banned_from_posting: MESSAGES.spam_risk_user_banned_from_posting,
    spam_risk_text: 'TikTok flagged the caption. Edit the caption and schedule again.',
    spam_risk: 'TikTok declined this post as possible spam.',
    video_pull_failed: 'TikTok could not download the video.',
};

/** TikTok answers 200 with error.code != 'ok' for some refusals, so both the status and the code matter. */
const failure = (res) => {
    const code = res.body?.error?.code;
    if (code === 'access_token_invalid') return reconnect(NAME);
    if (code === 'rate_limit_exceeded' || res.status === 429) return transient('TikTok is limiting how fast we can post right now. We will try again shortly.', { retryAfterSec: 120 });
    if (code === 'internal_error') return transient('TikTok had a temporary problem. We will try again shortly.');
    if (MESSAGES[code]) return permanent(MESSAGES[code]);
    if (code === 'invalid_param') return permanent(`TikTok rejected this post: ${res.body?.error?.message || 'invalid request'}`);
    return httpFailure(NAME, res);
};
const failed = (res) => !res.ok || (res.body?.error?.code && res.body.error.code !== 'ok');

const authed = (access) => ({ Authorization: `Bearer ${access}` });

/** Privacy levels TikTok can offer (creator_info returns the ones this creator may use), with their app labels. */
export const TIKTOK_PRIVACY_LABELS = Object.freeze({
    PUBLIC_TO_EVERYONE: 'Everyone',
    MUTUAL_FOLLOW_FRIENDS: 'Friends',
    FOLLOWER_OF_CREATOR: 'Followers',
    SELF_ONLY: 'Only me',
});
export const privacyLabel = (level) => TIKTOK_PRIVACY_LABELS[level] ?? String(level);

/** True once TikTok has audited the app for Direct Post (only SELF_ONLY works before that). */
export const isDirectPostAudited = (env = process.env) => String(env.TIKTOK_DIRECT_POST_AUDITED ?? '').trim().toLowerCase() === 'true';

/**
 * creator_info/query: the creator's posting options right now. Throws a PublishError in plain English when
 * the creator cannot post (daily cap, posting ban, app cap) or the sign-in is no longer valid.
 */
export const queryCreatorInfo = async ({ access, fetchImpl }) => {
    const info = await call(`${API}/post/publish/creator_info/query/`, { method: 'POST', headers: authed(access), json: {}, fetchImpl, name: NAME });
    if (failed(info)) throw failure(info);
    return info.body?.data ?? {};
};

/** creator_info as GET /api/v1/posts/tiktok/creator-info returns it (pure; exported for tests). */
export const creatorInfoView = (data = {}) => {
    const privacyLevelOptions = (Array.isArray(data.privacy_level_options) ? data.privacy_level_options : []).filter((o) => typeof o === 'string' && o);
    const max = Number(data.max_video_post_duration_sec);
    const view = {
        nickname: data.creator_nickname ?? null,
        avatarUrl: data.creator_avatar_url ?? null,
        privacyLevelOptions,
        commentDisabled: Boolean(data.comment_disabled),
        duetDisabled: Boolean(data.duet_disabled),
        stitchDisabled: Boolean(data.stitch_disabled),
        maxVideoPostDurationSec: max > 0 ? max : null,
        canPost: privacyLevelOptions.length > 0,
    };
    if (!view.canPost) view.reason = 'TikTok did not offer any privacy options for your account right now. Try again later.';
    return view;
};

/**
 * post_info for Direct Post from the creator's stored choices and a fresh creator_info (pure; exported for tests).
 * Throws a permanent PublishError when the choices can no longer be honoured; it never substitutes others.
 */
export const tiktokPostInfo = ({ caption, settings, creator = {}, env = process.env }) => {
    const again = 'Edit the post, choose again, and schedule it again.';
    if (!settings?.privacyLevel) throw permanent(`This TikTok post has no privacy choice, so it was not sent. ${again}`);
    const level = settings.privacyLevel;
    const options = creator.privacy_level_options ?? [];
    if (!options.includes(level)) {
        throw permanent(`Your TikTok account no longer offers the privacy setting you chose ("${privacyLabel(level)}"), so we did not post it. We never change your privacy setting for you. ${again}`);
    }
    if (level !== 'SELF_ONLY' && !isDirectPostAudited(env)) {
        throw permanent(`Vireact can only post to TikTok as "Only me" until TikTok approves it for public posts, so this post was not sent. ${again}`);
    }
    const commercial = settings.commercial ?? {};
    const brandedContent = Boolean(commercial.enabled && commercial.brandedContent);
    if (brandedContent && level === 'SELF_ONLY') throw permanent(`Branded content cannot be posted as "Only me", so this post was not sent. ${again}`);
    return {
        title: String(caption ?? '').slice(0, 2200),
        privacy_level: level,
        // The creator's own app settings always win (TikTok enforces them too).
        disable_comment: !settings.allowComment || Boolean(creator.comment_disabled),
        disable_duet: !settings.allowDuet || Boolean(creator.duet_disabled),
        disable_stitch: !settings.allowStitch || Boolean(creator.stitch_disabled),
        brand_content_toggle: brandedContent,
        brand_organic_toggle: Boolean(commercial.enabled && commercial.yourBrand),
    };
};

/** Body of the init call (exported for tests). Direct Post uses the creator's settings (`target.tiktok`). */
export const buildTikTokInit = ({ mode, caption, sizeBytes, creator = {}, settings = null, env = process.env }) => {
    const plan = tiktokChunkPlan(sizeBytes);
    const source_info = { source: 'FILE_UPLOAD', video_size: sizeBytes, chunk_size: plan.chunkSize, total_chunk_count: plan.totalChunkCount };
    if (mode === 'draft') return { url: `${API}/post/publish/inbox/video/init/`, body: { source_info }, plan };
    return {
        url: `${API}/post/publish/video/init/`,
        body: { post_info: tiktokPostInfo({ caption, settings, creator, env }), source_info },
        plan,
    };
};

export const tiktokPublisher = {
    platform: 'tiktok',
    name: NAME,
    /** draft -> inbox upload; publish -> Direct Post. */
    requiredScopes: (mode) => (mode === 'draft' ? ['video.upload'] : ['video.publish']),

    async step({ post, target, account, access, media, env = process.env, fetchImpl, save }) {
        const state = { ...(target.state ?? {}) };
        if (state.publishId && !state.uploaded) {
            // A pass stopped mid-upload (e.g. the last chunk timed out after TikTok got it). Only an upload TikTok
            // says failed or is missing bytes is started again; anything else may already be posting, so poll it.
            const res = await call(`${API}/post/publish/status/fetch/`, { method: 'POST', headers: authed(access), json: { publish_id: state.publishId }, fetchImpl, name: NAME });
            const code = res.body?.error?.code;
            if (failed(res) && code !== 'invalid_publish_id') throw failure(res);
            const data = res.body?.data ?? {};
            const incomplete = code === 'invalid_publish_id' || data.status === 'FAILED' || (data.status === 'PROCESSING_UPLOAD' && Number(data.uploaded_bytes) < media.sizeBytes);
            if (!incomplete) {
                state.uploaded = true;
                await save(state);
            }
        }
        // An upload that never completed cannot post, so starting over is safe; a completed one is only polled.
        if (!state.publishId || !state.uploaded) {
            let creator = {};
            if (post.mode !== 'draft') {
                if (!target.tiktok?.privacyLevel) throw permanent('This TikTok post has no privacy choice, so it was not sent. Edit the post, choose your TikTok settings, and schedule it again.');
                // Fresh creator_info right before posting (the post may have been scheduled hours ago).
                creator = await queryCreatorInfo({ access, fetchImpl });
                const max = Number(creator.max_video_post_duration_sec);
                if (max > 0 && media.durationSec && media.durationSec > max) throw permanent(`Your TikTok account accepts videos up to ${max} seconds.`);
            }
            const init = buildTikTokInit({ mode: post.mode, caption: post.caption, sizeBytes: media.sizeBytes, creator, settings: target.tiktok ?? null, env });
            const res = await call(init.url, { method: 'POST', headers: authed(access), json: init.body, fetchImpl, name: NAME });
            if (failed(res)) throw failure(res);
            const { publish_id: publishId, upload_url: uploadUrl } = res.body?.data ?? {};
            if (!publishId || !uploadUrl) throw transient('TikTok did not start the upload. We will try again shortly.');
            Object.assign(state, { publishId, uploaded: false });
            await save(state);
            for (const [start, end] of init.plan.ranges) {
                const chunk = await media.readRange(start, end);
                const put = await call(uploadUrl, {
                    method: 'PUT', fetchImpl, name: NAME, body: chunk, timeoutMs: 5 * 60_000,
                    headers: { 'Content-Type': media.contentType || 'video/mp4', 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${media.sizeBytes}` },
                });
                if (put.status !== 201 && put.status !== 206 && !put.ok) {
                    if (put.status === 403 || put.status === 404 || put.status === 416) throw transient('The TikTok upload was interrupted. We will start it again shortly.');
                    throw httpFailure(NAME, put);
                }
            }
            state.uploaded = true;
            await save(state);
        }
        const res = await call(`${API}/post/publish/status/fetch/`, { method: 'POST', headers: authed(access), json: { publish_id: state.publishId }, fetchImpl, name: NAME });
        if (failed(res)) throw failure(res);
        const data = res.body?.data ?? {};
        if (data.status === 'PUBLISH_COMPLETE' || (post.mode === 'draft' && data.status === 'SEND_TO_USER_INBOX')) {
            const postId = data.publicaly_available_post_id?.[0];
            const handle = account?.handle ? String(account.handle).replace(/^@/, '') : null;
            return { status: 'published', externalId: String(postId ?? state.publishId), url: postId && handle ? `https://www.tiktok.com/@${handle}/video/${postId}` : null, state };
        }
        if (data.status === 'FAILED') {
            if (data.fail_reason === 'internal') throw transient('TikTok had a temporary problem processing the video. We will try again shortly.', { resetState: true });
            if (data.fail_reason === 'auth_removed') throw permanent(FAIL_REASONS.auth_removed, { reauth: true });
            throw permanent(FAIL_REASONS[data.fail_reason] ?? `TikTok could not post this video (${data.fail_reason || 'unknown reason'}).`);
        }
        return { status: 'waiting', state, retryInSec: STATUS_CHECK_SEC };
    },
};
