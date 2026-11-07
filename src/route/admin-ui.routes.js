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

const privateHeaders = (res) => {
    res.setHeader('Content-Security-Policy', ADMIN_UI_CSP);
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

export default adminUiRoutes;
