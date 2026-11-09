/**
 * Analytics tab, Strategy: a 2-week content plan built from the creator's own videos and results.
 *
 * Division of labour, so the plan is reliable and honest:
 * - Deterministic (this file): which videos it sees, the posting slots (dates, times, platforms), the
 *   confidence level (from how many real results exist) and the next milestone (from their own median).
 * - Model: diagnosis, content pillars, the "winning formula", what to post in each slot, experiments.
 * - Validator: every claim must cite the creator's real videos, every slot must be filled, every pillar
 *   used, and no promises of virality. One correction retry, then it fails cleanly (not counted).
 */
import mongoose from 'mongoose';
import { Video } from '../model/video.model.js';
import { ANALYSIS_STATUS } from '../constants.js';
import { requestStructuredCompletion } from './openai-response.service.js';
import { retrieveKnowledge, formatKnowledgeContext } from './analyzer/retrieve-knowledge.js';
import { VOICE_RULES, cleanUserText } from './analyzer/voice.js';
import { withAiContext, lastGenerationId, markGenerationValidation } from '../lib/ai-tracking.js';
import { buildOverview, checkScores, latestViews, videoTitle, outcomeFor, CHECKS } from './analytics.service.js';
import { displayViewBand, percentile } from './view-prediction.service.js';
import { DEFAULT_POSTS_PER_WEEK } from './creator-profile.service.js';

export const PLAN_DAYS = 14;
export const MAX_VIDEOS_IN_PROMPT = 30;
const MAX_SLOTS_PER_DAY = 3;
const DEFAULT_POST_HOUR = 18;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const CONTENT_FORMATS = Object.freeze([
    'talking_head', 'tutorial', 'storytime', 'skit', 'vlog', 'voiceover_broll', 'slideshow', 'reaction', 'product_demo', 'other',
]);
export const HOOK_TYPES = Object.freeze([
    'question', 'bold_claim', 'result_first', 'curiosity_gap', 'list_countdown', 'mistake_warning', 'story_open', 'visual_only', 'none',
]);

/** Promises we never make. "Go viral" as a goal is fine; claiming a post will is not. */
const BANNED = /\b(guarantee[ds]?|guaranteed|will\s+(?:definitely\s+|certainly\s+|surely\s+)?(?:go|be)\s+viral|100%\s+(?:viral|success)|overnight\s+success|explode\s+your)\b/i;

// ─── Deterministic parts ────────────────────────────────────────────────────

/** low under 3 real results, medium under 8, else high. */
export const confidenceFor = (withResults) => (withResults >= 8 ? 'high' : withResults >= 3 ? 'medium' : 'low');

/** { date: 'YYYY-MM-DD', weekday: 0-6 } for an instant, in a time zone. */
export const localDay = (instant, timeZone = 'UTC') => {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instant));
    const weekdayShort = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(instant));
    return { date, weekday: WEEKDAY_NAMES.indexOf(weekdayShort) };
};

/** Evenly spaced picks of n items from a list of length c (n <= c). */
const spread = (c, n) => Array.from({ length: n }, (_, k) => Math.floor((k * c) / n));

const hhmm = (hour) => `${String(Math.max(0, Math.min(23, hour))).padStart(2, '0')}:00`;

/** Post times for `count` posts on one day, anchored on the best hour. */
const timesForDay = (count, baseHour) => {
    if (count <= 1) return [hhmm(baseHour)];
    if (count === 2) return [hhmm(12), hhmm(Math.max(baseHour, 17))];
    return [hhmm(9), hhmm(13), hhmm(Math.max(baseHour, 18))];
};

/**
 * The posting slots for the next PLAN_DAYS days (starting tomorrow), in the creator's time zone.
 * postsPerWeek per calendar block of 7 days, on preferred days when given (all days otherwise),
 * evenly spaced, max MAX_SLOTS_PER_DAY a day. Platforms rotate through the creator's platforms.
 */
export const planSlots = ({ postsPerWeek, preferredDays = [], platforms = [], timeZone = 'UTC', bestStartHour = null, now = Date.now() }) => {
    const perWeek = Math.max(1, Math.min(MAX_SLOTS_PER_DAY * 7, Math.round(postsPerWeek || DEFAULT_POSTS_PER_WEEK)));
    const baseHour = Number.isInteger(bestStartHour) ? bestStartHour + 1 : DEFAULT_POST_HOUR; // middle of the 3-hour block
    const days = Array.from({ length: PLAN_DAYS }, (_, i) => localDay(now + (i + 1) * DAY_MS, timeZone));
    const rotation = platforms.length ? platforms : ['tiktok'];
    const slots = [];
    for (let week = 0; week < PLAN_DAYS / 7; week += 1) {
        const weekDays = days.slice(week * 7, week * 7 + 7);
        let candidates = preferredDays.length ? weekDays.filter((d) => preferredDays.includes(d.weekday)) : weekDays;
        if (candidates.length * MAX_SLOTS_PER_DAY < perWeek || candidates.length === 0) candidates = weekDays;
        const counts = new Array(candidates.length).fill(0);
        if (perWeek <= candidates.length) {
            for (const i of spread(candidates.length, perWeek)) counts[i] = 1;
        } else {
            const base = Math.floor(perWeek / candidates.length);
            counts.fill(base);
            for (const i of spread(candidates.length, perWeek - base * candidates.length)) counts[i] += 1;
        }
        candidates.forEach((day, i) => {
            for (const timeLocal of timesForDay(counts[i], baseHour).slice(0, counts[i])) {
                slots.push({ date: day.date, weekday: day.weekday, timeLocal });
            }
        });
    }
    return slots
        .sort((a, b) => (a.date + a.timeLocal).localeCompare(b.date + b.timeLocal))
        .map((slot, i) => ({ id: `s${i + 1}`, ...slot, platform: rotation[i % rotation.length] }));
};

/** A realistic next target from the creator's own results. Never a promise. */
export const computeMilestone = (videos) => {
    const views = videos.map(latestViews).filter((v) => v != null).sort((a, b) => a - b);
    if (views.length < 3) {
        return {
            metric: 'results_logged',
            current: views.length,
            target: 3,
            basis: 'Log real views for 3 posts so the plan can learn what works for your account.',
        };
    }
    const median = Math.round(percentile(views, 0.5));
    const target = Math.max(median + 10, Math.round((median * 1.3) / 10) * 10);
    return {
        metric: 'median_views',
        current: median,
        target,
        basis: `Your median post gets ${median.toLocaleString('en-US')} views. Lift the typical post about 30% over the next 2 weeks.`,
    };
};

const hookLineOf = (v) => {
    const spoken = (v.rawTranscript ?? []).map((s) => s.text).join(' ').trim();
    if (spoken) return spoken.slice(0, 160);
    const scene = v.scenes?.[0];
    return [scene?.visualDescription, scene?.primaryAction].filter(Boolean).join('. ').slice(0, 160) || null;
};

const weakestFeedback = (v) => (v.analysis ?? [])
    .filter((a) => CHECKS.includes(a.feature) && typeof a.score === 'number' && a.feedback)
    .sort((a, b) => a.score - b.score)
    .slice(0, 2)
    .map((a) => `${a.feature}: ${String(a.feedback).replace(/\s+/g, ' ').slice(0, 160)}`);

/** Short refs (V1..Vn, newest first) so the model cites videos without handling Mongo ids. */
export const buildVideoDigest = (videos, timeZone = 'UTC') => {
    const refMap = new Map();
    const lines = videos.map((v, i) => {
        const ref = `V${i + 1}`;
        refMap.set(ref, String(v._id));
        const checks = checkScores(v);
        const band = displayViewBand(v);
        const actual = latestViews(v);
        const outcome = outcomeFor(actual, band);
        const parts = [
            `${ref} | analyzed ${localDay(v.createdAt, timeZone).date}`,
            `"${videoTitle(v).slice(0, 60)}"`,
            `score ${v.viralityScore} (${CHECKS.map((c) => `${c} ${checks[c] ?? '-'}`).join(', ')})`,
        ];
        if (Number.isFinite(v.duration)) parts.push(`${Math.round(v.duration)}s`);
        if (v.contentProfile?.topic) parts.push(`topic: ${v.contentProfile.topic}, format: ${v.contentProfile.format}, hook type: ${v.contentProfile.hookType}`);
        const hook = hookLineOf(v);
        if (hook) parts.push(`opening: "${hook}"`);
        if (Number.isFinite(band.low)) parts.push(`predicted ${band.low}-${band.high} views`);
        if (actual != null) parts.push(`ACTUAL ${actual} views (${outcome ?? 'n/a'})`);
        if (v.postedAt) {
            const d = localDay(v.postedAt, timeZone);
            parts.push(`posted ${WEEKDAY_NAMES[d.weekday]} ${d.date}`);
        }
        const fb = weakestFeedback(v);
        if (fb.length) parts.push(`weakest: ${fb.join(' / ')}`);
        return parts.join(' | ');
    });
    return { refMap, text: lines.join('\n') || 'No analyzed videos yet.' };
};

// ─── Model contract ─────────────────────────────────────────────────────────

const str = (description) => ({ type: 'string', description });
const evidenceItemSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['point', 'metric', 'evidence'],
    properties: {
        point: str('One plain sentence about this creator.'),
        metric: str('The number from their data that shows it, e.g. "hook averages 38 vs pacing 61".'),
        evidence: { type: 'array', items: str('A video ref like V3.') },
    },
};

export const strategyJsonSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['diagnosis', 'pillars', 'formula', 'slots', 'experiments'],
    properties: {
        diagnosis: {
            type: 'object',
            additionalProperties: false,
            required: ['headline', 'strengths', 'weaknesses'],
            properties: {
                headline: str('One sentence: the single most important thing about this account right now.'),
                strengths: { type: 'array', items: evidenceItemSchema },
                weaknesses: { type: 'array', items: evidenceItemSchema },
            },
        },
        pillars: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'why', 'targetShare', 'evidence'],
                properties: {
                    name: str('Two to four words.'),
                    why: str('One or two sentences grounded in their results.'),
                    targetShare: { type: 'number', description: 'Percent of posts. All pillars sum to 100.' },
                    evidence: { type: 'array', items: str('A video ref like V3.') },
                },
            },
        },
        formula: {
            type: 'object',
            additionalProperties: false,
            required: ['hookPatterns', 'idealLengthSec', 'pacing', 'captionStyle', 'ctaStyle', 'avoid'],
            properties: {
                hookPatterns: { type: 'array', items: str('A hook pattern with a fill-in example for their niche.') },
                idealLengthSec: { type: 'number' },
                pacing: str('Concrete pacing rule, e.g. "a new visual every 2 seconds in the first 6".'),
                captionStyle: str('Concrete on-screen text rule.'),
                ctaStyle: str('Concrete closing rule.'),
                avoid: { type: 'array', items: str('Something their data says to stop doing.') },
            },
        },
        slots: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'pillar', 'title', 'concept', 'hook', 'beats', 'lengthSec', 'cta', 'rationale'],
                properties: {
                    id: str('The slot id you were given, e.g. s1.'),
                    pillar: str('Exactly one of your pillar names.'),
                    title: str('Working title, under 8 words.'),
                    concept: str('One or two sentences: what the video shows.'),
                    hook: str('The exact first line or on-screen text for the first 2 seconds.'),
                    beats: { type: 'array', items: str('One beat of the video, in order. 3 to 6 beats.') },
                    lengthSec: { type: 'number' },
                    cta: str('The exact closing line or overlay.'),
                    rationale: str('One sentence: why this, now, citing their data (refs like V3 allowed).'),
                },
            },
        },
        experiments: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['hypothesis', 'howToTest', 'successMetric'],
                properties: {
                    hypothesis: str('What we think will help, specific to them.'),
                    howToTest: str('Which slots to use and what to change.'),
                    successMetric: str('The number that decides it, from their own results.'),
                },
            },
        },
    },
};

const allStrings = (value, out = []) => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach((v) => allStrings(v, out));
    else if (value && typeof value === 'object') Object.values(value).forEach((v) => allStrings(v, out));
    return out;
};

/** Returns a list of problems (empty = valid). */
export const validateStrategyPayload = (payload, { refs, slotIds }) => {
    const issues = [];
    const known = new Set(refs);
    const pillars = payload?.pillars ?? [];
    const names = new Set(pillars.map((p) => p.name));
    if (pillars.length < 2 || pillars.length > 5) issues.push(`Give 2 to 5 pillars (got ${pillars.length}).`);

    const slots = payload?.slots ?? [];
    const gotIds = slots.map((s) => s.id);
    const missing = slotIds.filter((id) => !gotIds.includes(id));
    const extra = gotIds.filter((id) => !slotIds.includes(id));
    if (missing.length || extra.length || gotIds.length !== slotIds.length) {
        issues.push(`Fill exactly these slots, once each: ${slotIds.join(', ')}.${missing.length ? ` Missing: ${missing.join(', ')}.` : ''}${extra.length ? ` Unknown: ${extra.join(', ')}.` : ''}`);
    }
    for (const slot of slots) {
        if (!names.has(slot.pillar)) issues.push(`Slot ${slot.id} uses pillar "${slot.pillar}", which is not one of your pillars.`);
        if (!String(slot.hook ?? '').trim()) issues.push(`Slot ${slot.id} has no hook.`);
        if (!String(slot.title ?? '').trim()) issues.push(`Slot ${slot.id} has no title.`);
    }
    if (slots.length >= pillars.length) {
        const used = new Set(slots.map((s) => s.pillar));
        for (const name of names) if (!used.has(name)) issues.push(`Pillar "${name}" is never scheduled.`);
    }

    const cited = [
        ...(payload?.diagnosis?.strengths ?? []).flatMap((s) => s.evidence ?? []),
        ...(payload?.diagnosis?.weaknesses ?? []).flatMap((s) => s.evidence ?? []),
        ...pillars.flatMap((p) => p.evidence ?? []),
    ];
    const unknown = [...new Set(cited.filter((r) => !known.has(r)))];
    if (unknown.length) issues.push(`These video refs do not exist: ${unknown.join(', ')}. Only cite ${refs.length ? refs.join(', ') : 'nothing (there are no videos)'}.`);

    const promises = allStrings(payload).filter((s) => BANNED.test(s));
    if (promises.length) issues.push(`Remove promises of results ("guaranteed", "will go viral"): "${promises[0].slice(0, 80)}".`);
    return issues;
};

const clean = (s, max = 400) => cleanUserText(String(s ?? '').trim()).slice(0, max);
const toIds = (refs, refMap) => [...new Set((refs ?? []).map((r) => refMap.get(r)).filter(Boolean))]
    .map((id) => new mongoose.Types.ObjectId(id));
const clamp = (n, lo, hi, fallback) => (Number.isFinite(Number(n)) ? Math.max(lo, Math.min(hi, Math.round(Number(n)))) : fallback);

/** Model payload + deterministic slots → stored fields. */
export const normalizeStrategy = (payload, { refMap, plannedSlots }) => {
    const pillars = (payload.pillars ?? []).slice(0, 5);
    const shareTotal = pillars.reduce((sum, p) => sum + Math.max(0, Number(p.targetShare) || 0), 0);
    const byId = new Map((payload.slots ?? []).map((s) => [s.id, s]));
    const evidence = (items) => (items ?? []).slice(0, 4).map((s) => ({ point: clean(s.point), metric: clean(s.metric, 200), evidenceVideoIds: toIds(s.evidence, refMap) }));
    return {
        diagnosis: {
            headline: clean(payload.diagnosis?.headline, 300),
            strengths: evidence(payload.diagnosis?.strengths),
            weaknesses: evidence(payload.diagnosis?.weaknesses),
        },
        pillars: pillars.map((p) => ({
            name: clean(p.name, 60),
            why: clean(p.why),
            targetShare: shareTotal > 0 ? Math.round((Math.max(0, Number(p.targetShare) || 0) / shareTotal) * 100) : Math.round(100 / pillars.length),
            evidenceVideoIds: toIds(p.evidence, refMap),
        })),
        formula: {
            hookPatterns: (payload.formula?.hookPatterns ?? []).slice(0, 5).map((s) => clean(s, 240)),
            idealLengthSec: clamp(payload.formula?.idealLengthSec, 5, 180, 30),
            pacing: clean(payload.formula?.pacing),
            captionStyle: clean(payload.formula?.captionStyle),
            ctaStyle: clean(payload.formula?.ctaStyle),
            avoid: (payload.formula?.avoid ?? []).slice(0, 5).map((s) => clean(s, 240)),
        },
        slots: plannedSlots.map((planned) => {
            const s = byId.get(planned.id) ?? {};
            return {
                id: planned.id,
                date: planned.date,
                timeLocal: planned.timeLocal,
                platform: planned.platform,
                pillar: clean(s.pillar, 60),
                title: clean(s.title, 120),
                concept: clean(s.concept),
                hook: clean(s.hook, 240),
                beats: (s.beats ?? []).slice(0, 6).map((b) => clean(b, 240)),
                lengthSec: clamp(s.lengthSec, 5, 180, 30),
                cta: clean(s.cta, 200),
                rationale: clean(s.rationale, 300),
                status: 'planned',
                linkedVideoId: null,
            };
        }),
        experiments: (payload.experiments ?? []).slice(0, 3).map((e) => ({
            hypothesis: clean(e.hypothesis, 300),
            howToTest: clean(e.howToTest, 300),
            successMetric: clean(e.successMetric, 200),
        })),
    };
};

// ─── Content profiles (cached per video) ────────────────────────────────────

const contentProfileSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['videos'],
    properties: {
        videos: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['ref', 'topic', 'format', 'hookType'],
                properties: {
                    ref: { type: 'string' },
                    topic: str('2 to 5 words: what the video is about.'),
                    format: { type: 'string', enum: CONTENT_FORMATS },
                    hookType: { type: 'string', enum: HOOK_TYPES },
                },
            },
        },
    },
};

/**
 * Tag topic / format / hook type for videos that don't have it yet (one batched call), and cache it.
 * Mutates `videos` in place. Never throws: the strategy still works without tags.
 */
export const ensureContentProfiles = async (videos, { complete = requestStructuredCompletion } = {}) => {
    const todo = videos.filter((v) => !v.contentProfile?.topic);
    if (!todo.length) return 0;
    try {
        const lines = todo.map((v, i) => `P${i + 1} | "${videoTitle(v).slice(0, 60)}" | opening: "${hookLineOf(v) ?? 'none'}" | ${Math.round(v.duration ?? 0)}s`);
        const result = await withAiContext({ feature: 'analytics_content_profile' }, () => complete({
            messages: [{ role: 'user', content: `Tag each short-form video. Use only what the title and opening tell you.\n\n${lines.join('\n')}` }],
            schemaName: 'content_profiles',
            jsonSchema: contentProfileSchema,
            systemPrompt: 'You classify short-form videos. Return structured data only.',
            role: 'classifier',
            temperature: 0,
            maxTokens: 2500,
        }));
        const now = new Date();
        const ops = [];
        for (const tag of result?.videos ?? []) {
            const v = todo[Number(String(tag.ref).replace(/\D/g, '')) - 1];
            if (!v) continue;
            v.contentProfile = { topic: clean(tag.topic, 60), format: tag.format, hookType: tag.hookType, profiledAt: now };
            ops.push({ updateOne: { filter: { _id: v._id }, update: { $set: { contentProfile: v.contentProfile } } } });
        }
        if (ops.length) await Video.bulkWrite(ops, { ordered: false });
        return ops.length;
    } catch (error) {
        console.warn(`[Strategy] Content profiling skipped: ${error.message}`);
        return 0;
    }
};

// ─── Generation ─────────────────────────────────────────────────────────────

const STRATEGY_FIELDS = {
    _id: 1, filename: 1, sourceTitle: 1, createdAt: 1, duration: 1, viralityScore: 1, analysis: 1, predictedViewsLow: 1,
    predictedViewsExpected: 1, predictedViewsHigh: 1, viewPredictionMethod: 1, creatorFollowers: 1, creatorPlatform: 1,
    postedAt: 1, performanceSnapshots: 1, actualViews: 1, actualViewsReportedAt: 1, contentProfile: 1,
    rawTranscript: { $slice: 4 }, scenes: { $slice: 1 },
};

export const loadStrategyVideos = (userId) => Video.find({ uploader_id: userId, analysisStatus: ANALYSIS_STATUS.COMPLETED, viralityScore: { $ne: null } })
    .select(STRATEGY_FIELDS)
    .sort({ createdAt: -1 })
    .limit(MAX_VIDEOS_IN_PROMPT)
    .lean();

const SYSTEM_PROMPT = [
    'You are a short-form content strategist for one specific creator. You plan what they post next, based on their own videos and real results. You return structured data only.',
    'Ground every claim in the creator data you are given. Cite videos by their refs (V1, V2...). If the data is thin, say what to test instead of pretending to know.',
    'Never promise results. No "guaranteed", no "this will go viral". Talk about what is most likely to work for them and how they will know.',
    VOICE_RULES,
].join('\n\n');

const describeDrivers = (drivers) => (drivers?.length
    ? drivers.map((d) => `${d.metric}: rank correlation with views ${d.rho} (n=${d.n})`).join('; ')
    : 'Not enough real results yet to measure.');

const describeWindows = (w) => (w
    ? `Best day: ${w.bestDay ? `${w.bestDay.label} (median ${w.bestDay.medianViews} views, ${w.bestDay.posts} posts)` : 'unclear'}. Best time block: ${w.bestBlock ? `${w.bestBlock.startHour}:00-${w.bestBlock.startHour + 3}:00 (median ${w.bestBlock.medianViews})` : 'unclear'}. Based on ${w.posts} posts.`
    : 'Not enough posts with a post date and views yet.');

export const buildStrategyPrompt = ({ profile, overview, digest, plannedSlots, knowledge, confidence, milestone }) => `REFERENCE NOTES (your private playbook. Apply them; never mention them):
${knowledge}

CREATOR
Niche: ${profile.niche ?? 'unknown'}. Platforms: ${profile.platforms.join(', ') || 'unknown'}. Followers: ${profile.followers ?? 'unknown'}. Main goal: ${profile.goal ?? 'grow'}. Posts per week: ${profile.postsPerWeek ?? DEFAULT_POSTS_PER_WEEK}.

THEIR NUMBERS
Videos analyzed: ${overview.totals.videos}. With real view counts: ${overview.totals.withResults}.
Average score: ${overview.kpis.avgScore ?? 'n/a'}. Check averages: ${overview.checkTrends.map((t) => `${t.check} ${t.average ?? '-'}${t.delta != null ? ` (trend ${t.delta > 0 ? '+' : ''}${t.delta})` : ''}`).join(', ')}.
Prediction vs real: ${overview.accuracy.total ? `${overview.accuracy.beat} beat, ${overview.accuracy.within} within, ${overview.accuracy.under} under the predicted range; median actual/expected ${overview.accuracy.medianRatio}` : 'no results yet'}.
What moves their views: ${describeDrivers(overview.drivers)}
Posting times: ${describeWindows(overview.postingWindows)}
Next milestone (already set, do not change it): ${milestone.basis}
Confidence in this plan: ${confidence}${confidence === 'low' ? ' (few real results: lean on their scores and the reference notes, and make the experiments about learning what works)' : ''}.

THEIR VIDEOS (newest first)
${digest}

SLOTS TO FILL (dates, times and platforms are fixed)
${plannedSlots.map((s) => `${s.id}: ${WEEKDAY_NAMES[s.weekday]} ${s.date} ${s.timeLocal} on ${s.platform}`).join('\n')}

TASK
1. diagnosis: a headline plus 2-3 strengths and 2-3 weaknesses. Each cites the number that shows it and the video refs behind it.
2. pillars: 3 or 4 content pillars for this niche, built from what already works for them (cite refs). targetShare sums to 100.
3. formula: their winning formula. Hook patterns with a fill-in example for their niche, ideal length in seconds, and concrete pacing, on-screen text and closing rules. "avoid" lists what their weakest videos have in common.
4. slots: fill every slot above exactly once, keeping its id. Each slot uses exactly one of your pillar names; spread pillars by their targetShare and use every pillar. Each is a specific video they can film this week in their niche, with the exact hook line, 3-6 beats, length in seconds, exact closing line and a one-sentence rationale.
5. experiments: 2 or 3 tests, each naming which slots to use and which number from their own results decides it.`;

/**
 * Generate a strategy (no persistence). Throws when the model can't produce a valid plan.
 * `deps` lets tests stub the model and retrieval.
 */
export const generateStrategy = async ({ userId, profile, videos, allVideos = videos, deps = {} }) => {
    const complete = deps.complete ?? requestStructuredCompletion;
    const retrieve = deps.retrieve ?? retrieveKnowledge;
    const now = deps.now ?? Date.now();
    const timeZone = profile.timezone || 'UTC';

    await ensureContentProfiles(videos, { complete });
    // Aggregates use every ready video; the prompt lists only the newest MAX_VIDEOS_IN_PROMPT.
    const overview = buildOverview(allVideos, { range: 'all', now, timeZone });
    const confidence = confidenceFor(overview.totals.withResults);
    const milestone = computeMilestone(allVideos);
    const plannedSlots = planSlots({
        postsPerWeek: profile.postsPerWeek,
        preferredDays: profile.preferredDays,
        platforms: profile.platforms,
        timeZone,
        bestStartHour: overview.postingWindows?.bestBlock?.startHour ?? null,
        now,
    });
    const { refMap, text: digest } = buildVideoDigest(videos, timeZone);

    const subject = `${profile.niche ?? ''} short-form content on ${profile.platforms.join(' ')} to ${profile.goal ?? 'grow'}`;
    const [growthDocs, hookDocs] = await Promise.all([
        retrieve({ query: `Content strategy, posting cadence and what the algorithm rewards: ${subject}`, topics: ['general', 'views_predictor', 'advanced_analytics'], limit: 8 }),
        retrieve({ query: `Hooks and formats that work for ${subject}`, topics: ['hook', 'pacing'], limit: 6 }),
    ]);
    const seen = new Set();
    const knowledge = formatKnowledgeContext([...growthDocs, ...hookDocs].filter((d) => {
        const key = String(d?._id ?? d?.content);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }));

    const prompt = buildStrategyPrompt({ profile, overview, digest, plannedSlots, knowledge, confidence, milestone });
    const request = (messages) => complete({
        messages,
        schemaName: 'content_strategy',
        jsonSchema: strategyJsonSchema,
        systemPrompt: SYSTEM_PROMPT,
        role: 'writer',
        temperature: 0.6,
        maxTokens: 9000,
    });
    const refs = [...refMap.keys()];
    const slotIds = plannedSlots.map((s) => s.id);

    const attempt = async (n, messages) => withAiContext({ attempt: n }, async () => {
        const payload = await request(messages);
        const issues = validateStrategyPayload(payload, { refs, slotIds });
        markGenerationValidation(lastGenerationId(), { passed: issues.length === 0, issues });
        return { payload, issues };
    });

    return withAiContext({ feature: 'analytics_strategy', userId, distinctId: userId }, async () => {
        const messages = [{ role: 'user', content: prompt }];
        let { payload, issues } = await attempt(1, messages);
        if (issues.length) {
            ({ payload, issues } = await attempt(2, [
                ...messages,
                { role: 'assistant', content: JSON.stringify(payload) },
                { role: 'user', content: `Fix these problems and return the full plan again:\n- ${issues.join('\n- ')}` },
            ]));
        }
        if (issues.length) {
            const error = new Error(`Strategy failed validation: ${issues.slice(0, 3).join(' | ')}`);
            error.issues = issues;
            throw error;
        }
        const avg = overview.kpis.avgScore;
        const { slots, ...rest } = normalizeStrategy(payload, { refMap, plannedSlots });
        return {
            ...rest,
            confidence,
            nextMilestone: milestone,
            schedule: { startDate: plannedSlots[0]?.date ?? null, endDate: plannedSlots[plannedSlots.length - 1]?.date ?? null, timezone: timeZone, slots },
            inputSummary: {
                videos: overview.totals.videos,
                withResults: overview.totals.withResults,
                avgScore: avg,
                medianViews: milestone.metric === 'median_views' ? milestone.current : null,
                profile: { niche: profile.niche, platforms: profile.platforms, goal: profile.goal, postsPerWeek: profile.postsPerWeek },
            },
        };
    });
};
