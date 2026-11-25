/**
 * Publishers: one per platform, all with the same shape so the job (publish-job.js) can drive them.
 *
 *   publisher.step({ post, target, account, access, media, env, fetchImpl, save, now })
 *     -> { status: 'published', externalId, url }      done
 *     -> { status: 'waiting', state, retryInSec }      the platform is still processing: check again later
 *     throws PublishError                              retry: transient; reauth: reconnect; else permanent
 *
 * `target.state` is the platform progress from earlier passes (upload session, container id...). A publisher
 * calls `save(state)` before any step that would be unsafe to repeat, so a crash resumes rather than reposts.
 * `media` = { sizeBytes, contentType, signedUrl(ttlSec), readRange(start, end), openStream(offset) }.
 * Every error message is plain English: it is shown to the user as the target's `error`.
 */

export class PublishError extends Error {
    /** @param {string} message plain English, shown to the user */
    constructor(message, { retry = false, reauth = false, retryAfterSec = null, resetState = false } = {}) {
        super(message);
        this.name = 'PublishError';
        this.retry = retry;
        this.reauth = reauth;
        this.retryAfterSec = retryAfterSec;
        this.resetState = resetState;
    }
}

export const transient = (message, opts = {}) => new PublishError(message, { ...opts, retry: true });
export const permanent = (message, opts = {}) => new PublishError(message, { ...opts, retry: false });
export const reconnect = (name) => new PublishError(`${name} asked you to sign in again. Reconnect your ${name} account in the Accounts tab, then schedule this post again.`, { reauth: true });

const TIMEOUT_MS = 60_000;

/**
 * One HTTP request. Never throws on an HTTP status (publishers read it); a network failure or timeout
 * becomes a transient PublishError. `form` is urlencoded, `json` is JSON, `body` is sent as is.
 */
export const call = async (url, { method = 'GET', headers = {}, form, json, body, fetchImpl = fetch, timeoutMs = TIMEOUT_MS, name = 'The platform' } = {}) => {
    const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) };
    if (form) {
        init.body = new URLSearchParams(Object.entries(form).filter(([, v]) => v != null)).toString();
        init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (json) {
        init.body = JSON.stringify(json);
        init.headers['Content-Type'] = 'application/json; charset=UTF-8';
    } else if (body != null) {
        init.body = body;
        if (typeof body?.getReader === 'function' || typeof body?.pipe === 'function') init.duplex = 'half';
    }
    let res;
    try {
        res = await fetchImpl(url, init);
    } catch (e) {
        throw transient(`Could not reach ${name}. We will try again shortly.`, { cause: e });
    }
    const text = await res.text().catch(() => '');
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    const header = (k) => (typeof res.headers?.get === 'function' ? res.headers.get(k) : res.headers?.[k.toLowerCase()] ?? null);
    return { status: res.status, ok: res.status >= 200 && res.status < 300, body: parsed, header };
};

/** Short platform message for logs and for the user when nothing better is known. */
export const platformMessage = (body) => {
    if (!body) return '';
    if (typeof body === 'string') return body.slice(0, 200);
    const e = body.error;
    if (typeof e === 'string') return e;
    return String(e?.error_user_msg || e?.message || body.message || '').slice(0, 200);
};

/**
 * Meta Graph API errors (Instagram and Facebook) in plain English. `extra(code, subcode)` may return a
 * platform-specific PublishError first.
 */
export const graphFailure = (name, res, extra = () => null) => {
    const e = res.body?.error ?? {};
    const code = Number(e.code);
    const sub = Number(e.error_subcode);
    const special = extra(code, sub, e);
    if (special) return special;
    if (res.status === 401 || code === 190 || code === 102) return reconnect(name);
    if ([10, 200, 294].includes(code) || (code >= 200 && code < 300)) {
        return permanent(`${name} did not give Vireact permission to post. Reconnect ${name} with posting allowed in the Accounts tab.`);
    }
    if ([4, 17, 32, 341, 613].includes(code) || res.status === 429) return transient(`${name} is limiting how fast we can post right now. We will try again shortly.`, { retryAfterSec: 15 * 60 });
    if (e.is_transient || code === 1 || code === 2 || res.status >= 500) return transient(`${name} had a temporary problem. We will try again shortly.`);
    const msg = platformMessage(res.body);
    return permanent(`${name} rejected this post${msg ? `: ${msg}` : '.'}`);
};

/** Common HTTP-status fallback for non-Meta platforms. */
export const httpFailure = (name, res) => {
    if (res.status === 401) return reconnect(name);
    if (res.status === 429) return transient(`${name} is limiting how fast we can post right now. We will try again shortly.`, { retryAfterSec: 10 * 60 });
    if (res.status >= 500 || res.status === 408) return transient(`${name} had a temporary problem. We will try again shortly.`);
    const msg = platformMessage(res.body);
    return permanent(`${name} rejected this post${msg ? `: ${msg}` : '.'}`);
};

/** Dry run (PUBLISHING_DRY_RUN=true): every target "succeeds" without calling any platform. */
export const dryRunPublisher = (platform) => ({
    platform,
    name: platform,
    requiredScopes: () => [],
    async step({ post, target }) {
        return { status: 'published', externalId: `dry-run-${platform}-${String(post._id ?? post.id ?? 'post')}`, url: null, state: { ...target.state, dryRun: true } };
    },
});
