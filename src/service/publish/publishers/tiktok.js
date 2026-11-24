import { call, httpFailure, permanent, reconnect, transient } from './index.js';

/**
 * TikTok Content Posting API (https://developers.tiktok.com/doc/content-posting-api-get-started).
 * mode 'publish': Direct Post (scope video.publish): creator_info/query, then /post/publish/video/init/.
 *   Until TikTok audits the app, only SELF_ONLY posts to private accounts work; TIKTOK_DIRECT_POST_AUDITED=true
 *   (after the audit) posts publicly when the creator allows it.
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

/** Body of the init call (exported for tests). Privacy: audited apps post publicly when allowed, else SELF_ONLY. */
export const buildTikTokInit = ({ mode, caption, sizeBytes, creator = {}, env = process.env }) => {
    const plan = tiktokChunkPlan(sizeBytes);
    const source_info = { source: 'FILE_UPLOAD', video_size: sizeBytes, chunk_size: plan.chunkSize, total_chunk_count: plan.totalChunkCount };
    if (mode === 'draft') return { url: `${API}/post/publish/inbox/video/init/`, body: { source_info }, plan };
    const options = creator.privacy_level_options ?? [];
    const audited = String(env.TIKTOK_DIRECT_POST_AUDITED ?? '').trim().toLowerCase() === 'true';
    const privacy_level = audited && options.includes('PUBLIC_TO_EVERYONE') ? 'PUBLIC_TO_EVERYONE' : 'SELF_ONLY';
    return {
        url: `${API}/post/publish/video/init/`,
        body: {
            post_info: {
                title: String(caption ?? '').slice(0, 2200),
                privacy_level,
                disable_comment: Boolean(creator.comment_disabled),
                disable_duet: Boolean(creator.duet_disabled),
                disable_stitch: Boolean(creator.stitch_disabled),
                brand_content_toggle: false,
                brand_organic_toggle: false,
            },
            source_info,
        },
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
        // An upload that never completed cannot post, so starting over is safe; a completed one is only polled.
        if (!state.publishId || !state.uploaded) {
            let creator = {};
            if (post.mode !== 'draft') {
                const info = await call(`${API}/post/publish/creator_info/query/`, { method: 'POST', headers: authed(access), json: {}, fetchImpl, name: NAME });
                if (failed(info)) throw failure(info);
                creator = info.body?.data ?? {};
                const max = Number(creator.max_video_post_duration_sec);
                if (max > 0 && media.durationSec && media.durationSec > max) throw permanent(`Your TikTok account accepts videos up to ${max} seconds.`);
            }
            const init = buildTikTokInit({ mode: post.mode, caption: post.caption, sizeBytes: media.sizeBytes, creator, env });
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
