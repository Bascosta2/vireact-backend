/**
 * Predicted views, from the best evidence available for this video:
 *
 * 1. "dataset": the creator gave a follower count and there are at least MIN_COMPARABLES similar videos
 *    with real results users reported (similar virality score, same platform when known). The band is
 *    those videos' views-per-follower (20th / 50th / 80th percentile) scaled to this creator's followers.
 *    The admin VideoPerformanceDataset is NOT used: it was collected from videos that went viral, and
 *    using it inflated predictions (a video predicted at ~157K got 1.7K).
 * 2. "followers": follower count known but too few comparables. Views-per-follower rate by score band.
 *    These rates are a HEURISTIC (not measured data); they will be replaced as reported results build up.
 * 3. "score": no follower count. The model's band capped by the virality score (view-calibration.js).
 *
 * Every band then passes limitForScore: nothing above 5,000 views unless the score is 85+.
 */
import { Video } from '../model/video.model.js';
import { calibrateViewBand, viewCeilingFor, limitForScore } from './view-calibration.js';

export const PLATFORMS = Object.freeze(['tiktok', 'instagram', 'youtube', 'facebook', 'other']);
export const MIN_COMPARABLES = 8;
const SCORE_WINDOW = 8;
const MAX_FOLLOWERS = 1_000_000_000;

/**
 * Heuristic views per follower, by virality score. Labelled as such in the UI.
 * Cut about 50x on 2026-11-06 (the old rates assumed 2% to 60% of followers would watch).
 */
export const FOLLOWER_REACH = Object.freeze([
    { minScore: 92, rate: 0.02 },
    { minScore: 85, rate: 0.012 },
    { minScore: 75, rate: 0.006 },
    { minScore: 65, rate: 0.003 },
    { minScore: 55, rate: 0.0016 },
    { minScore: 45, rate: 0.0008 },
    { minScore: 0, rate: 0.0004 },
]);

export const normalizePlatform = (value) => {
    const v = String(value ?? '').trim().toLowerCase();
    return PLATFORMS.includes(v) ? v : null;
};

export const normalizeFollowers = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Math.round(Number(String(value).replace(/[,\s_]/g, '')));
    return Number.isFinite(n) && n >= 0 && n <= MAX_FOLLOWERS ? n : null;
};

const reachRateFor = (score) => {
    const s = Number.isFinite(score) ? score : 45;
    return (FOLLOWER_REACH.find((row) => s >= row.minScore) ?? FOLLOWER_REACH[FOLLOWER_REACH.length - 1]).rate;
};

export const percentile = (sorted, p) => {
    if (sorted.length === 0) return null;
    const index = (sorted.length - 1) * p;
    const lo = Math.floor(index);
    const hi = Math.ceil(index);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
};

const ordered = (low, expected, high) => {
    const l = Math.max(0, Math.round(low));
    const e = Math.max(l, Math.round(expected));
    const h = Math.max(e, Math.round(high));
    return { low: l, expected: e, high: h };
};

/** Follower-based band (heuristic). Small accounts get the score ceiling; larger ones scale with followers. */
export const followerBand = ({ viralityScore, followers }) => {
    const ceiling = viewCeilingFor(viralityScore);
    const expected = Math.max(ceiling.expected, followers * reachRateFor(viralityScore));
    const band = ordered(Math.max(Math.min(ceiling.low, expected), expected * 0.3), expected, Math.max(ceiling.high, expected * 3));
    return limitForScore(band, viralityScore);
};

/** Band from comparable videos' views-per-follower ratios (users' reported results only). */
export const datasetBand = ({ ratios, followers, viralityScore }) => {
    const sorted = ratios.filter((r) => Number.isFinite(r) && r >= 0).sort((a, b) => a - b);
    const band = ordered(
        Math.max(1, followers * percentile(sorted, 0.2)),
        followers * percentile(sorted, 0.5),
        followers * percentile(sorted, 0.8)
    );
    return limitForScore(band, viralityScore);
};

/** Views-per-follower ratios of similar videos whose creators reported real results. Never throws. */
export const findComparableRatios = async ({ viralityScore, platform, excludeVideoId }) => {
    if (!Number.isFinite(viralityScore)) return [];
    const scoreRange = { $gte: viralityScore - SCORE_WINDOW, $lte: viralityScore + SCORE_WINDOW };
    try {
        const videoFilter = { viralityScore: scoreRange, actualViews: { $gte: 0 }, creatorFollowers: { $gt: 0 } };
        if (platform && platform !== 'other') videoFilter.creatorPlatform = platform;
        if (excludeVideoId) videoFilter._id = { $ne: excludeVideoId };
        const reported = await Video.find(videoFilter).select('actualViews creatorFollowers').limit(500).lean();
        return reported.map((row) => row.actualViews / row.creatorFollowers);
    } catch (error) {
        console.warn(`[Views] Comparable lookup failed: ${error.message}`);
        return [];
    }
};

/**
 * @param {{ viralityScore: number|null, followers?: number|null, platform?: string|null,
 *           modelBand: { low: number|null, expected: number|null, high: number|null }, excludeVideoId?: unknown,
 *           findRatios?: Function }} input
 * @returns {Promise<{ low: number|null, expected: number|null, high: number|null, method: 'dataset'|'followers'|'score', comparables: number }>}
 */
export const predictViewBand = async ({ viralityScore, followers, platform, modelBand, excludeVideoId, findRatios = findComparableRatios }) => {
    const knownFollowers = normalizeFollowers(followers);
    if (knownFollowers == null || knownFollowers === 0) {
        const capped = limitForScore(calibrateViewBand(modelBand ?? {}, viralityScore), viralityScore);
        return { low: capped.low, expected: capped.expected, high: capped.high, method: 'score', comparables: 0 };
    }

    const ratios = await findRatios({ viralityScore, platform: normalizePlatform(platform), excludeVideoId });
    if (ratios.length >= MIN_COMPARABLES) {
        return { ...datasetBand({ ratios, followers: knownFollowers, viralityScore }), method: 'dataset', comparables: ratios.length };
    }
    return { ...followerBand({ viralityScore, followers: knownFollowers }), method: 'followers', comparables: ratios.length };
};

/**
 * The band to show for a stored video. Follower estimates are recomputed with the current rates and
 * every band passes the current ceilings, so reports saved under older (inflated) rules are corrected
 * on read without reprocessing.
 */
export const displayViewBand = (video) => {
    const score = Number.isFinite(video?.viralityScore) ? video.viralityScore : null;
    const stored = { low: video?.predictedViewsLow ?? null, expected: video?.predictedViewsExpected ?? null, high: video?.predictedViewsHigh ?? null };
    const followers = normalizeFollowers(video?.creatorFollowers);
    if (video?.viewPredictionMethod === 'followers' && followers) {
        return followerBand({ viralityScore: score, followers });
    }
    if (video?.viewPredictionMethod === 'dataset') {
        return limitForScore(stored, score);
    }
    const capped = calibrateViewBand(stored, score);
    return limitForScore({ low: capped.low, expected: capped.expected, high: capped.high }, score);
};
