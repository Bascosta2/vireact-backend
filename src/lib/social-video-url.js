/**
 * SSRF-safe allowlist for social URLs that are fetched server-side (yt-dlp).
 * Only http(s) and these exact hostnames are accepted for the download path.
 */
const ALLOWED_HOSTNAMES = new Set([
    'tiktok.com',
    'www.tiktok.com',
    'vm.tiktok.com',
    'vt.tiktok.com',
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be',
    'instagram.com',
    'www.instagram.com',
]);

function isPrivateOrReservedHostname(hostname) {
    const h = hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.localhost')) return true;
    if (h === '0.0.0.0') return true;
    const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    const m = h.match(ipv4);
    if (m) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        if (a === 10) return true;
        if (a === 127) return true;
        if (a === 0) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 100 && b >= 64 && b <= 127) return true;
    }
    if (h.includes(':')) {
        if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
    }
    return false;
}

/**
 * @param {string} urlString
 * @returns {boolean}
 */
export function isAllowedSocialVideoUrl(urlString) {
    if (!urlString || typeof urlString !== 'string') return false;
    let u;
    try {
        u = new URL(urlString.trim());
    } catch {
        return false;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (isPrivateOrReservedHostname(host)) return false;
    return ALLOWED_HOSTNAMES.has(host);
}
