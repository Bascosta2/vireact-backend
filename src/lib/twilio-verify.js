/**
 * Twilio Verify (SMS sign-in codes) over its REST API: no SDK.
 * Twilio generates, texts and checks the code; codes are single-use and expire after 10 minutes.
 *
 * Env: TWILIO_ACCOUNT_SID (AC...), TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID (VA...).
 * Tests swap the transport with setVerifyClientForTests().
 */
const BASE = 'https://verify.twilio.com/v2/Services';
const TIMEOUT_MS = 10_000;

const env = () => ({
    sid: String(process.env.TWILIO_ACCOUNT_SID ?? '').trim(),
    token: String(process.env.TWILIO_AUTH_TOKEN ?? '').trim(),
    service: String(process.env.TWILIO_VERIFY_SERVICE_SID ?? '').trim(),
});

export const isVerifyConfigured = () => {
    const { sid, token, service } = env();
    return /^AC[0-9a-f]{32}$/i.test(sid) && token.length >= 16 && /^VA[0-9a-f]{32}$/i.test(service);
};

const post = async (path, form) => {
    const { sid, token, service } = env();
    const res = await fetch(`${BASE}/${service}/${path}`, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
};

const realClient = {
    /** Text a new code to `to` (E.164). Returns true when Twilio accepted it. */
    async send(to) {
        const { status, body } = await post('Verifications', { To: to, Channel: 'sms' });
        if (status >= 400) console.warn(`[Twilio Verify] send failed: ${status} ${body?.code ?? ''} ${body?.message ?? ''}`);
        return status < 300 && body?.status === 'pending';
    },
    /** True only when Twilio approves this code for `to`. */
    async check(to, code) {
        const { status, body } = await post('VerificationCheck', { To: to, Code: code });
        // 404: no pending code (expired, already used, or never sent).
        return status < 300 && body?.status === 'approved' && body?.valid !== false;
    },
};

let client = realClient;
export const setVerifyClientForTests = (fake) => {
    client = fake ?? realClient;
};

export const sendVerificationCode = (to) => client.send(to);
export const checkVerificationCode = (to, code) => client.check(to, code);
