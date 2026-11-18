/**
 * Owner console sign-in: the admin key (ADMIN_API_KEY, compared in constant time), then a short
 * server-side session. The owner asked for key-only sign-in (no phone or authenticator step).
 *
 * Sessions: a random 32-byte id in an httpOnly, Secure, SameSite=Strict cookie (prefix __Host- in
 * production); only its HMAC-SHA256 is stored. 30 minutes idle, 8 hours at most, revoked on sign-out.
 * Page scripts cannot read the cookie, and no data reaches the page without it.
 * Brute force: 5 attempts per 15 minutes per network (route), and GLOBAL_FAILURE_LIMIT failures in
 * 15 minutes from anywhere lock sign-in for everyone until the window passes.
 * Without ADMIN_API_KEY and ADMIN_SESSION_SECRET (32+ chars) the console is switched off (fails closed).
 */
import crypto from 'node:crypto';
import { OwnerSession, OwnerAudit } from '../model/owner-security.model.js';
import { isValidAdminKey } from '../middleware/adminAuth.js';
import { ApiError } from '../utils/ApiError.js';

export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_MAX_MS = 8 * 60 * 60 * 1000;
/** Failed sign-ins (any source) in the window that lock sign-in for everyone until it passes. */
export const GLOBAL_FAILURE_LIMIT = 20;
const WINDOW_MS = 15 * 60 * 1000;

const sessionSecret = () => String(process.env.ADMIN_SESSION_SECRET ?? '');

/** Names of the settings still missing (never their values). */
export const missingSettings = () => [
    !(process.env.ADMIN_API_KEY || '').trim() && 'ADMIN_API_KEY',
    sessionSecret().length < 32 && 'ADMIN_SESSION_SECRET',
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

const assertConfigured = () => {
    if (!isOwnerConsoleConfigured()) throw new ApiError(503, 'The owner console is not set up on the server.', { code: 'OWNER_NOT_CONFIGURED' });
};

const assertNotLockedOut = async () => {
    const failures = await OwnerAudit.countDocuments({ ok: false, action: 'login', createdAt: { $gte: new Date(Date.now() - WINDOW_MS) } });
    if (failures >= GLOBAL_FAILURE_LIMIT) {
        throw new ApiError(429, 'Sign-in is locked for 15 minutes after too many failed attempts.', { code: 'OWNER_LOCKED' });
    }
};

/** For the page: whether the console is set up (setting names only). */
export const consoleStatus = async () => ({
    configured: isOwnerConsoleConfigured(),
    missing: missingSettings(),
});

// Keyed with ADMIN_SESSION_SECRET, so changing that setting ends every session.
const hashSid = (sid) => crypto.createHmac('sha256', sessionSecret()).update(sid).digest('hex');

/** Admin key -> a new session id (the cookie value). */
export const signIn = async (req, { key }) => {
    assertConfigured();
    await assertNotLockedOut();
    if (!isValidAdminKey(key)) {
        await audit(req, 'login', { ok: false, detail: 'bad key' });
        console.warn(`[Owner] sign-in refused from ${req?.ip ?? 'unknown'}`);
        throw new ApiError(401, 'That key is not right.', { code: 'OWNER_DENIED' });
    }

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
