import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseRobots,
    isPathAllowed,
    isPrivateAddress,
    assertPublicUrl,
    isBlockedDomain,
    htmlToText,
    fetchPageText,
    clearRobotsCache,
} from '../src/service/kb-research/safe-fetch.js';
import {
    extractUrls,
    sanitizeInsight,
    buildKnowledgeContent,
    runResearch,
    scoreForConfidence,
    INSIGHT_SCHEMA,
} from '../src/service/kb-research/research.service.js';

console.log = () => {};

test('robots.txt: our own group wins over *, longest rule wins, Allow wins ties', () => {
    const robots = [
        'User-agent: *',
        'Disallow: /',
        '',
        'User-agent: VireactResearchBot',
        'Disallow: /private',
        'Allow: /private/public-report',
        'Disallow: /*.pdf$',
    ].join('\n');
    const rules = parseRobots(robots);
    assert.equal(isPathAllowed(rules, '/blog/hooks'), true);
    assert.equal(isPathAllowed(rules, '/private/notes'), false);
    assert.equal(isPathAllowed(rules, '/private/public-report'), true);
    assert.equal(isPathAllowed(rules, '/files/a.pdf'), false);

    const starOnly = parseRobots('User-agent: *\nDisallow: /admin\nDisallow:\n');
    assert.equal(isPathAllowed(starOnly, '/admin/x'), false);
    assert.equal(isPathAllowed(starOnly, '/blog'), true);
    assert.equal(isPathAllowed(parseRobots('User-agent: *\nDisallow: /\n'), '/anything'), false);
});

test('private and internal addresses are refused (blocks server-side request forgery)', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
        assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '104.16.1.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);

    const lookup = async (host) => (host === 'evil.example' ? [{ address: '10.0.0.5' }] : [{ address: '93.184.216.34' }]);
    await assert.rejects(assertPublicUrl('http://evil.example/x', lookup), /private/);
    await assert.rejects(assertPublicUrl('http://localhost:5000/api', lookup), /private/);
    await assert.rejects(assertPublicUrl('http://169.254.169.254/latest/meta-data', lookup), /private/);
    await assert.rejects(assertPublicUrl('file:///etc/passwd', lookup), /http/);
    await assert.doesNotReject(assertPublicUrl('https://good.example/post', lookup));
});

test('social platforms are never fetched', () => {
    for (const url of ['https://www.tiktok.com/@a/video/1', 'https://m.youtube.com/shorts/x', 'https://instagram.com/reel/1', 'https://old.reddit.com/r/x']) {
        assert.equal(isBlockedDomain(url), true, url);
    }
    assert.equal(isBlockedDomain('https://blog.hubspot.com/marketing/tiktok-hooks'), false);
});

test('htmlToText keeps the article and drops scripts, styles and navigation', () => {
    const html = `<html><head><title>Hooks &amp; Retention</title><style>p{}</style></head><body>
        <nav>Home About</nav><script>alert(1)</script>
        <article><h1>Hook study</h1><p>Opening on the result kept 71% of viewers&#39; attention.</p></article>
        <footer>Footer links</footer></body></html>`;
    const { title, text } = htmlToText(html);
    assert.equal(title, 'Hooks & Retention');
    assert.match(text, /Hook study/);
    assert.match(text, /viewers' attention/);
    assert.doesNotMatch(text, /alert|Home About|Footer/);
});

test('fetchPageText honors robots.txt and refuses redirects into private networks', async () => {
    clearRobotsCache();
    const lookup = async (host) => [{ address: host === 'internal.example' ? '10.0.0.1' : '93.184.216.34' }];
    const page = `<html><title>T</title><article>${'Real lesson text. '.repeat(60)}</article></html>`;
    const responses = {
        'https://ok.example/robots.txt': { status: 200, body: 'User-agent: *\nDisallow: /secret' },
        'https://ok.example/post': { status: 200, body: page, type: 'text/html' },
        'https://ok.example/bounce': { status: 302, location: 'https://internal.example/admin' },
    };
    const fetchImpl = async (url) => {
        const r = responses[url];
        if (!r) return new Response('', { status: 404 });
        const headers = { 'content-type': r.type || 'text/plain' };
        if (r.location) headers.location = r.location;
        return new Response(r.body ?? '', { status: r.status, headers });
    };
    const deps = { fetchImpl, lookup };
    const ok = await fetchPageText('https://ok.example/post', deps);
    assert.match(ok.text, /Real lesson text/);
    await assert.rejects(fetchPageText('https://ok.example/secret/page', deps), /robots/);
    await assert.rejects(fetchPageText('https://ok.example/bounce', deps), /private/);
});

test('extractUrls cleans tracking params and trailing punctuation', () => {
    const urls = extractUrls('See https://a.example/post?utm_source=x&id=2. Also (https://b.example/guide) | https://a.example/post?id=2');
    assert.deepEqual(urls, ['https://a.example/post?id=2', 'https://b.example/guide']);
});

test('sanitizeInsight drops weak or generic lessons and cleans the rest', () => {
    const base = {
        topic: 'hook', layer: 'pattern', specificity: 'literal', evidence: '', appliesTo: '',
        views: null, retentionPercent: null,
    };
    assert.equal(sanitizeInsight({ ...base, claim: 'Be authentic and post consistently.', example: '', confidence: 0.9 }), null);
    assert.equal(sanitizeInsight({ ...base, claim: 'Show the finished result in the first second, then explain how.', example: '', confidence: 0.3 }), null);
    assert.equal(sanitizeInsight({ ...base, topic: 'nonsense', claim: 'Show the finished result in the first second, then explain how.', example: '', confidence: 0.8 }), null);

    const kept = sanitizeInsight({
        ...base,
        claim: 'Show the finished result in the first second — then explain how you got there.',
        example: 'I turned this $5 thrift jacket into something you would pay $200 for, and it took one evening of work total',
        retentionPercent: 140,
        confidence: 0.7,
    });
    assert.ok(kept);
    assert.doesNotMatch(kept.claim, /[—–]/);
    assert.ok(kept.example.split(' ').length <= 26);
    assert.equal(kept.metrics.retentionPercent, null, 'impossible percentages are dropped');
    assert.equal(kept.specificity, 'literal');
    assert.match(buildKnowledgeContent(kept), /^Show the finished result[\s\S]*Example: "/);

    const noExample = sanitizeInsight({ ...base, claim: 'Cut every pause longer than half a second in talking-head videos.', example: '', confidence: 0.6 });
    assert.equal(noExample.specificity, 'directional', 'literal requires an example');
});

test('strict schema lists every property as required (OpenAI strict mode)', () => {
    const item = INSIGHT_SCHEMA.properties.insights.items;
    assert.deepEqual([...item.required].sort(), Object.keys(item.properties).sort());
    assert.equal(item.additionalProperties, false);
});

test('web lessons rank below first-party notes in the knowledge base', () => {
    assert.ok(scoreForConfidence(1) <= 0.85);
    assert.ok(scoreForConfidence(0.5) >= 0.3);
});

test('pipeline: searches, skips blocked and failing pages, extracts, dedupes, and saves for review', async () => {
    const vec = (seed) => Array.from({ length: 8 }, (_, i) => Math.sin(seed * (i + 1)));
    const saved = [];
    const deps = {
        search: async (q) => (q.includes('opening hooks') || q.includes('first 3 seconds')
            ? ['https://a.example/hooks', 'https://www.tiktok.com/@x/video/1', 'https://down.example/x']
            : []),
        fetchPage: async (url) => {
            if (url.includes('down')) throw new Error('HTTP 503');
            return { url, title: 'Hook study', text: 'page' };
        },
        extract: async () => [
            { topic: 'hook', layer: 'pattern', specificity: 'literal', claim: 'Open on the finished result in the first second, then explain.', evidence: '40 videos, 3s hold 52% to 71%', example: 'This took me 9 hours', appliesTo: 'DIY', views: null, retentionPercent: 71, confidence: 0.8 },
            { topic: 'hook', layer: 'pattern', specificity: 'directional', claim: 'Open on the finished result in the very first second and explain after.', evidence: '', example: '', appliesTo: '', views: null, retentionPercent: null, confidence: 0.7 },
            { topic: 'hook', layer: 'pattern', specificity: 'directional', claim: 'Know your audience.', evidence: '', example: '', appliesTo: '', views: null, retentionPercent: null, confidence: 0.9 },
        ],
        // The second lesson is a near-duplicate of the first.
        embed: async (texts) => texts.map((t, i) => (i === 1 ? vec(1).map((x) => x + 0.001) : vec(i + 1))),
        nearest: async () => ({ id: 'kb1', score: 0.8 }),
        seenUrls: async () => new Set(),
        save: async (docs) => saved.push(...docs),
    };
    const result = await runResearch({ topics: ['hook'] }, deps);
    assert.equal(result.stats.pagesRead, 1);
    assert.equal(result.stats.candidates, 1);
    assert.equal(result.stats.duplicates, 1);
    assert.ok(result.skipped.some((s) => s.url.includes('tiktok') && s.reason === 'blocked domain'));
    assert.ok(result.skipped.some((s) => s.url.includes('down') && /503/.test(s.reason)));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].sourceDomain, 'a.example');
    assert.equal(saved[0].nearestKbScore, 0.8);
    assert.ok(Array.isArray(saved[0].embedding));
    assert.equal('embedding' in result.candidates[0], false, 'embeddings are not returned to callers');
});

test('pipeline: lessons already in the knowledge base are not queued again; dry run saves nothing', async () => {
    const deps = {
        search: async () => ['https://a.example/hooks'],
        fetchPage: async (url) => ({ url, title: '', text: 'page' }),
        extract: async () => [{ topic: 'pacing', layer: 'pattern', specificity: 'directional', claim: 'Cut every pause longer than half a second in talking-head videos.', evidence: '', example: '', appliesTo: '', views: null, retentionPercent: null, confidence: 0.6 }],
        embed: async (texts) => texts.map(() => [1, 0, 0]),
        nearest: async () => ({ id: 'kb1', score: 0.99 }),
        seenUrls: async () => new Set(),
        save: async () => assert.fail('nothing should be saved'),
    };
    const dup = await runResearch({ topics: ['pacing'] }, deps);
    assert.equal(dup.stats.candidates, 0);
    assert.equal(dup.stats.duplicates, 1);

    const dry = await runResearch({ topics: ['pacing'], dryRun: true }, { ...deps, nearest: async () => assert.fail('dry run must not query the DB') });
    assert.equal(dry.stats.candidates, 1);
});
