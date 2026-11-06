/**
 * Polite, locked-down page fetching for the knowledge research agent.
 *
 * - Only http(s) URLs on public hosts: hostnames resolving to private, loopback or link-local
 *   addresses are refused (URLs come from model output, so this blocks server-side request forgery).
 * - Redirects are followed by hand (max 3) and every hop is re-checked.
 * - robots.txt is honored for our user agent (falls back to the `*` group), cached per origin.
 * - Social platforms are never fetched: their terms forbid scraping, and the agent learns from
 *   public breakdowns of videos instead of the videos themselves.
 */
import dns from 'node:dns/promises';
import net from 'node:net';

export const RESEARCH_USER_AGENT = 'VireactResearchBot/1.0 (knowledge research; respects robots.txt)';
const UA_TOKEN = 'vireactresearchbot';
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;
export const MAX_PAGE_TEXT_CHARS = 24_000;

/** Platforms whose terms forbid scraping, plus hosts that are login walls or video-only. */
const BLOCKED_DOMAINS = [
    'tiktok.com', 'instagram.com', 'facebook.com', 'fb.com', 'youtube.com', 'youtu.be', 'x.com',
    'twitter.com', 'threads.net', 'reddit.com', 'linkedin.com', 'pinterest.com', 'snapchat.com',
    'quora.com', 'medium.com',
];

export const hostOf = (url) => {
    try {
        return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
        return '';
    }
};

export const isBlockedDomain = (url) => {
    const host = hostOf(url);
    return !host || BLOCKED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
};

/** True for loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export const isPrivateAddress = (address) => {
    const ip = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return (
            a === 0 || a === 10 || a === 127 || a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 198 && (b === 18 || b === 19))
        );
    }
    if (net.isIPv6(ip)) {
        if (ip === '::' || ip === '::1') return true;
        const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (mapped) return isPrivateAddress(mapped[1]);
        return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(ip);
    }
    return true; // not an IP at all: treat as unsafe
};

/** Throws unless `url` is http(s) on a host that resolves only to public addresses. */
export const assertPublicUrl = async (url, lookup = dns.lookup) => {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error('invalid URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('only http(s) URLs are allowed');
    if (parsed.username || parsed.password) throw new Error('credentials in URL');
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
        throw new Error('private host');
    }
    const addresses = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
        throw new Error('host resolves to a private address');
    }
    return parsed;
};

/**
 * Parse robots.txt into the rule list that applies to us: our own group if present, else `*`.
 * @returns {{allow: boolean, path: string}[]}
 */
export const parseRobots = (text, uaToken = UA_TOKEN) => {
    const groups = [];
    let current = null;
    let lastWasAgent = false;
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trim();
        const match = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
        if (!match) continue;
        const field = match[1].toLowerCase();
        const value = match[2].trim();
        if (field === 'user-agent') {
            if (!lastWasAgent || !current) {
                current = { agents: [], rules: [] };
                groups.push(current);
            }
            current.agents.push(value.toLowerCase());
            lastWasAgent = true;
            continue;
        }
        lastWasAgent = false;
        if (!current) continue;
        if (field === 'allow' || field === 'disallow') {
            // An empty Disallow means "allow everything" and adds no rule.
            if (value) current.rules.push({ allow: field === 'allow', path: value });
        }
    }
    const own = groups.filter((g) => g.agents.some((a) => a !== '*' && uaToken.includes(a)));
    const chosen = own.length ? own : groups.filter((g) => g.agents.includes('*'));
    return chosen.flatMap((g) => g.rules);
};

const ruleMatches = (rulePath, path) => {
    const anchored = rulePath.endsWith('$');
    const body = anchored ? rulePath.slice(0, -1) : rulePath;
    const pattern = body.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${pattern}${anchored ? '$' : ''}`).test(path);
};

/** Longest matching rule wins; Allow wins a tie. No matching rule means allowed. */
export const isPathAllowed = (rules, path) => {
    let best = null;
    for (const rule of rules) {
        if (!ruleMatches(rule.path, path)) continue;
        const len = rule.path.replace(/\*|\$$/g, '').length;
        if (!best || len > best.len || (len === best.len && rule.allow)) best = { len, allow: rule.allow };
    }
    return best ? best.allow : true;
};

/** Fetch with timeout, size cap and hop-by-hop redirect checks. */
const guardedFetch = async (url, { fetchImpl = fetch, lookup, accept = 'text/html,text/plain;q=0.9,*/*;q=0.1' } = {}) => {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        await assertPublicUrl(current, lookup);
        if (isBlockedDomain(current)) throw new Error('blocked domain');
        const response = await fetchImpl(current, {
            redirect: 'manual',
            headers: { 'user-agent': RESEARCH_USER_AGENT, accept },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
            current = new URL(response.headers.get('location'), current).toString();
            continue;
        }
        const declared = Number(response.headers.get('content-length') || 0);
        if (declared > MAX_BYTES) throw new Error('page too large');
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > MAX_BYTES) throw new Error('page too large');
        return { response, url: current, body: buffer.toString('utf8') };
    }
    throw new Error('too many redirects');
};

const robotsCache = new Map();

/** Whether robots.txt lets us fetch `url`. A missing robots.txt allows; a server error disallows. */
export const robotsAllows = async (url, deps = {}) => {
    const parsed = new URL(url);
    const origin = parsed.origin;
    if (!robotsCache.has(origin)) {
        const pending = (async () => {
            try {
                const { response, body } = await guardedFetch(`${origin}/robots.txt`, { ...deps, accept: 'text/plain' });
                if (response.status >= 500) return null; // unknown: be conservative
                if (response.status >= 400) return [];
                return parseRobots(body);
            } catch {
                return null;
            }
        })();
        robotsCache.set(origin, pending);
    }
    const rules = await robotsCache.get(origin);
    if (rules === null) return false;
    return isPathAllowed(rules, `${parsed.pathname}${parsed.search}`);
};

export const clearRobotsCache = () => robotsCache.clear();

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', mdash: ', ', ndash: '-', hellip: '...' };
const decodeEntities = (text) =>
    text
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
        .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);

/** Readable text and title from an HTML page (boilerplate regions dropped). */
export const htmlToText = (html) => {
    const source = String(html || '');
    const title = decodeEntities((source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim());
    // Prefer <article> or <main> when present: less navigation and fewer ads.
    const focus = source.match(/<article[\s\S]*?<\/article>/i)?.[0] || source.match(/<main[\s\S]*?<\/main>/i)?.[0] || source;
    const text = decodeEntities(
        focus
            .replace(/<!--[\s\S]*?-->/g, ' ')
            .replace(/<(script|style|noscript|svg|nav|footer|form|aside|iframe|template|button)\b[\s\S]*?<\/\1>/gi, ' ')
            .replace(/<\/?(p|div|section|h[1-6]|li|ul|ol|tr|table|blockquote|br|hr|article|main|header)\b[^>]*>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
    )
        .replace(/[ \t\f\v]+/g, ' ')
        .replace(/\n\s*/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return { title, text };
};

/**
 * Fetch a public page as plain text, honoring robots.txt.
 * @returns {Promise<{url: string, title: string, text: string}>}
 * @throws with a short reason when the page may not or cannot be read
 */
export const fetchPageText = async (url, deps = {}) => {
    if (isBlockedDomain(url)) throw new Error('blocked domain');
    await assertPublicUrl(url, deps.lookup);
    if (!(await robotsAllows(url, deps))) throw new Error('disallowed by robots.txt');
    const { response, url: finalUrl, body } = await guardedFetch(url, deps);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = String(response.headers.get('content-type') || '');
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) throw new Error(`unsupported content type ${type || 'unknown'}`);
    const { title, text } = /html/i.test(type) ? htmlToText(body) : { title: '', text: body.trim() };
    if (text.length < 600) throw new Error('too little readable text');
    return { url: finalUrl, title, text: text.slice(0, MAX_PAGE_TEXT_CHARS) };
};
