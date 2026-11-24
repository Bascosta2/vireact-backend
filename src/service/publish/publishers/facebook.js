import { call, graphFailure, permanent, reconnect, transient } from './index.js';

/**
 * Facebook Page Reels (permissions pages_show_list, pages_read_engagement, pages_manage_posts),
 * https://developers.facebook.com/docs/video-api/guides/reels-publishing:
 *   1. POST graph.facebook.com/<v>/<PAGE_ID>/video_reels  upload_phase=start -> video_id, upload_url
 *   2. POST rupload.facebook.com/video-upload/<v>/<video_id>  (Authorization: OAuth <page token>, offset, file_size,
 *      body = the file streamed from our bucket). After an interruption, GET /<video_id>?fields=status gives
 *      bytes_transfered and the upload continues from there.
 *   3. POST /<PAGE_ID>/video_reels  upload_phase=finish, video_id, video_state=PUBLISHED|DRAFT, description
 * The connected account is the Facebook login (accessTokenFor gives the USER token). The Page chosen when the
 * post was scheduled (target.pageId) is looked up with the facebook provider's pages() (GET /me/accounts) and
 * its own Page access token is used for every call. Limit: 30 API-published Reels per Page per 24 hours.
 */

const GRAPH = 'https://graph.facebook.com';
const RUPLOAD = 'https://rupload.facebook.com/video-upload';
const NAME = 'Facebook';
const version = (e) => String(e.FACEBOOK_GRAPH_VERSION ?? '').trim() || 'v25.0';

const failure = (res) => graphFailure(NAME, res, (code) => {
    if (code === 1363040) return permanent('Facebook Reels need a vertical 9:16 video.');
    if (code === 1363127) return permanent('Facebook Reels need a video at least 540x960 pixels.');
    if (code === 1363128) return permanent('Facebook Reels must be between 3 and 90 seconds long.');
    if (code === 1363129) return permanent('Facebook Reels need a frame rate between 24 and 60 fps.');
    return null;
});

/** The Page (id + Page token) to post to, from the provider's pages(); plain-English errors otherwise. */
export const pageFor = async ({ provider, access, pageId, env, fetchImpl }) => {
    if (!provider?.pages) throw permanent('Facebook connections are not available yet.');
    if (!pageId) throw permanent('No Facebook Page was chosen for this post. Schedule it again and pick a Page.');
    let pages;
    try {
        pages = await provider.pages({ access, env, fetchImpl });
    } catch (e) {
        if (e.reauth) throw reconnect(NAME);
        throw transient('We could not reach Facebook to find your Page. We will try again shortly.');
    }
    const page = (pages ?? []).find((p) => String(p.id) === String(pageId));
    if (!page?.access_token) throw permanent('Vireact can no longer post to that Facebook Page. Reconnect Facebook and share the Page again, then schedule the post again.');
    return { pageId: String(page.id), pageToken: page.access_token };
};

/** Form for step 3 (exported for tests). */
export const buildReelFinish = ({ pageId, videoId, caption, mode, access, env = process.env }) => ({
    url: `${GRAPH}/${version(env)}/${pageId}/video_reels`,
    form: { upload_phase: 'finish', video_id: videoId, video_state: mode === 'draft' ? 'DRAFT' : 'PUBLISHED', description: String(caption ?? '').slice(0, 2200), access_token: access },
});

export const facebookPublisher = {
    platform: 'facebook',
    name: NAME,
    requiredScopes: () => ['pages_manage_posts'],

    async step({ post, target, access: userToken, media, env = process.env, fetchImpl, save, provider }) {
        const state = { ...(target.state ?? {}) };
        const v = version(env);
        const { pageId, pageToken: access } = await pageFor({ provider, access: userToken, pageId: target.pageId, env, fetchImpl });
        if (!state.videoId) {
            const res = await call(`${GRAPH}/${v}/${pageId}/video_reels`, { method: 'POST', form: { upload_phase: 'start', access_token: access }, fetchImpl, name: NAME });
            if (!res.ok || !res.body?.video_id) throw failure(res);
            Object.assign(state, { videoId: String(res.body.video_id), uploadUrl: res.body.upload_url ?? null, uploaded: false });
            await save(state);
        }
        if (!state.uploaded) {
            let offset = 0;
            if (state.uploadStarted) {
                // Resume from what Facebook confirms; if it cannot say, retry later rather than resend from 0.
                const st = await call(`${GRAPH}/${v}/${state.videoId}?fields=status&access_token=${encodeURIComponent(access)}`, { fetchImpl, name: NAME });
                if (!st.ok) {
                    if (Number(st.body?.error?.code) === 100) throw transient('Facebook lost the upload. We will start it again shortly.', { resetState: true });
                    throw failure(st);
                }
                const phase = st.body?.status?.uploading_phase ?? {};
                offset = phase.status === 'complete' ? media.sizeBytes : Number(phase.bytes_transfered ?? phase.bytes_transferred ?? 0) || 0;
            }
            state.uploadStarted = true;
            await save(state);
            if (offset < media.sizeBytes) {
                const res = await call(state.uploadUrl || `${RUPLOAD}/${v}/${state.videoId}`, {
                    method: 'POST', fetchImpl, name: NAME, timeoutMs: 15 * 60_000, body: await media.openStream(offset),
                    headers: { Authorization: `OAuth ${access}`, offset: String(offset), file_size: String(media.sizeBytes), 'Content-Type': 'application/octet-stream' },
                });
                if (!res.ok || res.body?.success === false) throw failure(res);
            }
            state.uploaded = true;
            await save(state);
        }
        const finish = buildReelFinish({ pageId, videoId: state.videoId, caption: post.caption, mode: post.mode, access, env });
        const res = await call(finish.url, { method: 'POST', form: finish.form, fetchImpl, name: NAME });
        // Finishing the same video_id again cannot create a second Reel, so a retry repeats this call.
        if (!res.ok || res.body?.success === false) throw failure(res);
        return { status: 'published', externalId: state.videoId, url: `https://www.facebook.com/reel/${state.videoId}`, state };
    },
};
