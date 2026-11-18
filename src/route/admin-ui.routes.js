import { Router } from 'express';
import fs from 'node:fs';

/**
 * Private AI response review page, served from the API's own origin at /admin/ai so it can call
 * /api/v1/admin/* without opening CORS. The page itself holds no data: it asks for ADMIN_API_KEY and
 * every data request is checked by adminAuth. Not linked from the site, not indexed, not cacheable,
 * can't be framed, and may only load its own script and talk to this origin.
 */
const read = (name) => fs.readFileSync(new URL(`../admin-ui/${name}`, import.meta.url), 'utf8');
const PAGE_HTML = read('ai-responses.html');
const PAGE_JS = read('ai-responses.js');
const EDITOR_HTML = read('editor.html');
const EDITOR_JS = read('editor.js');
const OWNER_HTML = read('owner.html');
const OWNER_JS = read('owner.js');
const HLS_JS = read('vendor/hls.light.min.js');

export const ADMIN_UI_CSP = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
].join('; ');

/**
 * Owner console (/admin/videos): same rules, plus playing users' videos (Twelve Labs HLS over https) and
 * showing their thumbnails. Scripts still only from this origin; no inline script, no framing.
 */
export const OWNER_UI_CSP = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'unsafe-inline'",
    "connect-src 'self' https:",
    "media-src 'self' blob: https:",
    "img-src 'self' data: https:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
].join('; ');

const privateHeaders = (res, csp = ADMIN_UI_CSP) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
};

const adminUiRoutes = Router();

adminUiRoutes.get('/ai', (req, res) => {
    privateHeaders(res);
    res.type('html').send(PAGE_HTML);
});

adminUiRoutes.get('/ai/app.js', (req, res) => {
    privateHeaders(res);
    res.type('application/javascript').send(PAGE_JS);
});

// Editor training data: viral examples and the licensed sound library.
adminUiRoutes.get('/editor', (req, res) => {
    privateHeaders(res);
    res.type('html').send(EDITOR_HTML);
});

adminUiRoutes.get('/editor/app.js', (req, res) => {
    privateHeaders(res);
    res.type('application/javascript').send(EDITOR_JS);
});

// Owner console: every user's videos, inputs and outputs. The page holds no data; the API behind it needs
// the admin key plus a code texted to the owner's phone (owner.routes.js).
adminUiRoutes.get('/videos', (req, res) => {
    privateHeaders(res, OWNER_UI_CSP);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.type('html').send(OWNER_HTML);
});

adminUiRoutes.get('/videos/app.js', (req, res) => {
    privateHeaders(res, OWNER_UI_CSP);
    res.type('application/javascript').send(OWNER_JS);
});

adminUiRoutes.get('/videos/hls.js', (req, res) => {
    privateHeaders(res, OWNER_UI_CSP);
    res.type('application/javascript').send(HLS_JS);
});

export default adminUiRoutes;
