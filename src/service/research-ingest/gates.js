/**
 * Hard gates for research candidates. Pure functions, no I/O.
 *
 * The cloud review agent's verdict is necessary but never sufficient: every rule here is
 * re-applied by the backend and no field in a candidate can switch one off.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020').default;

const SCHEMA = JSON.parse(fs.readFileSync(new URL('../../schemas/kb-candidate.schema.json', import.meta.url), 'utf8'));
// Formats are checked by hand below (https URLs, dates), so ajv-formats isn't needed.
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const validateSchema = ajv.compile(SCHEMA);

const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
};

/** Runtime settings (read on every call so tests and Railway changes apply without a restart). */
export const researchConfig = (env = process.env) => ({
    enabled: env.RESEARCH_INGEST_ENABLED === 'true',
    minScore: num(env.RESEARCH_MIN_SCORE, 75),
    dailyCap: Math.max(0, Math.floor(num(env.RESEARCH_DAILY_CAP, 30))),
    maxShare: Math.min(0.9, Math.max(0, num(env.RESEARCH_MAX_SHARE, 0.35))),
    minConfidence: 0.7,
    duplicateCosine: 0.92,
    metricsMaxAgeMonths: 24,
    repo: env.RESEARCH_REPO || 'Bascosta2/vireact-research',
    branch: env.RESEARCH_REPO_BRANCH || 'main',
});

/** Official platform and research hosts that count as tier-1 corroboration for a tier-3 item. */
const TIER1_HOSTS = [
    'newsroom.tiktok.com', 'support.tiktok.com', 'ads.tiktok.com', 'www.tiktok.com/creators', 'tiktok.com/creators',
    'blog.youtube', 'support.google.com', 'youtube.googleblog.com', 'www.youtube.com/creators', 'research.google',
    'about.instagram.com', 'creators.instagram.com', 'business.instagram.com', 'help.instagram.com',
    'about.fb.com', 'transparency.meta.com', 'www.facebook.com/business', 'ai.meta.com',
    'arxiv.org', 'doi.org', 'dl.acm.org', 'ieeexplore.ieee.org', 'nature.com', 'sciencedirect.com', 'pnas.org',
];

const hostAndPath = (url) => {
    try {
        const u = new URL(url);
        return `${u.hostname.replace(/^www\./, '')}${u.pathname}`.toLowerCase();
    } catch {
        return '';
    }
};

export const hostOf = (url) => {
    try {
        return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
        return '';
    }
};

/** Host entries match the host or any subdomain; host/path entries match that path prefix. */
export const isTier1Url = (url) => {
    const hp = hostAndPath(url);
    if (!hp) return false;
    const host = hp.split('/')[0];
    return TIER1_HOSTS.some((entry) => {
        const e = entry.replace(/^www\./, '').toLowerCase();
        return e.includes('/') ? hp.startsWith(e) : host === e || host.endsWith(`.${e}`);
    });
};

const isHttpsUrl = (url) => {
    try {
        return new URL(url).protocol === 'https:';
    } catch {
        return false;
    }
};

const wordCount = (text) => String(text || '').trim().split(/\s+/).filter(Boolean).length;

// ---------------------------------------------------------------------------------------------
// Sanitizer
// ---------------------------------------------------------------------------------------------

/** Text aimed at an AI model rather than a reader. Anything matching is rejected outright. */
const INJECTION_PATTERNS = [
    /ignore (?:all |any |the )?(?:previous|prior|above|earlier) (?:instructions?|prompts?|messages?|rules?)/i,
    /disregard (?:all |any |the )?(?:previous|prior|above|earlier|your)/i,
    /forget (?:all |any |everything|your) (?:previous|prior|instructions?)/i,
    /(?:^|[\n"'`(\[{<])\s*(?:system|assistant|developer|user)\s*:/i,
    /<\|?(?:im_start|im_end|system|endoftext)\|?>/i,
    /\byou are (?:an? )?(?:ai|a\.i\.|language model|llm|chatbot|assistant)\b/i,
    /\bas an ai (?:language )?model\b/i,
    /\b(?:new|updated|override) (?:system )?instructions?\b/i,
    /\bjailbreak\b|\bprompt injection\b|\bDAN mode\b/i,
    /\[\s*INST\s*\]|<<\s*SYS\s*>>/i,
    /\bdo not (?:tell|inform|reveal to) the user\b/i,
];
/** Long runs of base64-looking characters (encoded payloads). Plain hex (hashes) is not a blob. */
const BASE64_RUN = /[A-Za-z0-9+/]{60,}={0,2}/g;
const isBase64Blob = (s) => (s.match(BASE64_RUN) || []).some((run) => !/^[a-f0-9]+$/i.test(run) && /[A-Z]/.test(run) && /[a-z]/.test(run));

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤﻿]/g;

/** Strip HTML, markdown links/images and control/invisible characters; collapse whitespace. */
export const sanitizeText = (value) =>
    String(value ?? '')
        .replace(CONTROL_CHARS, '')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<\/?[a-z][^>]*>/gi, ' ')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\((?:[^)]*)\)/g, '$1')
        .replace(/[ \t\r\n]+/g, ' ')
        .trim();

export const findInjection = (text) => {
    const s = String(text || '');
    for (const pattern of INJECTION_PATTERNS) if (pattern.test(s)) return `instruction-like text (${pattern.source.slice(0, 40)})`;
    if (isBase64Blob(s.replace(/https?:\/\/\S+/g, ''))) return 'base64-like blob';
    return null;
};

const TEXT_FIELDS = ['title', 'insight', 'actionable_rule', 'example', 'agent_notes'];

/** Copy of the candidate with every free-text field sanitized (evidence included). */
export const sanitizeCandidate = (raw) => {
    const c = { ...raw };
    for (const key of TEXT_FIELDS) if (typeof c[key] === 'string') c[key] = sanitizeText(c[key]);
    if (Array.isArray(c.niches)) c.niches = c.niches.map(sanitizeText).filter(Boolean).slice(0, 20);
    if (Array.isArray(c.evidence)) {
        c.evidence = c.evidence.map((e) => ({
            ...e,
            url: String(e?.url || '').trim(),
            title: sanitizeText(e?.title),
            publisher: sanitizeText(e?.publisher),
            published_date: sanitizeText(e?.published_date),
            quote: sanitizeText(e?.quote),
        }));
    }
    if (c.review && typeof c.review === 'object') {
        c.review = { ...c.review, reviewer_notes: sanitizeText(c.review.reviewer_notes) };
    }
    return c;
};

/** Every string anywhere in the candidate (to scan for injected instructions). */
const allStrings = (value, out = []) => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach((v) => allStrings(v, out));
    else if (value && typeof value === 'object') Object.values(value).forEach((v) => allStrings(v, out));
    return out;
};

// ---------------------------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------------------------

const parseDate = (value) => {
    const s = String(value || '').trim();
    if (!s) return null;
    const m = s.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
    if (m) return new Date(Date.UTC(Number(m[1]), m[2] ? Number(m[2]) - 1 : 0, m[3] ? Number(m[3]) : 1));
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
};

const monthsBetween = (a, b) => (b.getTime() - a.getTime()) / (30.44 * 24 * 3600 * 1000);

/**
 * Check one candidate. Returns { ok: true, candidate } with the sanitized candidate,
 * or { ok: false, status: 'invalid'|'rejected', reason }.
 *
 * `invalid` = malformed (schema, limits); `rejected` = well-formed but fails a quality/safety rule.
 */
export const checkCandidate = (raw, { now = new Date(), config = researchConfig() } = {}) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, status: 'invalid', reason: 'not a JSON object' };

    // Injection scan runs on the raw text, before sanitizing can hide anything (id is a checked hash).
    const { id: _id, ...scanned } = raw;
    for (const s of allStrings(scanned)) {
        const hit = findInjection(s);
        if (hit) return { ok: false, status: 'rejected', reason: hit };
    }

    const c = sanitizeCandidate(raw);
    if (!validateSchema(c)) {
        const first = validateSchema.errors?.[0];
        return { ok: false, status: 'invalid', reason: `schema: ${first?.instancePath || '/'} ${first?.message || 'invalid'}`.trim() };
    }
    if (wordCount(c.insight) > 150) return { ok: false, status: 'invalid', reason: 'insight over 150 words' };
    if (c.example && wordCount(c.example) > 60) return { ok: false, status: 'invalid', reason: 'example over 60 words' };
    if (c.evidence.some((e) => e.quote && wordCount(e.quote) > 25)) return { ok: false, status: 'invalid', reason: 'evidence quote over 25 words' };
    if (!c.title || !c.insight || !c.actionable_rule) return { ok: false, status: 'invalid', reason: 'empty text after sanitizing' };

    // Review verdict and score.
    if (!c.review || typeof c.review !== 'object') return { ok: false, status: 'rejected', reason: 'no review' };
    if (c.review.verdict !== 'approve') return { ok: false, status: 'rejected', reason: `review verdict ${c.review.verdict || 'missing'}` };
    if (!(Number(c.review.score) >= config.minScore)) return { ok: false, status: 'rejected', reason: `review score ${c.review.score} < ${config.minScore}` };

    // Evidence.
    const httpsEvidence = c.evidence.filter((e) => isHttpsUrl(e.url));
    if (!httpsEvidence.length) return { ok: false, status: 'rejected', reason: 'no https evidence URL' };
    if (c.source_tier === 2) {
        const publishers = new Set(httpsEvidence.map((e) => (e.publisher || hostOf(e.url)).toLowerCase().trim()).filter(Boolean));
        if (publishers.size < 2) return { ok: false, status: 'rejected', reason: 'tier 2 needs 2+ distinct publishers' };
    }
    if (c.source_tier === 3) {
        const corroborated = httpsEvidence.some((e) => e.source_tier === 1 || e.source_tier === 2 || isTier1Url(e.url));
        if (!corroborated) return { ok: false, status: 'rejected', reason: 'tier 3 without tier-1/2 corroboration' };
    }

    if (!(c.confidence >= config.minConfidence)) return { ok: false, status: 'rejected', reason: `confidence ${c.confidence} < ${config.minConfidence}` };

    // Metrics must be recent unless the insight is evergreen.
    if (c.freshness !== 'evergreen' && Array.isArray(c.metrics) && c.metrics.length) {
        const dates = httpsEvidence.map((e) => parseDate(e.published_date)).filter(Boolean);
        const newest = dates.sort((a, b) => b - a)[0];
        if (!newest) return { ok: false, status: 'rejected', reason: 'metrics without a dated source' };
        if (monthsBetween(newest, now) > config.metricsMaxAgeMonths) return { ok: false, status: 'rejected', reason: 'metrics older than 24 months' };
    }

    return { ok: true, candidate: c };
};

// ---------------------------------------------------------------------------------------------
// Knowledge-base mapping
// ---------------------------------------------------------------------------------------------

/** Candidate topic -> knowledge-base `metadata.topic` (the retrieval filter values). */
const KB_TOPIC = { hook: 'hook', pacing: 'pacing', caption: 'caption', audio: 'audio', views: 'views_predictor', advanced_analytics: 'advanced_analytics', general: 'general' };

export const kbTopicFor = (candidate) => KB_TOPIC[candidate.topics?.[0]] || 'general';

/** The text that gets embedded. Citations stay in metadata, never in the embedded text. */
export const buildResearchContent = (c) =>
    [c.title, c.insight, `Rule: ${c.actionable_rule}`, c.example ? `Example: ${c.example}` : '']
        .filter(Boolean)
        .join(' — ');

/** Retrieval weight: below the owner's first-party notes (0.9), scaled by confidence and review score. */
export const scoreForResearch = (c) => {
    const base = 0.35 + 0.5 * Number(c.confidence || 0);
    const review = Math.min(1, Math.max(0, Number(c.review?.score || 0) / 100));
    return Math.round(Math.min(0.85, Math.max(0.3, base * (0.8 + 0.2 * review))) * 100) / 100;
};

export const knowledgeDocFor = (c, { batch, embedding, now = new Date() }) => ({
    content: buildResearchContent(c),
    embedding,
    metadata: {
        topic: kbTopicFor(c),
        layer: c.type === 'case_study' ? 'example' : 'pattern',
        specificity: c.example ? 'literal' : 'directional',
        author: 'Vireact Research',
        source: 'Vireact Research',
        sourceType: 'research',
        contentType: 'research_insight',
        score: scoreForResearch(c),
        platform: c.platforms?.join(',') || undefined,
        ingestedAt: now,
        origin: 'research',
        researchBatch: batch,
        researchId: c.id,
        researchType: c.type,
        sourceUrls: c.evidence.map((e) => e.url).filter(Boolean),
        topics: c.topics,
        platforms: c.platforms,
        niches: c.niches?.length ? c.niches : undefined,
        reviewScore: Number(c.review?.score) || undefined,
    },
});

/** How many more research docs fit under the max-share cap: (r + n) / (t + n) <= share. */
export const remainingShare = ({ totalDocs, researchDocs, maxShare }) => {
    if (maxShare <= 0) return 0;
    if (maxShare >= 1) return Infinity;
    return Math.max(0, Math.floor((maxShare * totalDocs - researchDocs) / (1 - maxShare)));
};
