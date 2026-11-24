import { call, graphFailure, permanent, transient } from './index.js';

/**
 * Instagram Reels through the Instagram API with Instagram Login (scope instagram_business_content_publish),
 * https://developers.facebook.com/docs/instagram-platform/content-publishing:
 *   1. POST graph.instagram.com/<v>/<IG_ID>/media  media_type=REELS, video_url (a signed link to our bucket), caption
 *   2. GET  /<CONTAINER_ID>?fields=status_code  until FINISHED (checked about once a minute, as Meta asks)
 *   3. POST /<IG_ID>/media_publish  creation_id=<CONTAINER_ID>, then read the permalink.
 * Instagram has no drafts in its API: draft mode is refused when the post is created.
 * Limit: 50 API-published posts per account per rolling 24 hours (content_publishing_limit).
 * Container status is checked about once a minute for at most about 5 minutes, as Meta recommends.
 */

const GRAPH = 'https://graph.instagram.com';
const NAME = 'Instagram';
const version = (e) => String(e.INSTAGRAM_GRAPH_VERSION ?? '').trim() || 'v25.0';
const CHECK_SEC = 60;
/** Meta: query the container about once a minute for no more than 5 minutes. */
export const INSTAGRAM_MAX_WAIT_MS = 6 * 60 * 1000;

const failure = (res) => graphFailure(NAME, res, (code, sub) => {
    if (code === 9 || sub === 2207042) return permanent('Your Instagram account reached its limit of posts made by apps in 24 hours. Try again tomorrow.');
    if (sub === 2207026) return permanent('Instagram does not accept this video format. Reels need an MP4 (H.264, AAC) between 3 seconds and 15 minutes.');
    if (sub === 2207003 || sub === 2207020) return transient('Instagram could not download the video in time. We will try again shortly.', { resetState: true });
    return null;
});

/** Form for step 1 (exported for tests). */
export const buildReelContainer = ({ igUserId, videoUrl, caption, access, env = process.env }) => ({
    url: `${GRAPH}/${version(env)}/${igUserId}/media`,
    form: { media_type: 'REELS', video_url: videoUrl, caption: String(caption ?? '').slice(0, 2200), share_to_feed: 'true', access_token: access },
});

export const instagramPublisher = {
    platform: 'instagram',
    name: NAME,
    requiredScopes: () => ['instagram_business_content_publish'],
    supportsDraft: false,

    async step({ post, target, account, access, media, env = process.env, fetchImpl, save }) {
        const state = { ...(target.state ?? {}) };
        const v = version(env);
        const igUserId = account?.externalId;
        if (!igUserId) throw permanent('Your Instagram account is missing its id. Reconnect Instagram in the Accounts tab.');
        if (!state.containerId) {
            const req = buildReelContainer({ igUserId, videoUrl: await media.signedUrl(6 * 3600), caption: post.caption, access, env });
            const res = await call(req.url, { method: 'POST', form: req.form, fetchImpl, name: NAME });
            if (!res.ok || !res.body?.id) throw failure(res);
            state.containerId = String(res.body.id);
            await save(state);
            return { status: 'waiting', state, retryInSec: CHECK_SEC, maxWaitMs: INSTAGRAM_MAX_WAIT_MS };
        }
        if (!state.publishRequested) {
            const res = await call(`${GRAPH}/${v}/${state.containerId}?fields=status_code,status&access_token=${encodeURIComponent(access)}`, { fetchImpl, name: NAME });
            if (!res.ok) throw failure(res);
            const code = res.body?.status_code;
            if (code === 'IN_PROGRESS') return { status: 'waiting', state, retryInSec: CHECK_SEC, maxWaitMs: INSTAGRAM_MAX_WAIT_MS };
            if (code === 'EXPIRED') throw transient('Instagram let the upload expire. We will upload it again shortly.', { resetState: true });
            if (code === 'ERROR') throw permanent(`Instagram could not process this video${res.body?.status ? ` (${String(res.body.status).slice(0, 120)})` : ''}. Reels need an MP4 between 3 seconds and 15 minutes.`);
            if (code !== 'FINISHED' && code !== 'PUBLISHED') return { status: 'waiting', state, retryInSec: CHECK_SEC, maxWaitMs: INSTAGRAM_MAX_WAIT_MS };
            if (code === 'PUBLISHED') return { status: 'published', externalId: null, url: null, state };
            // Marked before the call: a crash after Instagram published must not publish again.
            state.publishRequested = true;
            await save(state);
            const pub = await call(`${GRAPH}/${v}/${igUserId}/media_publish`, { method: 'POST', form: { creation_id: state.containerId, access_token: access }, fetchImpl, name: NAME });
            if (!pub.ok || !pub.body?.id) {
                const err = failure(pub);
                // Not published: allow the publish call again on the retry.
                state.publishRequested = false;
                await save(state);
                throw err;
            }
            state.mediaId = String(pub.body.id);
            await save(state);
        }
        if (!state.mediaId) {
            // A previous pass asked Instagram to publish and then stopped: only trust the container's status.
            const res = await call(`${GRAPH}/${v}/${state.containerId}?fields=status_code&access_token=${encodeURIComponent(access)}`, { fetchImpl, name: NAME });
            if (res.ok && res.body?.status_code === 'PUBLISHED') return { status: 'published', externalId: null, url: null, state };
            if (res.ok && res.body?.status_code === 'FINISHED') {
                state.publishRequested = false;
                await save(state);
                return { status: 'waiting', state, retryInSec: 5 };
            }
            throw transient('We could not confirm the Instagram post yet. We will check again shortly.');
        }
        const link = await call(`${GRAPH}/${v}/${state.mediaId}?fields=permalink&access_token=${encodeURIComponent(access)}`, { fetchImpl, name: NAME });
        return { status: 'published', externalId: state.mediaId, url: link.ok ? link.body?.permalink ?? null : null, state };
    },
};
