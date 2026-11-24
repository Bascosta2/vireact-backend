import crypto from 'node:crypto';
import { ConnectedAccount, MetaDeletionRequest, META_DELETION_STATUS, ACCOUNT_STATUS } from '../../model/connected-account.model.js';
import { deleteAccountData } from './accounts.service.js';
import { captureError } from '../ops-monitoring.service.js';

/**
 * Meta's user-data callbacks (required for Meta App Review), for the Facebook and Instagram connections:
 *
 * - Data deletion (POST /api/v1/meta/data-deletion): a person removed Vireact in their Facebook / Instagram
 *   settings and asked for their data to be deleted. We delete what Vireact received from Meta for that
 *   person and answer { url, confirmation_code }; the url is the public /data-deletion page, which reads
 *   GET /api/v1/meta/data-deletion/:code.
 * - Deauthorize (POST /api/v1/meta/deauthorize): a person removed Vireact without asking for deletion. The
 *   account is marked needs_reauth and its (now dead) tokens are wiped; posts and readings stay.
 *
 * Both carry a signed_request: "<base64url HMAC-SHA256 signature>.<base64url JSON payload>", signed with the
 * app secret. Facebook Login callbacks are signed with FACEBOOK_APP_SECRET, Instagram Login callbacks with the
 * separate INSTAGRAM_APP_SECRET; we try each configured secret and reject when none matches. The secret that
 * matched decides the platform, and the id is only looked up on that platform's accounts (Instagram:
 * externalId or scopedUserIds; Facebook: externalId, its app-scoped user id): ids of one never match the other.
 * issued_at / expires are not checked (Meta's sample does not either): a replayed request only repeats an
 * idempotent deletion or deauthorization for the same person.
 *
 * The META_DATA_DELETION_ENABLED flag gates only the two POST callbacks. The status lookup and the daily
 * finisher of pending deletions always run, so requests already accepted finish and stay checkable when the
 * flag is turned off again.
 *
 * What "data received from Meta" covers (deleteAccountData in accounts.service.js), for every connected
 * account on that platform with that Meta user id (on any Vireact user):
 *   deleted: the connected account (encrypted tokens, handle, name, avatar, followers), its synced posts
 *     (captions, thumbnails, links, daily readings), the readings it copied onto the user's uploads (and their
 *     learning copies), and the post link / date / platform / followers it filled in on an upload (recorded in
 *     video.connectedCopies). Residue from copies made before that record existed: creatorPlatform, and a link
 *     or date whose post has left the synced list, stay on the upload (see removeConnectedReadings).
 *   kept: the Vireact account, the user's own uploaded videos and their analyses, chats, and anything the
 *     user typed themselves (manual result entries, links or dates they entered). Model weights trained on
 *     many users' results hold no per-person data and are retrained daily without the removed readings.
 *
 * Never log signed_request, tokens or the Meta user id.
 */

export const META_SECRETS = Object.freeze({ facebook: 'FACEBOOK_APP_SECRET', instagram: 'INSTAGRAM_APP_SECRET' });
/** Deletions that failed this many times are reported (captureError) once. */
export const ALERT_AFTER_ATTEMPTS = 3;
const STALLED_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SIGNED_REQUEST = 8192;
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const META_USER_ID = /^\d{1,32}$/;
export const CONFIRMATION_CODE = /^[a-f0-9]{32}$/;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const decodeSegment = (segment) => (B64URL.test(segment) ? Buffer.from(segment.replace(/=+$/, ''), 'base64url') : null);

/** Which Meta secrets are set, as [platform, secret] pairs. */
export const configuredMetaSecrets = (env = process.env) => Object.entries(META_SECRETS)
    .map(([platform, name]) => [platform, String(env[name] ?? '').trim()])
    .filter(([, secret]) => secret);

/**
 * Verifies and reads a Meta signed_request. Returns { ok: true, platform, userId } (platform: whose secret
 * signed it) or { ok: false, reason } with reason one of not_configured, malformed, bad_signature,
 * bad_algorithm, no_user. The signature is checked (timing-safe) over the encoded payload before the payload
 * is read, and the payload must say algorithm HMAC-SHA256.
 */
export const parseSignedRequest = (signedRequest, env = process.env) => {
    const secrets = configuredMetaSecrets(env);
    if (!secrets.length) return { ok: false, reason: 'not_configured' };
    if (typeof signedRequest !== 'string' || !signedRequest || signedRequest.length > MAX_SIGNED_REQUEST) return { ok: false, reason: 'malformed' };
    const parts = signedRequest.split('.');
    if (parts.length !== 2) return { ok: false, reason: 'malformed' };
    const [encodedSig, encodedPayload] = parts;
    const signature = decodeSegment(encodedSig);
    const payloadBytes = decodeSegment(encodedPayload);
    if (!signature || !payloadBytes || signature.length !== 32) return { ok: false, reason: 'malformed' };
    let platform = null;
    for (const [name, secret] of secrets) {
        const expected = crypto.createHmac('sha256', secret).update(encodedPayload).digest();
        if (crypto.timingSafeEqual(expected, signature) && !platform) platform = name;
    }
    if (!platform) return { ok: false, reason: 'bad_signature' };
    let payload;
    try {
        payload = JSON.parse(payloadBytes.toString('utf8'));
    } catch {
        return { ok: false, reason: 'malformed' };
    }
    if (!payload || typeof payload !== 'object') return { ok: false, reason: 'malformed' };
    if (payload.algorithm !== 'HMAC-SHA256') return { ok: false, reason: 'bad_algorithm' };
    const userId = typeof payload.user_id === 'number' || typeof payload.user_id === 'string' ? String(payload.user_id) : '';
    if (!META_USER_ID.test(userId)) return { ok: false, reason: 'no_user' };
    return { ok: true, platform, userId };
};

/** The status page link Meta shows the person. */
export const statusPageUrl = (code, env = process.env) => `${String(env.FRONTEND_URL ?? '').replace(/\/+$/, '')}/data-deletion?code=${encodeURIComponent(code)}`;

/** The JSON body Meta expects back from the data-deletion callback. */
export const deletionResponse = (code, env = process.env) => ({ url: statusPageUrl(code, env), confirmation_code: code });

/** What the public status page may see: the status and, once done, when. Nothing else. */
export const toPublicDeletionStatus = (request) => (request.status === META_DELETION_STATUS.COMPLETED
    ? { status: META_DELETION_STATUS.COMPLETED, completedAt: request.completedAt ?? null }
    : { status: META_DELETION_STATUS.PENDING });

/**
 * Which connected accounts a verified callback is about: only the signing app's platform. Instagram matches
 * the stored professional id or the app-scoped ids; Facebook's externalId is its app-scoped id.
 */
export const metaAccountFilter = (platform, metaUserId) => {
    if (platform === 'instagram') return { platform, $or: [{ externalId: metaUserId }, { scopedUserIds: metaUserId }] };
    if (platform === 'facebook') return { platform, externalId: metaUserId };
    throw new Error(`not a Meta platform: ${platform}`);
};

/** Deletes the data of every connected account (any Vireact user) on this platform with this Meta user id. */
export const deleteMetaUserData = async (platform, metaUserId) => {
    const counts = { accounts: 0, posts: 0, readings: 0 };
    for (const account of await ConnectedAccount.find(metaAccountFilter(platform, metaUserId))) {
        const c = await deleteAccountData(account);
        counts.accounts += 1;
        counts.posts += c.posts;
        counts.readings += c.readings;
    }
    return counts;
};

/** Runs the deletion for a recorded request; on success marks it completed and forgets the Meta user id. */
const runDeletion = async (request, { now = Date.now(), log = (l) => console.warn(`[meta] ${l}`), report = captureError } = {}) => {
    try {
        const counts = await deleteMetaUserData(request.platform, request.metaUserId);
        Object.assign(request, { status: META_DELETION_STATUS.COMPLETED, completedAt: new Date(now), metaUserId: null, counts, attempts: (request.attempts ?? 0) + 1 });
    } catch (error) {
        // Pending (again) with the id; finishPendingMetaDeletions retries it daily.
        log(`${request.platform} data deletion failed, will retry: ${error.message}`);
        Object.assign(request, { status: META_DELETION_STATUS.PENDING, attempts: (request.attempts ?? 0) + 1 });
        if (request.attempts === ALERT_AFTER_ATTEMPTS) {
            // No ids, no tokens, no message text (a database error can quote the query): the kind of error only.
            report(new Error(`Meta data deletion (${request.platform}) has failed ${request.attempts} times; last error: ${error?.name ?? 'Error'}`), { route: 'meta data deletion' });
        }
    }
    await request.save();
    return request;
};

/** One request per Meta user and app: finds it, or records a new one with a fresh random code. */
const findOrCreateRequest = async (platform, metaUserId, now) => {
    const subjectHash = sha256(`${platform}:${metaUserId}`);
    const existing = await MetaDeletionRequest.findOne({ subjectHash });
    if (existing) return existing;
    try {
        return await MetaDeletionRequest.create({
            confirmationCode: crypto.randomBytes(16).toString('hex'), subjectHash, platform, metaUserId, requestedAt: new Date(now),
        });
    } catch (error) {
        // Two callbacks for the same person at once: the other one recorded it.
        if (error?.code === 11000) return MetaDeletionRequest.findOne({ subjectHash });
        throw error;
    }
};

/**
 * Meta's data-deletion callback, after parseSignedRequest. Idempotent: a repeated callback for the same person
 * returns the same confirmation code and deletes again (anything synced since). Returns Meta's response body.
 */
export const requestMetaDataDeletion = async ({ platform, userId }, { env = process.env, now = Date.now(), log, report } = {}) => {
    const request = await findOrCreateRequest(platform, userId, now);
    request.metaUserId = userId;
    await runDeletion(request, { now, log, report });
    return deletionResponse(request.confirmationCode, env);
};

/** The status page's lookup. null when the code is not one of ours. */
export const getMetaDeletionStatus = async (code) => {
    const c = String(code ?? '').trim().toLowerCase();
    if (!CONFIRMATION_CODE.test(c)) return null;
    const request = await MetaDeletionRequest.findOne({ confirmationCode: c }).select('status completedAt').lean();
    return request ? toPublicDeletionStatus(request) : null;
};

/**
 * Daily (from syncAllAccounts, whatever the flag): finishes requests whose deletion failed, least-tried
 * first so a request that keeps failing cannot hold up newer ones. Never throws.
 */
export const finishPendingMetaDeletions = async ({ now = Date.now(), log = () => {}, report, limit = 100 } = {}) => {
    const out = { pending: 0, completed: 0 };
    try {
        const pending = await MetaDeletionRequest.find({ status: META_DELETION_STATUS.PENDING, metaUserId: { $ne: null } }).sort({ attempts: 1, updatedAt: 1 }).limit(limit);
        out.pending = pending.length;
        for (const request of pending) {
            await runDeletion(request, { now, log, report });
            if (request.status === META_DELETION_STATUS.COMPLETED) out.completed += 1;
        }
    } catch (error) {
        log(`meta deletions: ${error.message}`);
    }
    return out;
};

/** For the admin health report: accepted deletions still pending after 7 days. */
export const countStalledMetaDeletions = (now = Date.now()) => MetaDeletionRequest.countDocuments({
    status: META_DELETION_STATUS.PENDING, requestedAt: { $lt: new Date(now - STALLED_AFTER_MS) },
});

/**
 * Meta's deauthorize callback, after parseSignedRequest: the person removed Vireact on Facebook / Instagram.
 * Marks their accounts needs_reauth and wipes the tokens Meta just revoked. Posts and readings stay (the
 * person did not ask for deletion; the data-deletion callback or disconnect with deleteData removes them).
 */
export const deauthorizeMetaUser = async ({ platform, userId }) => {
    const { modifiedCount = 0 } = await ConnectedAccount.updateMany(
        { ...metaAccountFilter(platform, userId), deleting: { $ne: true } },
        {
            $set: {
                status: ACCOUNT_STATUS.NEEDS_REAUTH, lastSyncError: 'Access was removed on Meta. Connect again to keep syncing.',
                'tokens.access': null, 'tokens.refresh': null, 'tokens.accessExpiresAt': null, 'tokens.refreshExpiresAt': null,
            },
        },
    );
    return { accounts: modifiedCount };
};
