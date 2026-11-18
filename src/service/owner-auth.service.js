/**
 * Owner console sign-in: two factors, then a short server-side session.
 *
 *   1. ADMIN_API_KEY (what you know)
 *   2. a 6-digit code from an authenticator app (what you have), standard TOTP (RFC 6238, SHA-1, 30 s)
 *
 * Setup ("enrollment") binds one authenticator. It is allowed only while none is enrolled, or when the
 * owner sets ADMIN_TOTP_RESET=true on Railway to replace a lost phone. The secret is shown once and stored
 * encrypted with a key derived from ADMIN_SESSION_SECRET. Codes can't be reused (lastTotpCounter).
 *
 * Sessions: a random 32-byte id in an httpOnly, Secure, SameSite=Strict cookie (prefix __Host- in
 * production); only its SHA-256 is stored. 30 minutes idle, 8 hours at most, revoked on sign-out.
 * Without ADMIN_SESSION_SECRET (32+ chars) and ADMIN_API_KEY the console is switched off.
 */
import crypto from 'node:crypto';
import { OwnerSecurity, OwnerSession, OwnerAudit } from '../model/owner-security.model.js';
import { isValidAdminKey } from '../middleware/adminAuth.js';
import { ApiError } from '../utils/ApiError.js';

export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_MAX_MS = 8 * 60 * 60 * 1000;
const PENDING_MS = 10 * 60 * 1000;
const STEP_SECONDS = 30;
/** Failed sign-ins (any source) in the window that lock sign-in for everyone until it passes. */
export const GLOBAL_FAILURE_LIMIT = 20;
const GLOBAL_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const ISSUER = 'Vireact Owner';

const sessionSecret = () => String(process.env.ADMIN_SESSION_SECRET ?? '');
export const isOwnerConsoleConfigured = () => sessionSecret().length >= 32 && Boolean((process.env.ADMIN_API_KEY || '').trim());
const resetAllowed = () => String(process.env.ADMIN_TOTP_RESET ?? '').trim().toLowerCase() === 'true';

// ---- base32 (RFC 4648, no padding), as authenticator apps expect
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const base32Encode = (buf) => {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of buf) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += B32[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
};
export const base32Decode = (text) => {
    const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const out = [];
    for (const ch of clean) {
        value = (value << 5) | B32.indexOf(ch);
        bits += 5;
        if (bits >= 8) {
            out.push((value >>> (bits - 8)) & 255);
            bits -= 8;
        }
    }
    return Buffer.from(out);
};

/** 6-digit code for a time step (RFC 6238 / 4226). */
export const totpCode = (secret, counter) => {
    const msg = Buffer.alloc(8);
    msg.writeBigUInt64BE(BigInt(counter));
    const mac = crypto.createHmac('sha1', secret).update(msg).digest();
    const offset = mac[mac.length - 1] & 0xf;
    const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
    return String(n).padStart(6, '0');
};

const sameCode = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The accepted time step (allowing one step of clock drift either way), or null. */
export const verifyTotp = (secret, code, { now = Date.now(), afterCounter = 0 } = {}) => {
    const clean = String(code ?? '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(clean)) return null;
    const current = Math.floor(now / 1000 / STEP_SECONDS);
    for (const counter of [current - 1, current, current + 1]) {
        if (counter > afterCounter && sameCode(totpCode(secret, counter), clean)) return counter;
    }
    return null;
};

// ---- secret encryption
const encKey = () => crypto.createHash('sha256').update(`${sessionSecret()}:owner-totp`).digest();
const encrypt = (buf) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
    const data = Buffer.concat([cipher.update(buf), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
};
const decrypt = (box) => {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(box.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
};

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

const assertNotLockedOut = async () => {
    const since = new Date(Date.now() - GLOBAL_FAILURE_WINDOW_MS);
    const failures = await OwnerAudit.countDocuments({ ok: false, action: { $in: ['login', 'enroll_start', 'enroll_confirm'] }, createdAt: { $gte: since } });
    if (failures >= GLOBAL_FAILURE_LIMIT) {
        throw new ApiError(429, 'Sign-in is locked for 15 minutes after too many failed attempts.', { code: 'OWNER_LOCKED' });
    }
};

const loadState = async () => (await OwnerSecurity.findById('owner')) ?? new OwnerSecurity({ _id: 'owner' });

/** For the page: what to show (setup, sign-in, or signed in). */
export const consoleStatus = async () => {
    if (!isOwnerConsoleConfigured()) return { configured: false, enrolled: false, setupOpen: false };
    const state = await OwnerSecurity.findById('owner').lean();
    const enrolled = Boolean(state?.totp);
    return { configured: true, enrolled, setupOpen: !enrolled || resetAllowed() };
};

/** Step 1 of setup: admin key -> a new secret to add to the authenticator app (shown once). */
export const startEnrollment = async (req, { key }) => {
    assertConfigured();
    await assertNotLockedOut();
    if (!isValidAdminKey(key)) throw await failure(req, 'enroll_start', 'bad key');
    const state = await loadState();
    if (state.totp && !resetAllowed()) {
        await audit(req, 'enroll_start', { ok: false, detail: 'already enrolled' });
        throw new ApiError(409, 'An authenticator is already set up. To replace it, set ADMIN_TOTP_RESET=true on Railway first.', { code: 'OWNER_ENROLLED' });
    }
    const secret = crypto.randomBytes(20);
    state.pendingTotp = encrypt(secret);
    state.pendingExpiresAt = new Date(Date.now() + PENDING_MS);
    await state.save();
    await audit(req, 'enroll_start');
    const b32 = base32Encode(secret);
    const label = encodeURIComponent(`${ISSUER}:owner`);
    return {
        secret: b32,
        otpauthUrl: `otpauth://totp/${label}?secret=${b32}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`,
        expiresAt: state.pendingExpiresAt,
    };
};

/** Step 2 of setup: admin key + a code from the app -> the authenticator is bound. */
export const confirmEnrollment = async (req, { key, code }) => {
    assertConfigured();
    await assertNotLockedOut();
    if (!isValidAdminKey(key)) throw await failure(req, 'enroll_confirm', 'bad key');
    const state = await loadState();
    if (state.totp && !resetAllowed()) throw new ApiError(409, 'An authenticator is already set up.', { code: 'OWNER_ENROLLED' });
    if (!state.pendingTotp || !state.pendingExpiresAt || state.pendingExpiresAt < new Date()) {
        throw new ApiError(410, 'Setup timed out. Start again.', { code: 'OWNER_SETUP_EXPIRED' });
    }
    const secret = decrypt(state.pendingTotp);
    const counter = verifyTotp(secret, code);
    if (counter == null) throw await failure(req, 'enroll_confirm', 'bad code');
    state.totp = state.pendingTotp;
    state.pendingTotp = null;
    state.pendingExpiresAt = null;
    state.enrolledAt = new Date();
    state.lastTotpCounter = counter;
    await state.save();
    // A new authenticator ends every existing session.
    await OwnerSession.updateMany({ revokedAt: null }, { $set: { revokedAt: new Date() } });
    await audit(req, 'enroll_confirm');
    return { enrolledAt: state.enrolledAt };
};

const hashSid = (sid) => crypto.createHash('sha256').update(sid).digest('hex');

/** Admin key + authenticator code -> a new session id (the cookie value). */
export const signIn = async (req, { key, code }) => {
    assertConfigured();
    await assertNotLockedOut();
    if (!isValidAdminKey(key)) throw await failure(req, 'login', 'bad key');
    const state = await OwnerSecurity.findById('owner');
    if (!state?.totp) throw new ApiError(409, 'Set up your authenticator first.', { code: 'OWNER_NOT_ENROLLED' });
    let secret;
    try {
        secret = decrypt(state.totp);
    } catch {
        throw new ApiError(409, 'ADMIN_SESSION_SECRET changed, so the linked authenticator no longer works. Set ADMIN_TOTP_RESET=true on Railway and link it again.', { code: 'OWNER_RELINK' });
    }
    const counter = verifyTotp(secret, code, { afterCounter: state.lastTotpCounter ?? 0 });
    if (counter == null) throw await failure(req, 'login', 'bad code');
    // Claim the time step atomically so the same code can't open two sessions.
    const claimed = await OwnerSecurity.updateOne({ _id: 'owner', lastTotpCounter: { $lt: counter } }, { $set: { lastTotpCounter: counter } });
    if (claimed.modifiedCount !== 1) throw await failure(req, 'login', 'code reused');

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
