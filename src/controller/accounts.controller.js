import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { hasAccountsAccess } from '../config/flags.js';
import { captureServerEvent } from '../lib/analytics.js';
import {
    disconnect, finishConnect, linkPost, listAccounts, listPosts, returnUrl, startConnect, syncNow,
} from '../service/accounts/accounts.service.js';

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
    const data = await startConnect(req.user._id, String(req.params.platform));
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

export const disconnectAccount = async (req, res) => {
    const data = await disconnect(req.user._id, req.params.id);
    track(req, 'account_disconnected', {});
    return ok(res, 'Disconnected', data);
};

export const getPosts = async (req, res) => ok(res, 'OK', await listPosts(req.user._id, { accountId: req.query.accountId || null, limit: req.query.limit }));

export const setPostLink = async (req, res) => {
    const videoId = req.body?.videoId ?? null;
    return ok(res, 'Saved', await linkPost(req.user._id, req.params.postId, videoId === '' ? null : videoId));
};
