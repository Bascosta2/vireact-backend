import crypto from 'node:crypto';

/** Constant-time check of a presented admin key against ADMIN_API_KEY. False when either is empty. */
export function isValidAdminKey(rawKey, expected = (process.env.ADMIN_API_KEY || '').trim()) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!expected || !key) return false;
    const a = crypto.createHash('sha256').update(key).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(a, b);
}

/**
 * Admin API key authentication for /admin/* routes.
 * Rejects with 401 if x-admin-key is missing or does not match ADMIN_API_KEY.
 */
export function adminAuth(req, res, next) {
    if (!isValidAdminKey(req.headers['x-admin-key'])) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}
