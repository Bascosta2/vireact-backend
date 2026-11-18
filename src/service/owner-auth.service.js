/**
 * Owner console sign-in: two factors, then a short server-side session.
 *
 *   1. ADMIN_API_KEY (what you know)
 *   2. a 6-digit code texted to the owner's phone (what you have), via Twilio Verify
 *
 * The phone number comes only from ADMIN_OWNER_PHONE on the server; nothing in a request can choose or
 * change where codes go. A code is texted only after the admin key checks out, at most SMS_SEND_LIMIT
 * times per 15 minutes in total. Twilio's codes are single-use and expire after 10 minutes.
 *
 * Sessions: a random 32-byte id in an httpOnly, Secure, SameSite=Strict cookie (prefix __Host- in
 * production); only its SHA-256 is stored. 30 minutes idle, 8 hours at most, revoked on sign-out.
 * Without ADMIN_API_KEY, ADMIN_SESSION_SECRET (32+ chars), ADMIN_OWNER_PHONE and the Twilio Verify
 * settings, the console is switched off (fails closed).
 */
import crypto from 'node:crypto';
import { OwnerSession, OwnerAudit } from '../model/owner-security.model.js';
import { isValidAdminKey } from '../middleware/adminAuth.js';
import { isVerifyConfigured, sendVerificationCode, checkVerificationCode } from '../lib/twilio-verify.js';
import { ApiError } from '../utils/ApiError.js';

export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_MAX_MS = 8 * 60 * 60 * 1000;
/** Failed sign-ins (any source) in the window that lock sign-in for everyone until it passes. */
export const GLOBAL_FAILURE_LIMIT = 20;
/** Texts sent in the window, in total (stops anyone with the key from flooding the phone or the bill). */
export const SMS_SEND_LIMIT = 5;
const WINDOW_MS = 15 * 60 * 1000;

const sessionSecret = () => String(process.env.ADMIN_SESSION_SECRET ?? '');
/** The owner's phone in E.164 (+15551234567), or null when missing or malformed. */
export const ownerPhone = () => {
    const raw = String(process.env.ADMIN_OWNER_PHONE ?? '').replace(/[\s().-]/g, '');
    return /^\+[1-9]\d{7,14}$/.test(raw) ? raw : null;
};
export const maskPhone = (e164) => (e164 ? `•••-•••-${e164.slice(-4)}` : null);

/** Names of the settings still missing (never their values). */
export const missingSettings = () => [
    !(process.env.ADMIN_API_KEY || '').trim() && 'ADMIN_API_KEY',
    sessionSecret().length < 32 && 'ADMIN_SESSION_SECRET',
    !ownerPhone() && 'ADMIN_OWNER_PHONE',
    !isVerifyConfigured() && 'TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_VERIFY_SERVICE_SID',
].filter(Boolean);
export const isOwnerConsoleConfigured = () => missingSettings().length === 0;

// ---- audit
export const audit = (req, action, extra = {}) =>
    OwnerAudit.create({
        action,
        ok: extra.ok ?? true,
        detail: extra.detail ?? null,
        videoId: extra.videoId ?? null,
        userId: extra.userId ?? null,
        ip: req?.ip ?? null,
        userAgent: String(req?.headers?.['user-agent'] ?? '').slice(0, 300) || null,
    }).catch((err) => console.warn(`[Owner] audit write failed: ${err.message}`));

const failure = async (req, action, detail) => {
    await audit(req, action, { ok: false, detail });
    console.warn(`[Owner] ${action} refused (${detail}) from ${req?.ip ?? 'unknown'}`);
    return new ApiError(401, 'That key or code is not right.', { code: 'OWNER_DENIED' });
};

const assertConfigured = () => {
    if (!isOwnerConsoleConfigured()) throw new ApiError(503, 'The owner console is not set up on the server.', { code: 'OWNER_NOT_CONFIGURED' });
};

const since = () => new Date(Date.now() - WINDOW_MS);

const assertNotLockedOut = async () => {
    const failures = await OwnerAudit.countDocuments({ ok: false, action: { $in: ['login', 'sms_send'] }, createdAt: { $gte: since() } });
    if (failures >= GLOBAL_FAILURE_LIMIT) {
        throw new ApiError(429, 'Sign-in is locked for 15 minutes after too many failed attempts.', { code: 'OWNER_LOCKED' });
    }
};

/** For the page: whether the console is set up, and where codes go (masked). */
export const consoleStatus = async () => ({
    configured: isOwnerConsoleConfigured(),
    missing: missingSettings(),
    phoneHint: maskPhone(ownerPhone()),
});

/** Step 1: admin key -> a code texted to the owner's phone. */
export const requestCode = async (req, { key }) => {
    assertConfigured();
    await assertNotLockedOut();
    if (!isValidAdminKey(key)) throw await failure(req, 'sms_send', 'bad key');
    const sent = await OwnerAudit.countDocuments({ action: 'sms_send', ok: true, createdAt: { $gte: since() } });
    if (sent >= SMS_SEND_LIMIT) {
        throw new ApiError(429, 'Too many codes sent. Wait 15 minutes, then try again.', { code: 'OWNER_SMS_LIMIT' });
    }
    const phone = ownerPhone();
    let ok = false;
    try {
        ok = await sendVerificationCode(phone);
    } catch (err) {
        console.warn(`[Owner] SMS send error: ${err.message}`);
    }
    if (!ok) {
        await audit(req, 'sms_send', { ok: false, detail: 'provider error' });
        throw new ApiError(502, 'The text could not be sent. Try again in a minute.', { code: 'OWNER_SMS_FAILED' });
    }
    await audit(req, 'sms_send');
    return { sentTo: maskPhone(phone) };
};

const hashSid = (sid) => crypto.createHash('sha256').update(sid).digest('hex');

/** Step 2: admin key + the texted code -> a new session id (the cookie value). */
export const signIn = async (req, { key, code }) => {
    assertConfigured();
    await assertNotLockedOut();
    if (!isValidAdminKey(key)) throw await failure(req, 'login', 'bad key');
    const clean = String(code ?? '').replace(/\s/g, '');
    if (!/^\d{4,10}$/.test(clean)) throw await failure(req, 'login', 'bad code');
    let approved = false;
    try {
        approved = await checkVerificationCode(ownerPhone(), clean);
    } catch (err) {
        console.warn(`[Owner] SMS check error: ${err.message}`);
        throw new ApiError(502, 'The code could not be checked. Try again in a minute.', { code: 'OWNER_SMS_FAILED' });
    }
    if (!approved) throw await failure(req, 'login', 'bad code');

    const sid = crypto.randomBytes(32).toString('base64url');
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_MAX_MS);
    await OwnerSession.create({
        sidHash: hashSid(sid), expiresAt, lastSeenAt: now, ip: req?.ip ?? null,
        userAgent: String(req?.headers?.['user-agent'] ?? '').slice(0, 300) || null,
    });
    await audit(req, 'login');
    return { sid, expiresAt };
};

/** The live session for a cookie value, refreshing its idle timer. Null when missing, expired or revoked. */
export const resolveSession = async (sid, now = new Date()) => {
    if (!sid || typeof sid !== 'string' || sid.length > 100) return null;
    const session = await OwnerSession.findOne({ sidHash: hashSid(sid), revokedAt: null });
    if (!session) return null;
    if (session.expiresAt <= now || now - session.lastSeenAt > SESSION_IDLE_MS) {
        session.revokedAt = now;
        await session.save();
        return null;
    }
    if (now - session.lastSeenAt > 60 * 1000) {
        session.lastSeenAt = now;
        await session.save();
    }
    return session;
};

export const signOut = async (req, sid) => {
    if (sid) await OwnerSession.updateOne({ sidHash: hashSid(sid), revokedAt: null }, { $set: { revokedAt: new Date() } });
    await audit(req, 'logout');
};
