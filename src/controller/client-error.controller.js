import jwt from 'jsonwebtoken';
import { ACCESS_TOKEN_SECRET } from '../config/index.js';
import { captureError } from '../service/ops-monitoring.service.js';

const str = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

/** Signed-in user id from the access token, without a database lookup. Null when absent or invalid. */
const userIdFromRequest = (req) => {
    try {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : req.cookies?.accessToken;
        if (!token) return null;
        const decoded = jwt.verify(token, ACCESS_TOKEN_SECRET);
        return decoded?._id ? String(decoded._id) : null;
    } catch {
        return null;
    }
};

/**
 * POST /api/v1/client-errors  { message, stack?, kind?, url?, route?, release? }
 * Errors from users' browsers (crashes, unhandled errors, failed network calls). Always answers 204 so a
 * reporting problem can never cascade in the browser; invalid reports are dropped.
 */
export const postClientError = (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const message = str(body.message, 500).trim();
    if (message) {
        const kind = str(body.kind, 40) || 'error';
        const error = new Error(`[${kind}] ${message}`);
        error.stack = str(body.stack, 4000) || error.stack;
        captureError(error, {
            source: 'client',
            route: str(body.route, 200) || str(body.url, 300),
            userId: userIdFromRequest(req),
        });
    }
    res.status(204).end();
};
