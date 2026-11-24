/**
 * READ-ONLY diagnostic: are signup verification emails reaching users?
 *
 * Paste as vireact-backend/scripts/check-signup-email.js, then from vireact-backend run:
 *     railway run node scripts/check-signup-email.js
 *
 * Prints aggregate counts and booleans only. Never prints an email address, name, user id,
 * token, API key or connection string. Makes no writes: it uses the raw MongoDB driver (no
 * Mongoose models, so no index or collection creation) and only GET calls to Resend.
 */
import mongoose from 'mongoose';
import { Resend } from 'resend';

// Snapshot the environment Railway injected BEFORE the app's env loader runs, so values filled in
// from a local .env/.env.local are not mistaken for production settings.
const injected = { ...process.env };
await import('../src/config/load-env.js');
const env = process.env;

const SECRET_VALUES = [env.DB_URL, env.MONGODB_URI, env.RESEND_API_KEY, env.DB_PASSWORD].filter(Boolean);
const redact = (text) => {
    let out = String(text ?? '');
    for (const secret of SECRET_VALUES) out = out.split(secret).join('[redacted]');
    return out
        .replace(/mongodb(\+srv)?:\/\/\S+/gi, 'mongodb://[redacted]')
        .replace(/re_[A-Za-z0-9_]{8,}/g, 're_[redacted]')
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]');
};
const yesNo = (v) => (v ? 'yes' : 'no');
const line = (label, value) => console.log(`  ${label.padEnd(52)} ${value}`);

const VERIFY_SUBJECT = 'Verify your Vireact email';
const DAY = 24 * 60 * 60 * 1000;

function fromDomain(from) {
    const match = String(from || '').match(/@([^>\s]+)>?\s*$/);
    return match ? match[1].toLowerCase() : null;
}

function reportEnv() {
    console.log('\n== Environment (booleans only) ==');
    const fromEmail = env.RESEND_FROM_EMAIL || 'support@vireact.io';
    let frontendHost = '(not set)';
    let frontendNote = '';
    if (env.FRONTEND_URL) {
        try {
            const url = new URL(env.FRONTEND_URL);
            frontendHost = `${url.protocol}//${url.host}`;
            if (url.pathname !== '/' || env.FRONTEND_URL.endsWith('/')) frontendNote = '  <-- has a path or trailing slash: verify links become //verify-email';
            if (env.FRONTEND_URL.includes(',')) frontendNote = '  <-- contains a comma: verify links are broken';
        } catch {
            frontendHost = '(set but not a valid URL: verify links are broken)';
        }
    }
    line('NODE_ENV (as injected by Railway)', injected.NODE_ENV || '(unset)');
    line('NODE_ENV (after app env loader)', env.NODE_ENV || '(unset)');
    line('FRONTEND_URL origin', frontendHost + frontendNote);
    line('RESEND_API_KEY set', yesNo(env.RESEND_API_KEY));
    line('RESEND_FROM_EMAIL set (else default support@vireact.io)', yesNo(env.RESEND_FROM_EMAIL));
    line('From-address domain', fromDomain(fromEmail) || '(unparseable)');
    line('From-address has a display name ("Vireact <...>")', yesNo(/<.+>/.test(fromEmail)));
    line('EMAIL_DEV_OVERRIDE_TO set (Railway)', yesNo(injected.EMAIL_DEV_OVERRIDE_TO));
    line('EMAIL_DEV_OVERRIDE_TO ACTIVE (would reroute ALL mail)',
        yesNo(env.NODE_ENV !== 'production' && env.EMAIL_DEV_OVERRIDE_TO)
        + (injected.NODE_ENV !== 'production' && injected.EMAIL_DEV_OVERRIDE_TO ? '  <-- set NODE_ENV=production in Railway Variables (or delete this var): otherwise live mail may be rerouted' : ''));
    line('DB_URL set', yesNo(env.DB_URL));
    line('DB_NAME set', yesNo(env.DB_NAME));
    return fromDomain(fromEmail);
}

async function reportUsers() {
    console.log('\n== Email/password signups (counts only) ==');
    const dbUrl = env.DB_URL;
    if (!dbUrl) {
        console.log('  DB_URL is not set; skipping database checks.');
        return;
    }
    // Same URL and dbName the app uses (src/db/index.js); reads only, no index/collection creation.
    await mongoose.connect(dbUrl, {
        dbName: env.DB_NAME,
        autoIndex: false,
        autoCreate: false,
        readPreference: 'secondaryPreferred',
        serverSelectionTimeoutMS: 15000,
    });
    const users = mongoose.connection.db.collection('users');
    const now = Date.now();
    const local = { provider: { $in: ['local', null] }, role: { $ne: 'admin' } };

    for (const days of [30, 90]) {
        const since = new Date(now - days * DAY);
        const [row] = await users.aggregate([
            { $match: { ...local, createdAt: { $gte: since } } },
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    verified: { $sum: { $cond: [{ $eq: ['$isEmailVerified', true] }, 1, 0] } },
                    linkedGoogleLater: { $sum: { $cond: [{ $ifNull: ['$googleId', false] }, 1, 0] } },
                    sentSet: { $sum: { $cond: [{ $ifNull: ['$verificationEmailSentAt', false] }, 1, 0] } },
                    unverified: { $sum: { $cond: [{ $ne: ['$isEmailVerified', true] }, 1, 0] } },
                    unverifiedNeverSent: {
                        $sum: { $cond: [{ $and: [{ $ne: ['$isEmailVerified', true] }, { $not: [{ $ifNull: ['$verificationEmailSentAt', false] }] }] }, 1, 0] },
                    },
                    unverifiedSentOver24h: {
                        $sum: {
                            $cond: [{
                                $and: [
                                    { $ne: ['$isEmailVerified', true] },
                                    { $lt: [{ $ifNull: ['$verificationEmailSentAt', new Date(now)] }, new Date(now - DAY)] },
                                ],
                            }, 1, 0],
                        },
                    },
                },
            },
        ]).toArray();
        const r = row || { total: 0, verified: 0, linkedGoogleLater: 0, sentSet: 0, unverified: 0, unverifiedNeverSent: 0, unverifiedSentOver24h: 0 };
        const pct = (n) => (r.total ? ` (${Math.round((100 * n) / r.total)}%)` : '');
        console.log(`\n  Last ${days} days`);
        line('local-provider signups', r.total);
        line('verified', r.verified + pct(r.verified));
        line('  of which later linked Google (verified by Google)', r.linkedGoogleLater);
        line('verificationEmailSentAt set (a send succeeded)', r.sentSet + pct(r.sentSet));
        line('verificationEmailSentAt unset', (r.total - r.sentSet) + pct(r.total - r.sentSet));
        line('unverified', r.unverified + pct(r.unverified));
        line('unverified AND no successful send ever', r.unverifiedNeverSent);
        line('unverified, last email sent >24h ago (stuck?)', r.unverifiedSentOver24h);
    }

    const google30 = await users.countDocuments({ provider: 'google', createdAt: { $gte: new Date(now - 30 * DAY) } });
    console.log('');
    line('Google signups, last 30 days (for comparison)', google30);

    // When did verificationEmailSentAt tracking start? Older users have it unset for that reason alone.
    const [first] = await users.find({ verificationEmailSentAt: { $type: 'date' } }, { projection: { _id: 0, verificationEmailSentAt: 1 } })
        .sort({ verificationEmailSentAt: 1 }).limit(1).toArray();
    line('earliest verificationEmailSentAt on any user', first ? first.verificationEmailSentAt.toISOString().slice(0, 10) : '(none: no send has ever succeeded or field is new)');

    console.log('\n  Weekly local signups vs verified (last 12 weeks)');
    const weeks = await users.aggregate([
        { $match: { ...local, createdAt: { $gte: new Date(now - 84 * DAY) } } },
        {
            $group: {
                _id: { $dateTrunc: { date: '$createdAt', unit: 'week', startOfWeek: 'monday' } },
                total: { $sum: 1 },
                verified: { $sum: { $cond: [{ $eq: ['$isEmailVerified', true] }, 1, 0] } },
                sent: { $sum: { $cond: [{ $ifNull: ['$verificationEmailSentAt', false] }, 1, 0] } },
            },
        },
        { $sort: { _id: 1 } },
    ]).toArray();
    for (const w of weeks) {
        line(`week of ${w._id.toISOString().slice(0, 10)}`, `signups ${w.total}, sent-ok ${w.sent}, verified ${w.verified}`);
    }
}

async function reportResend(domainOfFrom) {
    console.log('\n== Resend (read-only) ==');
    if (!env.RESEND_API_KEY) {
        console.log('  RESEND_API_KEY is not set; skipping.');
        return;
    }
    const resend = new Resend(env.RESEND_API_KEY);
    const { data, error } = await resend.domains.list();
    if (error) {
        console.log(`  domains.list failed: ${redact(error.name || '')} ${redact(error.message || '')}`);
        console.log('  (A "restricted_api_key" error means the key is sending-only: check domains in the Resend dashboard.)');
    } else {
        const domains = data?.data ?? [];
        if (domains.length === 0) console.log('  No domains on this Resend account: mail can only go to the account owner.');
        for (const d of domains) line(`domain ${d.name}`, `status=${d.status} region=${d.region ?? '?'}`);
        const match = domains.find((d) => d.name?.toLowerCase() === domainOfFrom);
        line(`from-address domain "${domainOfFrom}" verified`, match ? yesNo(match.status === 'verified') + ` (status=${match.status})` : 'NOT ON ACCOUNT');
        if (match) {
            const detail = await resend.domains.get(match.id);
            for (const rec of detail.data?.records ?? []) {
                line(`  DNS ${rec.record} ${rec.type}`, rec.status);
            }
        }
    }

    // Delivery outcome of recent verification emails (List Emails API; not in SDK v4, so plain GET).
    const tally = {};
    let after = null;
    let scanned = 0;
    const cutoff = Date.now() - 90 * DAY;
    try {
        for (let page = 0; page < 20; page += 1) {
            const qs = new URLSearchParams({ limit: '100', ...(after ? { after } : {}) });
            const res = await fetch(`https://api.resend.com/emails?${qs}`, { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` } });
            if (!res.ok) {
                console.log(`  emails list not available (HTTP ${res.status}); check Resend dashboard > Emails for bounced/suppressed.`);
                return;
            }
            const body = await res.json();
            const items = body?.data ?? [];
            let reachedCutoff = false;
            for (const e of items) {
                if (new Date(e.created_at).getTime() < cutoff) { reachedCutoff = true; break; }
                scanned += 1;
                if (e.subject !== VERIFY_SUBJECT) continue;
                const key = e.last_event || 'unknown';
                tally[key] = (tally[key] || 0) + 1;
            }
            if (reachedCutoff || !body?.has_more || items.length === 0) break;
            after = items[items.length - 1].id;
        }
        console.log(`  Verification emails in the last 90 days by last event (scanned ${scanned} emails):`);
        if (Object.keys(tally).length === 0) line('(none found)', '');
        for (const [event, count] of Object.entries(tally).sort((a, b) => b[1] - a[1])) line(event, count);
    } catch (err) {
        console.log(`  emails list failed: ${redact(err?.message)}`);
    }
}

let exitCode = 0;
try {
    const domainOfFrom = reportEnv();
    try {
        await reportUsers();
    } catch (err) {
        exitCode = 1;
        console.log(`\n  Database check failed: ${redact(err?.message)}`);
    }
    try {
        await reportResend(domainOfFrom);
    } catch (err) {
        exitCode = 1;
        console.log(`\n  Resend check failed: ${redact(err?.message)}`);
    }
} finally {
    await mongoose.disconnect().catch(() => {});
    console.log('\nDone (read-only; nothing was changed).');
    process.exit(exitCode);
}
