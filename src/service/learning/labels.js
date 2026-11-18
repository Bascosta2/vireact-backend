/**
 * What the model learns to predict (docs/learning-engine/PLAN.md, section 4). Pure functions.
 *
 * Raw views mostly measure account size, so the label is OUTPERFORMANCE: how a video did against its
 * creator's typical video, as a log ratio ln((views + 1) / (baseline + 1)). 0 = a normal video for that
 * creator, +0.69 = twice their usual, -0.69 = half.
 *
 * Baseline: the median views of the creator's other settled videos when we have at least
 * MIN_BASELINE_VIDEOS of them; otherwise typicalViews(followers), the reach model's estimate.
 * Views are read at HORIZON_HOURS (7 days); readings younger than SETTLE_HOURS are still climbing.
 */
import { typicalViews } from '../view-prediction.service.js';

export const HORIZON_HOURS = 7 * 24;
export const SETTLE_HOURS = 48;
export const MIN_BASELINE_VIDEOS = 3;
const HOUR_MS = 60 * 60 * 1000;

export const median = (values) => {
    const s = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (!s.length) return null;
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export const ageHoursAt = (postedAt, capturedAt) => {
    const p = postedAt ? new Date(postedAt).getTime() : NaN;
    const c = capturedAt ? new Date(capturedAt).getTime() : NaN;
    return Number.isFinite(p) && Number.isFinite(c) ? Math.max(0, (c - p) / HOUR_MS) : null;
};

/**
 * The reading to learn from: among settled readings (age >= SETTLE_HOURS), the one closest to the
 * horizon. When the post time is unknown, the newest reading, flagged ageKnown: false.
 * Returns null when there is nothing usable.
 */
export const outcomeAtHorizon = (snapshots = [], { horizonHours = HORIZON_HOURS } = {}) => {
    const rows = (Array.isArray(snapshots) ? snapshots : []).filter((s) => Number.isFinite(s?.views) && s.views >= 0);
    if (!rows.length) return null;
    const aged = rows.filter((s) => Number.isFinite(s.ageHours));
    if (aged.length) {
        const settled = aged.filter((s) => s.ageHours >= SETTLE_HOURS);
        if (!settled.length) return null;
        const best = settled.reduce((a, b) => (Math.abs(b.ageHours - horizonHours) < Math.abs(a.ageHours - horizonHours) ? b : a));
        return { views: best.views, ageHours: best.ageHours, ageKnown: true, source: best.source ?? null };
    }
    const newest = rows.reduce((a, b) => (new Date(b.capturedAt) > new Date(a.capturedAt) ? b : a));
    return { views: newest.views, ageHours: null, ageKnown: false, source: newest.source ?? null };
};

/** A creator's typical views from their other settled videos, or null when there are too few. */
export const creatorBaseline = (otherViews = []) => {
    const values = otherViews.filter((v) => Number.isFinite(v) && v >= 0);
    return values.length >= MIN_BASELINE_VIDEOS ? { views: median(values), n: values.length, method: 'creator_median' } : null;
};

/** The baseline to compare against: the creator's own history, else the follower estimate. */
export const baselineFor = ({ otherViews = [], followers = null } = {}) => {
    const own = creatorBaseline(otherViews);
    if (own) return own;
    const f = Number(followers);
    return Number.isFinite(f) && f > 0 ? { views: typicalViews(f), n: 0, method: 'followers' } : null;
};

export const outperformance = (views, baselineViews) =>
    Number.isFinite(views) && Number.isFinite(baselineViews) ? Math.log((views + 1) / (baselineViews + 1)) : null;
