import { call, httpFailure, permanent, reconnect, transient } from './index.js';

/**
 * YouTube Data API v3 videos.insert with the resumable upload protocol (scope youtube.upload),
 * https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol:
 *   1. POST /upload/youtube/v3/videos?uploadType=resumable&part=snippet,status  (metadata) -> Location: session URI
 *   2. PUT chunks (multiples of 256 KB) with Content-Range; 308 = continue from the Range header; 200/201 = done.
 *   3. After an interruption: PUT Content-Range bytes * /SIZE asks how much arrived, then the rest is sent.
 * mode 'draft' uploads as private; 'publish' as public. Vertical videos up to 3 minutes become Shorts.
 * Note: until the Google Cloud project passes YouTube's API audit, uploads are locked to private.
 */

const UPLOAD = 'https://www.googleapis.com/upload/youtube/v3/videos';
const NAME = 'YouTube';
export const YOUTUBE_CHUNK = 64 * 256 * 1024; // 16 MiB, a multiple of 256 KB

const clean = (s) => String(s ?? '').replace(/[<>]/g, '');

/** Metadata for step 1 (exported for tests). Title: the caption's first line (max 100 characters). */
export const buildYouTubeMetadata = ({ caption, mode }) => {
    const text = clean(caption).trim();
    const firstLine = text.split('\n').find((l) => l.trim())?.trim() ?? '';
    const title = Array.from(firstLine || 'New video').slice(0, 100).join('');
    let description = text;
    while (Buffer.byteLength(description, 'utf8') > 5000) description = description.slice(0, -1);
    return {
        snippet: { title, description, categoryId: '22' },
        status: { privacyStatus: mode === 'draft' ? 'private' : 'public', selfDeclaredMadeForKids: false },
    };
};

const reasonOf = (body) => body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? null;

const failure = (res) => {
    const reason = reasonOf(res.body);
    if (res.status === 401) return reconnect(NAME);
    if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded') {
        return transient('YouTube\'s daily upload allowance for Vireact ran out. We will try again later.', { retryAfterSec: 3 * 3600 });
    }
    if (reason === 'uploadLimitExceeded') return permanent('Your YouTube channel reached its upload limit for today. Try again tomorrow.');
    if (reason === 'insufficientPermissions' || reason === 'forbidden' || reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') {
        return permanent('YouTube did not give Vireact permission to upload. Reconnect YouTube with uploading allowed in the Accounts tab.');
    }
    if (reason === 'youtubeSignupRequired') return permanent('This Google account has no YouTube channel yet. Create a channel, then reconnect.');
    if ([500, 502, 503, 504].includes(res.status)) return transient('YouTube had a temporary problem. We will continue the upload shortly.');
    return httpFailure(NAME, res);
};

/** Next byte to send from a 308 answer's Range header ("bytes=0-999"), 0 when nothing arrived. */
export const nextOffset = (range) => {
    const m = String(range ?? '').match(/bytes=\d+-(\d+)/);
    return m ? Number(m[1]) + 1 : 0;
};

const done = (res, state) => {
    const id = res.body?.id;
    if (!id) throw transient('YouTube finished the upload without a video id. We will check again shortly.');
    return { status: 'published', externalId: String(id), url: `https://www.youtube.com/watch?v=${id}`, state };
};

export const youtubePublisher = {
    platform: 'youtube',
    name: NAME,
    requiredScopes: () => ['https://www.googleapis.com/auth/youtube.upload'],

    async step({ post, target, access, media, fetchImpl, save }) {
        const state = { ...(target.state ?? {}) };
        const size = media.sizeBytes;
        const type = media.contentType || 'video/mp4';
        const auth = { Authorization: `Bearer ${access}` };
        let offset = 0;
        if (state.uploadUri) {
            // Resume: ask YouTube how much of the file it already has.
            const res = await call(state.uploadUri, { method: 'PUT', headers: { ...auth, 'Content-Length': '0', 'Content-Range': `bytes */${size}` }, fetchImpl, name: NAME });
            if (res.status === 200 || res.status === 201) return done(res, state);
            if (res.status === 404 || res.status === 410) throw transient('The YouTube upload session expired. We will start the upload again shortly.', { resetState: true });
            if (res.status !== 308) throw failure(res);
            offset = nextOffset(res.header('range'));
        } else {
            const res = await call(`${UPLOAD}?uploadType=resumable&part=snippet,status`, {
                method: 'POST', fetchImpl, name: NAME, json: buildYouTubeMetadata({ caption: post.caption, mode: post.mode }),
                headers: { ...auth, 'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': type },
            });
            const location = res.header('location');
            if (!res.ok || !location) throw failure(res);
            state.uploadUri = location;
            await save(state);
        }
        while (offset < size) {
            const end = Math.min(offset + YOUTUBE_CHUNK, size) - 1;
            const chunk = await media.readRange(offset, end);
            const res = await call(state.uploadUri, {
                method: 'PUT', fetchImpl, name: NAME, body: chunk, timeoutMs: 5 * 60_000,
                headers: { ...auth, 'Content-Type': type, 'Content-Length': String(end - offset + 1), 'Content-Range': `bytes ${offset}-${end}/${size}` },
            });
            if (res.status === 200 || res.status === 201) return done(res, state);
            if (res.status === 404 || res.status === 410) throw transient('The YouTube upload session expired. We will start the upload again shortly.', { resetState: true });
            if (res.status !== 308) throw failure(res);
            const next = nextOffset(res.header('range'));
            if (next <= offset) throw transient('The YouTube upload stalled. We will continue it shortly.');
            offset = next;
        }
        throw transient('YouTube has not confirmed the upload yet. We will check again shortly.');
    },
};
