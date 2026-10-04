import crypto from 'node:crypto';

/**
 * Refresh tokens are stored hashed, never as the raw JWT.
 *   h1:<hex>  HMAC-SHA256 keyed with REFRESH_TOKEN_PEPPER
 *   h0:<hex>  SHA-256, only when no pepper is configured (still useless if the DB leaks
 *             without the JWT secret, and upgrades to h1 on the next rotation)
 *   anything else is a legacy plaintext token: accepted once, replaced on rotation,
 *   or converted by scripts/hash-legacy-refresh-tokens.js.
 */

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const hmac = (pepper, value) => crypto.createHmac('sha256', pepper).update(value).digest('hex');

export const isHashedRefreshToken = (stored) => typeof stored === 'string' && /^h[01]:[0-9a-f]{64}$/.test(stored);

export function hashRefreshToken(token, pepper = process.env.REFRESH_TOKEN_PEPPER) {
    if (!token) throw new Error('hashRefreshToken requires a token');
    return pepper ? `h1:${hmac(pepper, token)}` : `h0:${sha256(token)}`;
}

const safeEqual = (a, b) => {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};

export function refreshTokenMatches(stored, token, pepper = process.env.REFRESH_TOKEN_PEPPER) {
    if (!stored || !token) return false;
    if (stored.startsWith('h1:')) {
        if (!pepper) return false;
        return safeEqual(stored, `h1:${hmac(pepper, token)}`);
    }
    if (stored.startsWith('h0:')) {
        return safeEqual(stored, `h0:${sha256(token)}`);
    }
    return safeEqual(stored, token);
}
