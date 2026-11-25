import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { hasAccountsAccess, hasPublishingAccess, isMetaDataDeletionEnabled } from '../config/flags.js';
import { captureServerEvent } from '../lib/analytics.js';
import {
    disconnect, finishConnect, linkPost, listAccounts, listPosts, returnUrl, startConnect, syncNow,
} from '../service/accounts/accounts.service.js';
import {
    deauthorizeMetaUser, getMetaDeletionStatus, parseSignedRequest, requestMetaDataDeletion,
} from '../service/accounts/meta-data-deletion.js';

const ok = (res, message, data, status = 200) => res.status(status).json(ApiResponse.success(status, message, data));
const track = (req, event, properties) => {
    try { captureServerEvent(String(req.user._id), event, properties); } catch { /* analytics never fails a request */ }
};

/** Hidden tab for accounts outside the beta: same answer as a route that does not exist. */
export const requireAccountsAccess = (req, res, next) => {
    if (!hasAccountsAccess(req.user)) return next(new ApiError(404, 'Not found'));
    return next();
};

/** Open to every signed-in user: `available` is how the web app knows whether to show the tab. */
export const getAccounts = async (req, res) => {
    if (!hasAccountsAccess(req.user)) return ok(res, 'OK', { available: false, platforms: [], accounts: [] });
    return ok(res, 'OK', { available: true, ...(await listAccounts(req.user._id)) });
};

export const connectAccount = async (req, res) => {
    // Opt-in posting permission (scheduled posting): ?scopes=publish or { scopes: 'publish' }. Default read-only.
    const scopes = (req.query?.scopes ?? req.body?.scopes) === 'publish' ? 'publish' : 'read';
    if (scopes === 'publish' && !hasPublishingAccess(req.user)) throw new ApiError(404, 'Not found');
    const data = await startConnect(req.user._id, String(req.params.platform), { scopes });
    track(req, 'account_connect_started', { platform: req.params.platform });
    return ok(res, 'OK', data);
};

/** The platform redirects the browser here (no Vireact session on this request): verified by the state. */
export const connectCallback = async (req, res) => {
    const q = req.query ?? {};
    try {
        const url = await finishConnect(String(req.params.platform), {
            code: q.code, state: q.state, error: q.error, errorDescription: q.error_description,
        });
        return res.redirect(302, url);
    } catch {
        return res.redirect(302, returnUrl({ error: 'failed' }));
    }
};

export const syncAccountNow = async (req, res) => ok(res, 'Refreshed', await syncNow(req.user._id, req.params.id));

/** DELETE /accounts/:id. ?deleteData=true also removes the readings this account copied onto the user's uploads. */
export const disconnectAccount = async (req, res) => {
    const deleteData = String(req.query?.deleteData ?? '').toLowerCase() === 'true';
    const data = await disconnect(req.user._id, req.params.id, { deleteData });
    track(req, 'account_disconnected', { deleteData });
    return ok(res, 'Disconnected', data);
};

export const getPosts = async (req, res) => ok(res, 'OK', await listPosts(req.user._id, { accountId: req.query.accountId || null, limit: req.query.limit }));

export const setPostLink = async (req, res) => {
    const videoId = req.body?.videoId ?? null;
    return ok(res, 'Saved', await linkPost(req.user._id, req.params.postId, videoId === '' ? null : videoId));
};

// ---- Meta callbacks (public: Meta's servers call them; the signed_request is the proof). Never log the body.

/** Verifies the signed_request, or answers 404 (flag off), 503 (no Meta secret set) or 400 (anything else). */
const verifyMetaCallback = (req) => {
    if (!isMetaDataDeletionEnabled()) throw new ApiError(404, 'Not found');
    const verified = parseSignedRequest(req.body?.signed_request);
    if (verified.reason === 'not_configured') throw new ApiError(503, 'Meta callbacks are not configured.');
    if (!verified.ok) throw new ApiError(400, 'Invalid signed_request.');
    return verified;
};

/** POST /meta/data-deletion: Meta's data deletion request callback. Answers Meta's { url, confirmation_code }. */
export const metaDataDeletion = async (req, res) => {
    const verified = verifyMetaCallback(req);
    try {
        return res.status(200).json(await requestMetaDataDeletion(verified));
    } catch (error) {
        // Handled here (not the error handler) so no error report carries the request body.
        console.warn(`[meta] ${verified.platform} data deletion request could not be recorded: ${error.message}`);
        return res.status(500).json(ApiResponse.error(500, 'Could not record the request. Try again later.'));
    }
};

/**
 * GET /meta/data-deletion/:code: the public status page's lookup. Only { status, completedAt? }. Not behind
 * META_DATA_DELETION_ENABLED, so codes already given out stay checkable when the flag is off.
 */
export const metaDataDeletionStatus = async (req, res) => {
    const status = await getMetaDeletionStatus(req.params.code);
    res.set('Cache-Control', 'no-store');
    if (!status) throw new ApiError(404, 'No deletion request with that confirmation code.');
    return res.status(200).json(status);
};

/** POST /meta/deauthorize: Meta's deauthorize callback. Marks the accounts for reconnecting; deletes nothing. */
export const metaDeauthorize = async (req, res) => {
    const verified = verifyMetaCallback(req);
    try {
        await deauthorizeMetaUser(verified);
        return ok(res, 'OK', null);
    } catch (error) {
        console.warn(`[meta] ${verified.platform} deauthorize could not be applied: ${error.message}`);
        return res.status(500).json(ApiResponse.error(500, 'Could not apply the request. Try again later.'));
    }
};
