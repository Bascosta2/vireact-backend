import { FRONTEND_URL } from '../config/index.js';
import { getAllowedCorsOrigins } from '../config/cors-allowed-origins.js';

/**
 * Returns a redirect URL that is same-origin as FRONTEND_URL, or null if unsafe.
 * Blocks open redirects, javascript:, data:, and cross-origin absolute URLs.
 * @param {string | undefined | null} raw
 * @returns {string | null}
 */
export function getSafeOAuthRedirectUrl(raw) {
    if (!raw || typeof raw !== 'string') {
        return null;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
        return null;
    }
    if (/^(javascript|data|vbscript):/i.test(trimmed)) {
        return null;
    }

    let baseUrl;
    try {
        baseUrl = new URL(FRONTEND_URL);
    } catch {
        return null;
    }

    // Relative path only (same site)
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
        try {
            const resolved = new URL(trimmed, baseUrl.origin);
            if (resolved.origin !== baseUrl.origin) {
                return null;
            }
            return `${resolved.origin}${resolved.pathname}${resolved.search}${resolved.hash}`;
        } catch {
            return null;
        }
    }

    let candidate;
    try {
        candidate = new URL(trimmed);
    } catch {
        return null;
    }

    if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') {
        return null;
    }
    // Same site: FRONTEND_URL's origin, or another production origin of the site (vireact.io / www).
    const allowedOrigins = new Set([baseUrl.origin, ...getAllowedCorsOrigins()]);
    if (!allowedOrigins.has(candidate.origin)) {
        return null;
    }
    return `${candidate.origin}${candidate.pathname}${candidate.search}${candidate.hash}`;
}
