/**
 * Analytics tab: progress across a creator's videos. Everything here is deterministic (no AI) and
 * pure over lean Video docs, so it is cheap to run on every page load and easy to test.
 */
import { Video } from '../model/video.model.js';
import { ANALYSIS_STATUS } from '../constants.js';
import { displayViewBand, percentile } from './view-prediction.service.js';
import { latestSnapshot } from './performance.service.js';

export const CHECKS = Object.freeze(['hook', 'pacing', 'audio', 'caption']);
export const RANGES = Object.freeze({ '30d': 30, '90d': 90, all: null });
export const ROLLING_WINDOW = 5;
export const MIN_RESULTS_FOR_DRIVERS = 5;
export const MIN_RESULTS_FOR_WINDOWS = 6;
const NEEDS_RESULTS_AFTER_DAYS = 3;
const NEEDS_RESULTS_LOOKBACK_DAYS = 90;
const MAX_VIDEOS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const ANALYTICS_VIDEO_FIELDS = [
    '_id', 'filename', 'sourceTitle', 'thumbnailUrl', 'createdAt', 'duration', 'viralityScore', 'analysis.feature',
    'analysis.score', 'predictedViewsLow', 'predictedViewsExpected', 'predictedViewsHigh', 'viewPredictionMethod',
    'creatorFollowers', 'creatorPlatform', 'postedAt', 'postUrl', 'performanceSnapshots', 'actualViews',
    'actualViewsReportedAt',
].join(' ');

const round = (n, digits = 0) => (Number.isFinite(n) ? Number(n.toFixed(digits)) : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => percentile([...xs].sort((a, b) => a - b), 0.5);
const time = (d) => (d ? new Date(d).getTime() : NaN);

export const videoTitle = (v) => v.sourceTitle || v.filename || 'Untitled video';

export const checkScores = (v) => {
    const out = {};
    for (const check of CHECKS) {
        const entry = (v.analysis ?? []).find((a) => a.feature === check);
        out[check] = Number.isFinite(entry?.score) ? entry.score : null;
    }
    return out;
};

/** Latest logged views (snapshots first, legacy actualViews as fallback). */
export const latestViews = (v) => {
    const snap = latestSnapshot(v.performanceSnapshots ?? []);
    if (snap) return snap.views;
    return Number.isFinite(v.actualViews) ? v.actualViews : null;
};

/** 'beat' above the predicted high, 'under' below the low, else 'within'. null without a result or band. */
export const outcomeFor = (actual, band) => {
    if (!Number.isFinite(actual) || !band || !Number.isFinite(band.low) || !Number.isFinite(band.high)) return null;
    if (actual > band.high) return 'beat';
    if (actual < band.low) return 'under';
    return 'within';
};

/** When the creator posted it, falling back to when it was analyzed. */
const anchorDate = (v) => v.postedAt ?? v.createdAt;

/** Average ranks (ties share the mean rank). */
const ranks = (xs) => {
    const order = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(xs.length);
    for (let i = 0; i < order.length;) {
        let j = i;
        while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
        const r = (i + j) / 2 + 1;
        for (let k = i; k <= j; k += 1) out[order[k][1]] = r;
        i = j + 1;
    }
    return out;
};

/** Spearman rank correlation, or null when undefined (fewer than 3 points or no variance). */
export const spearman = (xs, ys) => {
    if (xs.length !== ys.length || xs.length < 3) return null;
    const rx = ranks(xs);
    const ry = ranks(ys);
    const mx = mean(rx);
    const my = mean(ry);
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < rx.length; i += 1) {
        num += (rx[i] - mx) * (ry[i] - my);
        dx += (rx[i] - mx) ** 2;
        dy += (ry[i] - my) ** 2;
    }
    if (dx === 0 || dy === 0) return null;
    return num / Math.sqrt(dx * dy);
};

/** Weekday (0 = Sunday) and hour of a date in a time zone. */
export const localParts = (date, timeZone = 'UTC') => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' })
        .formatToParts(new Date(date));
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')?.value);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value) % 24;
    return { weekday, hour };
};

/** Monday 00:00 UTC of the week containing `date`, as YYYY-MM-DD. */
const weekStart = (date) => {
    const d = new Date(date);
    const day = (d.getUTCDay() + 6) % 7;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
};

/** Ready videos only, oldest first. */
const readyChronological = (videos) => videos
    .filter((v) => Number.isFinite(v.viralityScore))
    .sort((a, b) => time(a.createdAt) - time(b.createdAt));

export const scoreSeries = (chronological) => chronological.map((v, i) => {
    const window = chronological.slice(Math.max(0, i - ROLLING_WINDOW + 1), i + 1).map((w) => w.viralityScore);
    return { videoId: String(v._id), title: videoTitle(v), date: v.createdAt, score: v.viralityScore, rollingAvg: round(mean(window), 1) };
});

export const checkSeries = (chronological) => {
    const weeks = new Map();
    for (const v of chronological) {
        const key = weekStart(v.createdAt);
        if (!weeks.has(key)) weeks.set(key, Object.fromEntries(CHECKS.map((c) => [c, []])));
        const scores = checkScores(v);
        for (const c of CHECKS) if (scores[c] != null) weeks.get(key)[c].push(scores[c]);
    }
    return [...weeks.entries()].map(([week, buckets]) => ({
        week,
        ...Object.fromEntries(CHECKS.map((c) => [c, round(mean(buckets[c]), 1)])),
    }));
};

/** Per check: latest average and the change from the first half of the range to the second. */
export const checkTrends = (chronological) => CHECKS.map((check) => {
    const values = chronological.map((v) => checkScores(v)[check]).filter((s) => s != null);
    const half = Math.floor(values.length / 2);
    const delta = values.length >= 4 ? mean(values.slice(half)) - mean(values.slice(0, half)) : null;
    return { check, average: round(mean(values), 1), delta: round(delta, 1), count: values.length };
});

export const predictionRows = (videos) => videos
    .map((v) => {
        const actual = latestViews(v);
        if (actual == null) return null;
        const band = displayViewBand(v);
        return {
            videoId: String(v._id),
            title: videoTitle(v),
            date: anchorDate(v),
            low: band.low ?? null,
            expected: band.expected ?? null,
            high: band.high ?? null,
            actual,
            outcome: outcomeFor(actual, band),
        };
    })
    .filter(Boolean)
    .sort((a, b) => time(a.date) - time(b.date));

export const predictionAccuracy = (rows) => {
    const scored = rows.filter((r) => r.outcome);
    const count = (o) => scored.filter((r) => r.outcome === o).length;
    const ratios = rows.filter((r) => r.expected > 0).map((r) => r.actual / r.expected);
    return {
        total: scored.length,
        beat: count('beat'),
        within: count('within'),
        under: count('under'),
        withinRate: scored.length ? round(count('within') / scored.length, 2) : null,
        medianRatio: ratios.length ? round(median(ratios), 2) : null,
    };
};

export const viewsSeries = (videos) => videos
    .map((v) => {
        const views = latestViews(v);
        if (views == null) return null;
        const posted = time(v.postedAt);
        const snapshots = [...(v.performanceSnapshots ?? [])]
            .sort((a, b) => time(a.capturedAt) - time(b.capturedAt))
            .map((s) => ({
                capturedAt: s.capturedAt,
                hoursSincePost: Number.isFinite(posted) ? round(Math.max(0, time(s.capturedAt) - posted) / 3_600_000, 1) : null,
                views: s.views,
            }));
        return { videoId: String(v._id), title: videoTitle(v), date: anchorDate(v), posted: Boolean(v.postedAt), views, score: v.viralityScore ?? null, snapshots };
    })
    .filter(Boolean)
    .sort((a, b) => time(a.date) - time(b.date));

/**
 * Which scores move with real views, from every video that has a result. Spearman on ranks, so it is
 * robust to one outlier hit. null until MIN_RESULTS_FOR_DRIVERS results exist.
 */
export const drivers = (videos) => {
    const withResults = videos.filter((v) => latestViews(v) != null && Number.isFinite(v.viralityScore));
    if (withResults.length < MIN_RESULTS_FOR_DRIVERS) return null;
    const views = withResults.map((v) => Math.log10(latestViews(v) + 1));
    const rows = [['virality', withResults.map((v) => v.viralityScore)]];
    for (const c of CHECKS) rows.push([c, withResults.map((v) => checkScores(v)[c])]);
    return rows
        .map(([metric, xs]) => {
            const pairs = xs.map((x, i) => [x, views[i]]).filter(([x]) => x != null);
            if (pairs.length < MIN_RESULTS_FOR_DRIVERS) return null;
            const rho = spearman(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
            return rho == null ? null : { metric, rho: round(rho, 2), n: pairs.length };
        })
        .filter(Boolean)
        .sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho));
};

/** Median views by weekday and 3-hour block of the post time, in the creator's time zone. */
export const postingWindows = (videos, timeZone = 'UTC') => {
    const posted = videos.filter((v) => v.postedAt && latestViews(v) != null);
    if (posted.length < MIN_RESULTS_FOR_WINDOWS) return null;
    const byDay = new Map();
    const byBlock = new Map();
    for (const v of posted) {
        const { weekday, hour } = localParts(v.postedAt, timeZone);
        const block = Math.floor(hour / 3) * 3;
        if (!byDay.has(weekday)) byDay.set(weekday, []);
        if (!byBlock.has(block)) byBlock.set(block, []);
        byDay.get(weekday).push(latestViews(v));
        byBlock.get(block).push(latestViews(v));
    }
    const days = [...byDay.entries()]
        .map(([day, views]) => ({ day, label: WEEKDAYS[day], medianViews: round(median(views)), posts: views.length }))
        .sort((a, b) => a.day - b.day);
    const blocks = [...byBlock.entries()]
        .map(([startHour, views]) => ({ startHour, medianViews: round(median(views)), posts: views.length }))
        .sort((a, b) => a.startHour - b.startHour);
    // A "best" slot needs at least two posts behind it, otherwise it's one lucky video.
    const best = (list) => list.filter((x) => x.posts >= 2).sort((a, b) => b.medianViews - a.medianViews)[0] ?? null;
    return { timeZone, days, blocks, bestDay: best(days), bestBlock: best(blocks), posts: posted.length };
};

export const needsResults = (videos, now = Date.now()) => videos
    .filter((v) => latestViews(v) == null && Number.isFinite(v.viralityScore))
    .filter((v) => time(v.createdAt) >= now - NEEDS_RESULTS_LOOKBACK_DAYS * DAY_MS)
    .filter((v) => v.postedAt || time(v.createdAt) <= now - NEEDS_RESULTS_AFTER_DAYS * DAY_MS)
    .sort((a, b) => time(b.createdAt) - time(a.createdAt))
    .slice(0, 10)
    .map((v) => ({ videoId: String(v._id), title: videoTitle(v), thumbnailUrl: v.thumbnailUrl ?? null, createdAt: v.createdAt, postedAt: v.postedAt ?? null, score: v.viralityScore }));

const inWindow = (date, from, to) => {
    const t = time(date);
    return Number.isFinite(t) && (from == null || t >= from) && t < to;
};

/** Consecutive weeks (ending this week or last) with at least one analysis. */
export const weeklyStreak = (chronological, now = Date.now()) => {
    const weeks = new Set(chronological.map((v) => weekStart(v.createdAt)));
    let cursor = new Date(`${weekStart(now)}T00:00:00Z`).getTime();
    if (!weeks.has(weekStart(cursor))) cursor -= 7 * DAY_MS; // this week not started yet is fine
    let streak = 0;
    while (weeks.has(weekStart(cursor))) {
        streak += 1;
        cursor -= 7 * DAY_MS;
    }
    return streak;
};

/** Everything the Overview tab needs, from one list of the creator's videos. */
export const buildOverview = (videos, { range = '30d', now = Date.now(), timeZone = 'UTC' } = {}) => {
    const days = RANGES[range] === undefined ? RANGES['30d'] : RANGES[range];
    const from = days == null ? null : now - days * DAY_MS;
    const prevFrom = days == null ? null : now - 2 * days * DAY_MS;
    const end = now + 1;

    const ready = readyChronological(videos);
    const current = ready.filter((v) => inWindow(v.createdAt, from, end));
    const previous = days == null ? [] : ready.filter((v) => inWindow(v.createdAt, prevFrom, from));

    const series = scoreSeries(ready); // rolling average uses history before the range too
    const currentIds = new Set(current.map((v) => String(v._id)));
    const resultsInRange = predictionRows(ready).filter((r) => inWindow(r.date, from, end));
    const postedInRange = ready.filter((v) => v.postedAt && inWindow(v.postedAt, from, end));
    const spanDays = days ?? Math.max(7, (now - time(ready[0]?.createdAt ?? now)) / DAY_MS);

    const avg = mean(current.map((v) => v.viralityScore));
    const prevAvg = mean(previous.map((v) => v.viralityScore));

    return {
        range: days == null ? 'all' : range,
        totals: { videos: ready.length, withResults: ready.filter((v) => latestViews(v) != null).length },
        kpis: {
            avgScore: round(avg, 1),
            prevAvgScore: round(prevAvg, 1),
            scoreDelta: avg != null && prevAvg != null ? round(avg - prevAvg, 1) : null,
            bestScore: current.length ? Math.max(...current.map((v) => v.viralityScore)) : null,
            videosAnalyzed: current.length,
            viewsLogged: resultsInRange.reduce((sum, r) => sum + r.actual, 0),
            resultsLogged: resultsInRange.length,
            postsPerWeek: round((postedInRange.length / spanDays) * 7, 1),
            weeklyStreak: weeklyStreak(ready, now),
        },
        scoreSeries: series.filter((p) => currentIds.has(p.videoId)),
        checkSeries: checkSeries(current),
        checkTrends: checkTrends(current),
        predictions: resultsInRange,
        accuracy: predictionAccuracy(predictionRows(ready)),
        viewsSeries: viewsSeries(ready).filter((r) => inWindow(r.date, from, end)),
        drivers: drivers(ready),
        postingWindows: postingWindows(ready, timeZone),
        needsResults: needsResults(ready, now),
    };
};

/** One row per ready video for the Videos tab, newest first. */
export const buildVideoRows = (videos) => readyChronological(videos).reverse().map((v) => {
    const band = displayViewBand(v);
    const views = latestViews(v);
    const snap = latestSnapshot(v.performanceSnapshots ?? []);
    return {
        videoId: String(v._id),
        title: videoTitle(v),
        thumbnailUrl: v.thumbnailUrl ?? null,
        createdAt: v.createdAt,
        score: v.viralityScore,
        checks: checkScores(v),
        predicted: { low: band.low ?? null, expected: band.expected ?? null, high: band.high ?? null },
        postedAt: v.postedAt ?? null,
        postUrl: v.postUrl ?? null,
        platform: v.creatorPlatform ?? null,
        latestViews: views,
        latestCapturedAt: snap?.capturedAt ?? v.actualViewsReportedAt ?? null,
        snapshotCount: (v.performanceSnapshots ?? []).length,
        outcome: outcomeFor(views, band),
    };
});

export const loadAnalyticsVideos = (userId) => Video.find({ uploader_id: userId, analysisStatus: ANALYSIS_STATUS.COMPLETED })
    .select(ANALYTICS_VIDEO_FIELDS)
    .sort({ createdAt: -1 })
    .limit(MAX_VIDEOS)
    .lean();
