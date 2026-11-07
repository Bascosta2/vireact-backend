import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.ADMIN_API_KEY = 'admin-ui-test-key-0123456789abcdef';
console.warn = () => {};
console.log = () => {};
console.error = () => {};

let server;
let base;
// Same pieces as src/app.js (importing app.js itself opens the session store's Mongo connection).
before(async () => {
    const express = (await import('express')).default;
    const cors = (await import('cors')).default;
    const { stripSameOriginHeader } = await import('../src/middleware/same-origin.js');
    const { adminRateLimit } = await import('../src/middleware/adminAuth.js');
    const adminRoutes = (await import('../src/route/admin.routes.js')).default;
    const adminUiRoutes = (await import('../src/route/admin-ui.routes.js')).default;
    const allowed = ['https://www.vireact.io'];
    const app = express();
    app.use(express.json());
    app.use(stripSameOriginHeader);
    app.use(cors({
        origin: (origin, cb) => (!origin || allowed.includes(origin) ? cb(null, true) : cb(new Error('Not allowed by CORS'))),
        allowedHeaders: ['Content-Type', 'x-admin-key'],
    }));
    app.use('/api/v1/admin', adminRateLimit, adminRoutes);
    app.use('/admin', adminRateLimit, adminUiRoutes);
    app.use((err, req, res, next) => res.status(403).json({ error: err.message }));
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

test('the private review page is served with lock-down headers and contains no data', async () => {
    const res = await fetch(`${base}/admin/ai`);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('x-robots-tag'), /noindex/);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    const html = await res.text();
    assert.match(html, /Sign in/);
    assert.match(html, /<script src="\/admin\/ai\/app.js"><\/script>/);
    assert.doesNotMatch(html, /<script>/, 'no inline script (CSP would block it)');

    const js = await fetch(`${base}/admin/ai/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
});

test('AI responses need the admin key', async () => {
    const none = await fetch(`${base}/api/v1/admin/ai-responses`);
    assert.equal(none.status, 401);
    const wrong = await fetch(`${base}/api/v1/admin/ai-responses`, { headers: { 'x-admin-key': 'guess' } });
    assert.equal(wrong.status, 401);
});

test('the page can PATCH its own origin, but other sites are still blocked by CORS', async () => {
    const own = await fetch(`${base}/api/v1/admin/ai-responses/0123456789abcdef01234567/review`, {
        method: 'PATCH',
        headers: { Origin: base, 'Content-Type': 'application/json', 'x-admin-key': 'wrong' },
        body: JSON.stringify({ rating: 'good' }),
    });
    assert.equal(own.status, 401, 'reached admin auth (not stopped by CORS)');

    const evil = await fetch(`${base}/api/v1/admin/ai-responses`, { headers: { Origin: 'https://evil.example', 'x-admin-key': 'wrong' } });
    assert.equal(evil.headers.get('access-control-allow-origin'), null, 'no CORS grant for other sites');
    assert.notEqual(evil.status, 200);
});
