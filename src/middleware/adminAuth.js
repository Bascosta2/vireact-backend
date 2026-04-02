/**
 * Admin API key authentication for /admin/* routes.
 * Rejects with 401 if x-admin-key is missing or does not match ADMIN_API_KEY.
 */
export function adminAuth(req, res, next) {
    const rawKey = req.headers['x-admin-key'];
    const key = typeof rawKey === 'string' ? rawKey.trim() : rawKey;
    const expected = (process.env.ADMIN_API_KEY || '').trim();
    if (!expected || !key || key !== expected) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}
