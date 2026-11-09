import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    planSlots,
    confidenceFor,
    computeMilestone,
    validateStrategyPayload,
    normalizeStrategy,
    buildVideoDigest,
    generateStrategy,
    localDay,
} from '../src/service/content-strategy.service.js';

const NOW = Date.UTC(2026, 10, 8, 12); // Sun 8 Nov 2026
const DAY = 86_400_000;

const video = (i, extra = {}) => ({
    _id: `65f0000000000000000000${String(i).padStart(2, '0')}`,
    filename: `clip-${i}.mp4`,
    createdAt: new Date(NOW - i * DAY),
    viralityScore: 40 + i,
    duration: 20,
    analysis: [{ feature: 'hook', score: 30 + i, feedback: 'Nothing happens in the first 2 seconds.' }, { feature: 'pacing', score: 60 }],
    predictedViewsLow: 20,
    predictedViewsExpected: 100,
    predictedViewsHigh: 400,
    viewPredictionMethod: 'score',
    performanceSnapshots: [],
    contentProfile: { topic: 'home workouts', format: 'tutorial', hookType: 'question' },
    rawTranscript: [{ text: 'Three moves you can do without a gym', tStart: 0, tEnd: 2 }],
    ...extra,
});

test('confidence tracks how many real results exist', () => {
    assert.equal(confidenceFor(0), 'low');
    assert.equal(confidenceFor(3), 'medium');
    assert.equal(confidenceFor(8), 'high');
});

test('planSlots: postsPerWeek per week, on preferred days, starting tomorrow', () => {
    const slots = planSlots({ postsPerWeek: 3, preferredDays: [1, 3, 5], platforms: ['tiktok', 'instagram'], timeZone: 'UTC', now: NOW });
    assert.equal(slots.length, 6);
    assert.deepEqual([...new Set(slots.map((s) => s.weekday))].sort(), [1, 3, 5]);
    assert.equal(slots[0].date, '2026-11-09'); // Monday after Sunday NOW
    assert.deepEqual(slots.map((s) => s.id), ['s1', 's2', 's3', 's4', 's5', 's6']);
    assert.deepEqual(slots.slice(0, 2).map((s) => s.platform), ['tiktok', 'instagram']);
    assert.ok(slots.every((s) => s.timeLocal === '18:00'));
});

test('planSlots: more posts than days stacks up to 3 a day, then widens to every day', () => {
    const stacked = planSlots({ postsPerWeek: 4, preferredDays: [2, 4], timeZone: 'UTC', now: NOW });
    assert.equal(stacked.length, 8);
    const perDay = stacked.reduce((m, s) => m.set(s.date, (m.get(s.date) ?? 0) + 1), new Map());
    assert.ok([...perDay.values()].every((n) => n === 2));
    const widened = planSlots({ postsPerWeek: 10, preferredDays: [2, 4], timeZone: 'UTC', now: NOW });
    assert.equal(widened.length, 20);
    assert.ok(new Set(widened.map((s) => s.weekday)).size > 2);
});

test('planSlots: uses the best posting block and the creator time zone', () => {
    const slots = planSlots({ postsPerWeek: 1, timeZone: 'Asia/Tokyo', bestStartHour: 9, now: Date.UTC(2026, 10, 8, 20) }); // already Mon 9 Nov 05:00 in Tokyo
    assert.equal(slots.length, 2);
    assert.equal(slots[0].timeLocal, '10:00');
    assert.ok(slots[0].date >= '2026-11-10');
    assert.equal(localDay(Date.UTC(2026, 10, 8, 20), 'Asia/Tokyo').date, '2026-11-09');
});

test('milestone: asks for results first, then targets ~30% over their own median', () => {
    assert.equal(computeMilestone([video(1)]).metric, 'results_logged');
    const withViews = [100, 200, 300].map((views, i) => video(i + 1, { performanceSnapshots: [{ capturedAt: new Date(NOW), views }] }));
    const m = computeMilestone(withViews);
    assert.equal(m.metric, 'median_views');
    assert.equal(m.current, 200);
    assert.equal(m.target, 260);
});

const goodPayload = () => ({
    diagnosis: {
        headline: 'Your openings lose people before the first cut.',
        strengths: [{ point: 'Pacing holds once it starts.', metric: 'pacing 60', evidence: ['V1'] }],
        weaknesses: [{ point: 'Hooks are slow.', metric: 'hook 31', evidence: ['V1', 'V2'] }],
    },
    pillars: [
        { name: 'No-gym moves', why: 'V1 beat its range.', targetShare: 60, evidence: ['V1'] },
        { name: 'Form fixes', why: 'Most saves.', targetShare: 60, evidence: ['V2'] },
    ],
    formula: { hookPatterns: ['Stop doing X'], idealLengthSec: 400, pacing: 'Cut every 2s', captionStyle: 'Big text', ctaStyle: 'Ask a question', avoid: ['Slow intros'] },
    slots: [
        { id: 's1', pillar: 'No-gym moves', title: 'Three moves', concept: 'c', hook: 'h', beats: ['a', 'b', 'c'], lengthSec: 25, cta: 'x', rationale: 'r' },
        { id: 's2', pillar: 'Form fixes', title: 'Squat fix', concept: 'c', hook: 'h', beats: ['a'], lengthSec: 30, cta: 'x', rationale: 'r' },
    ],
    experiments: [{ hypothesis: 'h', howToTest: 't', successMetric: 'm' }],
});

test('validator accepts a grounded plan', () => {
    assert.deepEqual(validateStrategyPayload(goodPayload(), { refs: ['V1', 'V2'], slotIds: ['s1', 's2'] }), []);
});

test('validator catches missing slots, unknown pillars, made-up refs, unused pillars and promises', () => {
    const p = goodPayload();
    p.slots = [{ ...p.slots[0], id: 's1', pillar: 'Mystery' }, { ...p.slots[1], id: 's9' }];
    p.diagnosis.weaknesses[0].evidence = ['V7'];
    p.diagnosis.headline = 'This plan is guaranteed to work.';
    const issues = validateStrategyPayload(p, { refs: ['V1', 'V2'], slotIds: ['s1', 's2'] }).join('\n');
    assert.match(issues, /Missing: s2/);
    assert.match(issues, /Unknown: s9/);
    assert.match(issues, /"Mystery"/);
    assert.match(issues, /V7/);
    assert.match(issues, /No-gym moves" is never scheduled/);
    assert.match(issues, /guaranteed/);
    const viral = goodPayload();
    viral.slots[0].rationale = 'This will go viral.';
    assert.match(validateStrategyPayload(viral, { refs: ['V1', 'V2'], slotIds: ['s1', 's2'] }).join(), /go viral/);
    const goal = goodPayload();
    goal.diagnosis.headline = 'Your goal is to go viral more often.';
    assert.deepEqual(validateStrategyPayload(goal, { refs: ['V1', 'V2'], slotIds: ['s1', 's2'] }), []);
});

test('normalizeStrategy maps refs to ids, rebalances shares, keeps fixed slot times', () => {
    const refMap = new Map([['V1', '65f000000000000000000001'], ['V2', '65f000000000000000000002']]);
    const plannedSlots = [
        { id: 's1', date: '2026-11-09', weekday: 1, timeLocal: '18:00', platform: 'tiktok' },
        { id: 's2', date: '2026-11-11', weekday: 3, timeLocal: '18:00', platform: 'instagram' },
    ];
    const out = normalizeStrategy(goodPayload(), { refMap, plannedSlots });
    assert.deepEqual(out.pillars.map((p) => p.targetShare), [50, 50]);
    assert.equal(String(out.pillars[0].evidenceVideoIds[0]), '65f000000000000000000001');
    assert.equal(out.formula.idealLengthSec, 180);
    assert.equal(out.slots[1].platform, 'instagram');
    assert.equal(out.slots[1].date, '2026-11-11');
    assert.equal(out.slots[0].status, 'planned');
});

test('digest gives newest-first refs with scores, opening line and real results', () => {
    const { refMap, text } = buildVideoDigest([video(1, { performanceSnapshots: [{ capturedAt: new Date(NOW), views: 900 }] }), video(2)]);
    assert.equal(refMap.get('V1'), video(1)._id);
    assert.match(text, /V1 .*score 41 .*hook 31/);
    assert.match(text, /opening: "Three moves/);
    assert.match(text, /ACTUAL 900 views \(beat\)/);
    assert.match(text, /topic: home workouts/);
});

test('generateStrategy: retries once with the problems, then returns a stored-shape plan', async () => {
    const videos = [video(1), video(2)];
    const calls = [];
    const bad = { ...goodPayload(), slots: goodPayload().slots.slice(0, 1) };
    const complete = async (args) => {
        calls.push(args);
        return calls.length === 1 ? bad : goodPayload();
    };
    const plan = await generateStrategy({
        userId: 'u1',
        profile: { niche: 'fitness_health', platforms: ['tiktok'], postsPerWeek: 1, preferredDays: [], goal: 'grow_followers', timezone: 'UTC' },
        videos,
        deps: { complete, retrieve: async () => [], now: NOW },
    });
    assert.equal(calls.length, 2);
    assert.match(calls[1].messages.at(-1).content, /Missing: s2/);
    assert.equal(calls[0].role, 'writer');
    assert.equal(plan.schedule.slots.length, 2);
    assert.equal(plan.confidence, 'low');
    assert.equal(plan.nextMilestone.metric, 'results_logged');
    assert.equal(plan.inputSummary.videos, 2);
});

test('generateStrategy fails cleanly when the retry is still invalid', async () => {
    const bad = { ...goodPayload(), slots: [] };
    await assert.rejects(
        generateStrategy({
            userId: 'u1',
            profile: { niche: 'tech', platforms: ['youtube'], postsPerWeek: 1, preferredDays: [], timezone: 'UTC' },
            videos: [video(1), video(2)],
            deps: { complete: async () => bad, retrieve: async () => [], now: NOW },
        }),
        /failed validation/
    );
});
