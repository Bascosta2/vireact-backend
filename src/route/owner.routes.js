/**
 * Owner console API (/api/v1/owner). Used only by the private page at /admin/videos on this same origin.
 *
 * Every request must:
 *   - come from this origin: a cross-origin Origin header, or Sec-Fetch-Site other than same-origin, is refused
 *     (the vireact.io web app is allowed by CORS for the user API, but never here);
 *   - carry the header X-Vireact-Owner: 1 (not in the CORS allowlist, so no other site can send it);
 *   - be rate limited (sign-in: 5 per 15 minutes per network; data: 120 per minute).
 * Data routes also need a live owner session (admin key + texted code, see owner-auth.service.js).
 * Responses are never cached.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
    SESSION_MAX_MS, consoleStatus, requestCode, signIn, signOut, resolveSession, audit,
} from '../service/owner-auth.service.js';
import { listVideos, getVideoDetail, listUsers, getUserDetail, overview, auditLog } from '../service/owner-data.service.js';

export const OWNER_HEADER = 'x-vireact-owner';
const COOKIE_SECURE = '__Host-vx_owner';
const COOKIE_DEV = 'vx_owner';

const cookieName = (req) => (req.secure ? COOKIE_SECURE : COOKIE_DEV);
const readSid = (req) => req.cookies?.[COOKIE_SECURE] ?? req.cookies?.[COOKIE_DEV] ?? null;
const cookieOptions = (req) => ({ httpOnly: true, secure: req.secure, sameSite: 'strict', path: '/' });

const deny = (res, status, message) => res.status(status).json({ success: false, statusCode: status, message, data: null });

/** Same-origin only, with the console header. */
export const ownerOriginGuard = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    // Same-origin requests have had Origin removed by stripSameOriginHeader; anything left is another site.
    if (req.headers.origin) return deny(res, 403, 'Forbidden');
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin') return deny(res, 403, 'Forbidden');
    if (req.headers[OWNER_HEADER] !== '1') return deny(res, 403, 'Forbidden');
    next();
};

export const requireOwnerSession = async (req, res, next) => {
    try {
        const session = await resolveSession(readSid(req));
        if (!session) return deny(res, 401, 'Sign in again.');
        req.ownerSession = session;
        next();
    } catch (err) {
        next(err);
    }
};

// 5 sign-in attempts per 15 minutes per network. Tests raise it (NODE_ENV=test only) to exercise the other checks.
const SIGN_IN_MAX = process.env.NODE_ENV === 'test' && Number(process.env.OWNER_SIGNIN_LIMIT) > 0 ? Number(process.env.OWNER_SIGNIN_LIMIT) : 5;
const signInLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: SIGN_IN_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, statusCode: 429, message: 'Too many attempts. Try again in 15 minutes.', data: null },
});
const dataLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, statusCode: 429, message: 'Too many requests. Slow down for a minute.', data: null },
});

const ok = (res, data) => res.status(200).json({ success: true, statusCode: 200, message: 'OK', data });
const wrap = (fn) => async (req, res, next) => {
    try {
        await fn(req, res);
    } catch (err) {
        next(err);
    }
};

const ownerRoutes = Router();
ownerRoutes.use(ownerOriginGuard);

// ---- session
ownerRoutes.get('/session', dataLimit, wrap(async (req, res) => {
    const status = await consoleStatus();
    const session = status.configured ? await resolveSession(readSid(req)) : null;
    ok(res, { ...status, signedIn: Boolean(session), expiresAt: session?.expiresAt ?? null });
}));

// Admin key -> a code texted to the owner's phone (the number is fixed on the server).
ownerRoutes.post('/session/code', signInLimit, wrap(async (req, res) => {
    ok(res, await requestCode(req, { key: req.body?.key }));
}));

ownerRoutes.post('/session/login', signInLimit, wrap(async (req, res) => {
    const { sid, expiresAt } = await signIn(req, { key: req.body?.key, code: req.body?.code });
    res.cookie(cookieName(req), sid, { ...cookieOptions(req), maxAge: SESSION_MAX_MS });
    ok(res, { expiresAt });
}));

ownerRoutes.post('/session/logout', dataLimit, wrap(async (req, res) => {
    await signOut(req, readSid(req));
    res.clearCookie(COOKIE_SECURE, { ...cookieOptions(req), secure: true });
    res.clearCookie(COOKIE_DEV, cookieOptions(req));
    ok(res, { signedOut: true });
}));

// ---- data (signed in only)
ownerRoutes.use(dataLimit, requireOwnerSession);

ownerRoutes.get('/overview', wrap(async (req, res) => ok(res, await overview())));
ownerRoutes.get('/videos', wrap(async (req, res) => ok(res, await listVideos(req.query))));
ownerRoutes.get('/videos/:videoId', wrap(async (req, res) => {
    const detail = await getVideoDetail(req.params.videoId);
    await audit(req, 'view_video', { videoId: detail.video.id, userId: detail.user ? String(detail.user._id) : null });
    ok(res, detail);
}));
ownerRoutes.get('/users', wrap(async (req, res) => ok(res, await listUsers(req.query))));
ownerRoutes.get('/users/:userId', wrap(async (req, res) => {
    const detail = await getUserDetail(req.params.userId);
    await audit(req, 'view_user', { userId: String(detail.user._id) });
    ok(res, detail);
}));
ownerRoutes.get('/audit', wrap(async (req, res) => ok(res, await auditLog({ limit: req.query.limit }))));

export default ownerRoutes;
