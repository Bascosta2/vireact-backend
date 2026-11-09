import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    spearman,
    outcomeFor,
    latestViews,
    scoreSeries,
    checkTrends,
    predictionAccuracy,
    predictionRows,
    drivers,
    postingWindows,
    needsResults,
    buildOverview,
    buildVideoRows,
    localParts,
    weeklyStreak,
} from '../src/service/analytics.service.js';
import { normalizeSnapshotInput, normalizePostUrl, normalizePastDate, latestSnapshot } from '../src/service/performance.service.js';
import { resolveCreatorProfile, normalizeCreatorProfileInput } from '../src/service/creator-profile.service.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 8, 12); // Sun 8 Nov 2026 12:00 UTC

let seq = 0;
const video = (overrides = {}) => {
    seq += 1;
    const { daysAgo = 1, checks = {}, ...rest } = overrides;
    return {
        _id: `v${seq}`,
        filename: `clip-${seq}.mp4`,
        createdAt: new Date(NOW - daysAgo * DAY),
        viralityScore: 50,
        analysis: Object.entries({ hook: 50, pacing: 50, audio: 50, caption: 50, ...checks }).map(([feature, score]) => ({ feature, score })),
        predictedViewsLow: 20,
        predictedViewsExpected: 100,
        predictedViewsHigh: 400,
        viewPredictionMethod: 'score',
        performanceSnapshots: [],
        actualViews: null,
        postedAt: null,
        ...rest,
    };
};
const withViews = (views, extra = {}) => ({ performanceSnapshots: [{ capturedAt: new Date(NOW - DAY), views }], ...extra });

test('spearman: perfect, inverse, ties and degenerate inputs', () => {
    assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
    assert.equal(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
    assert.equal(spearman([1, 1, 1], [1, 2, 3]), null); // no variance
    assert.equal(spearman([1, 2], [1, 2]), null); // too few
    const tied = spearman([1, 2, 2, 3], [1, 2, 3, 4]);
    assert.ok(tied > 0.9 && tied < 1);
});

test('outcomeFor buckets against the band', () => {
    const band = { low: 20, high: 400 };
    assert.equal(outcomeFor(500, band), 'beat');
    assert.equal(outcomeFor(100, band), 'within');
    assert.equal(outcomeFor(5, band), 'under');
    assert.equal(outcomeFor(null, band), null);
    assert.equal(outcomeFor(100, { low: null, high: null }), null);
});

test('latestViews prefers the newest snapshot, falls back to legacy actualViews', () => {
    const v = video({
        actualViews: 999,
        performanceSnapshots: [
            { capturedAt: new Date(NOW - 2 * DAY), views: 300 },
            { capturedAt: new Date(NOW - 5 * DAY), views: 100 },
        ],
    });
    assert.equal(latestViews(v), 300);
    assert.equal(latestViews(video({ actualViews: 42 })), 42);
    assert.equal(latestViews(video()), null);
});

test('scoreSeries rolling average uses the last 5 videos', () => {
    const vids = [10, 20, 30, 40, 50, 60].map((s, i) => video({ viralityScore: s, daysAgo: 10 - i }));
    const series = scoreSeries(vids);
    assert.equal(series[0].rollingAvg, 10);
    assert.equal(series[4].rollingAvg, 30);
    assert.equal(series[5].rollingAvg, 40); // (20..60)/5
});

test('checkTrends: delta compares the second half of the range to the first', () => {
    const vids = [40, 40, 60, 60].map((hook, i) => video({ checks: { hook }, daysAgo: 10 - i }));
    const hook = checkTrends(vids).find((t) => t.check === 'hook');
    assert.equal(hook.delta, 20);
    assert.equal(hook.average, 50);
    const few = checkTrends(vids.slice(0, 3)).find((t) => t.check === 'hook');
    assert.equal(few.delta, null);
});

test('predictionAccuracy counts outcomes and the median actual/expected ratio', () => {
    const rows = predictionRows([
        video(withViews(1000)), // beat (> 400)
        video(withViews(100)), // within
        video(withViews(5)), // under
        video(), // no result: ignored
    ]);
    assert.equal(rows.length, 3);
    const acc = predictionAccuracy(rows);
    assert.deepEqual({ total: acc.total, beat: acc.beat, within: acc.within, under: acc.under }, { total: 3, beat: 1, within: 1, under: 1 });
    assert.equal(acc.withinRate, 0.33);
    assert.equal(acc.medianRatio, 1);
});

test('drivers is null until 5 results, then ranks the checks that move with views', () => {
    const four = [1, 2, 3, 4].map((i) => video({ viralityScore: i * 10, ...withViews(i * 100) }));
    assert.equal(drivers(four), null);
    const vids = [1, 2, 3, 4, 5, 6].map((i) => video({
        viralityScore: 50,
        checks: { hook: i * 10, pacing: 70 - i * 10 },
        ...withViews(i * 100),
    }));
    const result = drivers(vids);
    const hook = result.find((d) => d.metric === 'hook');
    const pacing = result.find((d) => d.metric === 'pacing');
    assert.equal(hook.rho, 1);
    assert.equal(pacing.rho, -1);
    assert.equal(result.find((d) => d.metric === 'virality'), undefined); // constant score: undefined correlation
});

test('localParts converts to the creator time zone', () => {
    const date = new Date(Date.UTC(2026, 10, 9, 2)); // Mon 02:00 UTC = Sun 21:00 in New York (EST)
    assert.deepEqual(localParts(date, 'UTC'), { weekday: 1, hour: 2 });
    assert.deepEqual(localParts(date, 'America/New_York'), { weekday: 0, hour: 21 });
});

test('postingWindows needs 6 posted results and a best slot needs 2 posts', () => {
    const at = (day, hour) => new Date(Date.UTC(2026, 10, day, hour));
    const five = [2, 3, 4, 5, 6].map((d) => video({ postedAt: at(d, 18), ...withViews(100) }));
    assert.equal(postingWindows(five), null);
    const vids = [
        video({ postedAt: at(2, 18), ...withViews(1000) }), // Mon 18
        video({ postedAt: at(9, 19), ...withViews(3000) }), // Mon 19
        video({ postedAt: at(3, 9), ...withViews(100) }), // Tue 09
        video({ postedAt: at(10, 10), ...withViews(200) }), // Tue 10
        video({ postedAt: at(4, 1), ...withViews(50000) }), // Wed 01: one lucky post
        video({ postedAt: at(5, 9), ...withViews(150) }), // Thu 09
    ];
    const windows = postingWindows(vids, 'UTC');
    assert.equal(windows.posts, 6);
    assert.equal(windows.bestDay.label, 'Monday');
    assert.equal(windows.bestDay.medianViews, 2000);
    assert.equal(windows.bestBlock.startHour, 18);
});

test('needsResults: posted or older than 3 days, no result, within 90 days', () => {
    const vids = [
        video({ daysAgo: 1 }), // too fresh, not posted
        video({ daysAgo: 1, postedAt: new Date(NOW - DAY) }), // posted
        video({ daysAgo: 5 }), // old enough
        video({ daysAgo: 5, ...withViews(10) }), // has result
        video({ daysAgo: 200 }), // too old
    ];
    const list = needsResults(vids, NOW);
    assert.deepEqual(list.map((v) => v.videoId), [vids[1]._id, vids[2]._id]);
});

test('weeklyStreak counts consecutive weeks with an analysis', () => {
    const vids = [0, 7, 14, 28].map((d) => video({ daysAgo: d }));
    assert.equal(weeklyStreak(vids, NOW), 3);
    assert.equal(weeklyStreak([], NOW), 0);
});

test('buildOverview splits current vs previous period and keeps rolling history', () => {
    const vids = [
        video({ daysAgo: 45, viralityScore: 30 }),
        video({ daysAgo: 40, viralityScore: 40 }),
        video({ daysAgo: 10, viralityScore: 60, postedAt: new Date(NOW - 9 * DAY), ...withViews(500) }),
        video({ daysAgo: 5, viralityScore: 70 }),
        video({ daysAgo: 2, viralityScore: null }), // not ready
    ];
    const o = buildOverview(vids, { range: '30d', now: NOW });
    assert.equal(o.kpis.videosAnalyzed, 2);
    assert.equal(o.kpis.avgScore, 65);
    assert.equal(o.kpis.prevAvgScore, 35);
    assert.equal(o.kpis.scoreDelta, 30);
    assert.equal(o.kpis.viewsLogged, 500);
    assert.equal(o.scoreSeries.length, 2);
    assert.equal(o.scoreSeries[0].rollingAvg, 43.3); // (30 + 40 + 60) / 3: history before the range counts
    assert.equal(o.totals.videos, 4);
    const all = buildOverview(vids, { range: 'all', now: NOW });
    assert.equal(all.kpis.videosAnalyzed, 4);
    assert.equal(all.kpis.scoreDelta, null);
    assert.equal(buildOverview([], { now: NOW }).kpis.avgScore, null);
});

test('buildVideoRows: newest first with predicted band and outcome', () => {
    const rows = buildVideoRows([video({ daysAgo: 3, ...withViews(1000) }), video({ daysAgo: 1 })]);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].outcome, 'beat');
    assert.equal(rows[0].latestViews, null);
    assert.ok(rows[0].predicted.high >= rows[0].predicted.low);
});

test('snapshot input validation', () => {
    const now = NOW;
    const snap = normalizeSnapshotInput({ views: '1,840', likes: '12' }, now);
    assert.equal(snap.views, 1840);
    assert.equal(snap.likes, 12);
    assert.equal(snap.capturedAt.getTime(), now);
    assert.throws(() => normalizeSnapshotInput({ views: 'abc' }, now), /whole number/);
    assert.throws(() => normalizeSnapshotInput({ views: 5, shares: -1 }, now), /shares/);
    assert.throws(() => normalizeSnapshotInput({ views: 5, capturedAt: new Date(now + 2 * DAY) }, now), /date/);
});

test('post URL and date validation', () => {
    assert.equal(normalizePostUrl('https://www.tiktok.com/@me/video/1'), 'https://www.tiktok.com/@me/video/1');
    assert.equal(normalizePostUrl(''), null);
    assert.equal(normalizePostUrl('javascript:alert(1)'), undefined);
    assert.equal(normalizePostUrl('not a url'), undefined);
    assert.equal(normalizePastDate('2026-11-01', NOW).toISOString().slice(0, 10), '2026-11-01');
    assert.equal(normalizePastDate('2030-01-01', NOW), undefined);
    assert.equal(normalizePastDate(null, NOW), null);
});

test('latestSnapshot picks by capturedAt, not array order', () => {
    const s = latestSnapshot([{ capturedAt: new Date(3), views: 3 }, { capturedAt: new Date(1), views: 1 }]);
    assert.equal(s.views, 3);
    assert.equal(latestSnapshot([]), null);
});

test('creator profile: quiz fallback, then saved profile wins', () => {
    const quizUser = { onboarding: { answers: { platform: 'all', niche: 'fitness_health', followers: '1k_10k', cadence: '2_4', problem: 'views_plateau' } } };
    const fromQuiz = resolveCreatorProfile(quizUser);
    assert.equal(fromQuiz.source, 'quiz');
    assert.deepEqual(fromQuiz.platforms, ['tiktok', 'instagram', 'youtube']);
    assert.equal(fromQuiz.followers, 5000);
    assert.equal(fromQuiz.postsPerWeek, 3);
    assert.equal(fromQuiz.goal, 'more_views');
    assert.equal(fromQuiz.complete, true);

    assert.equal(resolveCreatorProfile({}).source, 'empty');
    assert.equal(resolveCreatorProfile({}).complete, false);

    const saved = normalizeCreatorProfileInput({ niche: 'tech', platforms: ['youtube'], goal: 'monetize', postsPerWeek: 5, preferredDays: [5, 1, 1], timezone: 'Europe/London' });
    assert.deepEqual(saved.preferredDays, [1, 5]);
    const profile = resolveCreatorProfile({ ...quizUser, creatorProfile: saved });
    assert.equal(profile.source, 'saved');
    assert.equal(profile.niche, 'tech');
    assert.equal(profile.timezone, 'Europe/London');
});

test('creator profile validation rejects bad input', () => {
    const ok = { niche: 'tech', platforms: ['tiktok'], goal: 'more_views', postsPerWeek: 3 };
    assert.equal(normalizeCreatorProfileInput(ok).timezone, 'UTC');
    assert.throws(() => normalizeCreatorProfileInput({ ...ok, niche: 'cats' }), /niche/);
    assert.throws(() => normalizeCreatorProfileInput({ ...ok, platforms: ['myspace'] }), /platform/);
    assert.throws(() => normalizeCreatorProfileInput({ ...ok, postsPerWeek: 50 }), /Posts per week/);
    assert.throws(() => normalizeCreatorProfileInput({ ...ok, preferredDays: [7] }), /days/);
    assert.throws(() => normalizeCreatorProfileInput({ ...ok, timezone: 'Mars/Base' }), /time zone/);
    assert.throws(() => normalizeCreatorProfileInput({ ...ok, followers: 'lots' }), /follower/);
});
