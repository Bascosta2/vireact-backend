import { ApiError } from "../utils/ApiError.js";
import {
    MAILCHIMP_API_KEY,
    MAILCHIMP_AUDIENCE_ID,
    MAILCHIMP_SERVER_PREFIX,
    MAILCHIMP_ENABLED,
    MAILCHIMP_DEV_ENABLED,
    NODE_ENV,
} from "../config/index.js";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Subscribe an email to the Mailchimp audience used by the /viral-hooks PDF
 * lead-gen funnel.
 *
 * Behaviour matrix:
 *   MAILCHIMP_ENABLED=false (default) → log email to console, return ok=true.
 *     This lets the page be tested end-to-end before Mailchimp creds are wired.
 *   MAILCHIMP_ENABLED=true → POST to Mailchimp lists/{audienceId}/members with
 *     the "pdf-warm" tag. Mailchimp's automation handles the welcome email +
 *     PDF download link, so we never send the PDF directly from this server.
 *   NODE_ENV !== 'production' → log-only like the default, even when
 *     MAILCHIMP_ENABLED=true, unless MAILCHIMP_DEV_ENABLED=true. Keeps local
 *     runs from adding test addresses to the real audience.
 *
 * Already-subscribed (HTTP 400 with title="Member Exists") is treated as
 * success: a returning DM lead should still be redirected to /thank-you and
 * shown the app pitch.
 *
 * @param {{ email: string, source?: string }} input
 * @returns {Promise<{ ok: true, alreadySubscribed?: boolean, simulated?: boolean }>}
 */
export const subscribeEmailService = async ({ email, source }) => {
    if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email.trim())) {
        throw new ApiError(400, "A valid email address is required");
    }

    const normalisedEmail = email.trim().toLowerCase();
    const tag = 'pdf-warm';

    const devSkip = NODE_ENV !== 'production' && !MAILCHIMP_DEV_ENABLED;
    if (!MAILCHIMP_ENABLED || devSkip) {
        // Dev / pre-launch mode: just observe.
        const reason = !MAILCHIMP_ENABLED ? 'MAILCHIMP_ENABLED=false' : 'non-production and MAILCHIMP_DEV_ENABLED!=true';
        console.log(
            `[subscribe] ${reason} — would subscribe email="${normalisedEmail}" tag="${tag}" source="${source || 'viral-hooks'}"`
        );
        return { ok: true, simulated: true };
    }

    if (!MAILCHIMP_API_KEY || !MAILCHIMP_AUDIENCE_ID || !MAILCHIMP_SERVER_PREFIX) {
        // Misconfigured production — fail loudly so the operator notices.
        throw new ApiError(
            500,
            "Mailchimp is enabled but MAILCHIMP_API_KEY / MAILCHIMP_AUDIENCE_ID / MAILCHIMP_SERVER_PREFIX are not all set"
        );
    }

    const url = `https://${MAILCHIMP_SERVER_PREFIX}.api.mailchimp.com/3.0/lists/${MAILCHIMP_AUDIENCE_ID}/members`;
    const authHeader = 'Basic ' + Buffer.from(`anystring:${MAILCHIMP_API_KEY}`).toString('base64');

    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: authHeader,
            },
            body: JSON.stringify({
                email_address: normalisedEmail,
                status: 'subscribed',
                tags: [tag],
            }),
        });
    } catch (err) {
        // Network-level failure (DNS, offline, TLS, etc.)
        throw new ApiError(502, `Mailchimp request failed: ${err?.message || 'network error'}`);
    }

    if (response.ok) {
        return { ok: true };
    }

    // Parse Mailchimp's error envelope. Already-subscribed comes back as 400
    // with title "Member Exists" — we treat that as success.
    let body = null;
    try {
        body = await response.json();
    } catch {
        // ignore parse error
    }

    if (response.status === 400 && body && body.title === 'Member Exists') {
        return { ok: true, alreadySubscribed: true };
    }

    const detail = (body && (body.detail || body.title)) || `HTTP ${response.status}`;
    throw new ApiError(502, `Mailchimp rejected the subscription: ${detail}`);
};
