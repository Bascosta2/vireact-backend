/** Small fetch helpers shared by the platform adapters. Tests pass their own `fetch`. */

/** The platform refused the token: the user has to connect again. */
export class ReauthError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ReauthError';
        this.reauth = true;
    }
}

const TIMEOUT_MS = 20_000;

const describe = (body) => {
    if (!body || typeof body !== 'object') return String(body ?? '').slice(0, 200);
    const e = body.error;
    if (typeof e === 'string') return [e, body.error_description].filter(Boolean).join(': ');
    return e?.message || e?.code || body.message || body.error_description || JSON.stringify(body).slice(0, 200);
};

/**
 * JSON request. Throws ReauthError on 401 / invalid_grant / expired token answers, Error otherwise.
 * `form` sends application/x-www-form-urlencoded; `json` sends JSON.
 */
export const requestJson = async (url, { method = 'GET', headers = {}, form, json, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) => {
    const init = { method, headers: { Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) };
    if (form) {
        init.body = new URLSearchParams(Object.entries(form).filter(([, v]) => v != null)).toString();
        init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (json) {
        init.body = JSON.stringify(json);
        init.headers['Content-Type'] = 'application/json';
    }
    const res = await fetchImpl(url, init);
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    const tiktokError = body?.error?.code && body.error.code !== 'ok' ? body.error.code : null;
    const message = describe(body);
    const failed = res.status >= 400 || Boolean(tiktokError);
    if (res.status === 401 || (failed && /invalid_grant|access_token_invalid|invalid_token|expired|OAuthException/i.test(`${tiktokError ?? ''} ${message}`))) {
        throw new ReauthError(message || `HTTP ${res.status}`);
    }
    if (!res.ok || tiktokError) throw new Error(`${new URL(url).host} ${res.status}: ${message || 'request failed'}`);
    return body;
};

export const num = (x) => (x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x)) ? Number(x) : null);
export const inSeconds = (secs, now = Date.now()) => (num(secs) ? new Date(now + num(secs) * 1000) : null);
export const env = (name, source = process.env) => String(source[name] ?? '').trim();
