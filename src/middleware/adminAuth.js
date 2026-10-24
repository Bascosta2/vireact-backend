import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';

export const ADMIN_RATE_LIMIT = Object.freeze({ windowMs: 60 * 1000, max: 30 });

/** Per-IP limit for /api/v1/admin/* (default key generator is IPv6-safe). Applied before key checks. */
export const adminRateLimit = rateLimit({
    ...ADMIN_RATE_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many admin requests, please try again later' },
});

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
