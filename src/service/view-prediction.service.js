/**
 * Predicted views, from the best evidence available for this video:
 *
 * 1. "dataset": the creator gave a follower count and there are at least MIN_COMPARABLES similar videos
 *    with real results (similar virality score, same platform when known). The band is those videos'
 *    views-per-follower (20th / 50th / 85th percentile) scaled to this creator's followers. Comparables
 *    come from VideoPerformanceDataset (admin ingest) and from users' own reported results.
 * 2. "followers": follower count known but too few comparables. Views-per-follower rate by score band.
 *    These rates are a HEURISTIC (not measured data); they will be replaced as reported results build up.
 * 3. "score": no follower count. The model's band capped by the virality score (view-calibration.js).
 *    Raw dataset views are deliberately NOT used here: the dataset is dominated by viral videos.
 */
import { VideoPerformanceDataset } from '../model/VideoPerformanceDataset.model.js';
import { Video } from '../model/video.model.js';
import { calibrateViewBand, viewCeilingFor } from './view-calibration.js';

export const PLATFORMS = Object.freeze(['tiktok', 'instagram', 'youtube', 'facebook', 'other']);
export const MIN_COMPARABLES = 8;
const SCORE_WINDOW = 8;
const MAX_FOLLOWERS = 1_000_000_000;

/** Heuristic share of followers who see a post, by virality score. Labelled as such in the UI. */
export const FOLLOWER_REACH = Object.freeze([
    { minScore: 85, rate: 0.6 },
    { minScore: 75, rate: 0.3 },
    { minScore: 65, rate: 0.15 },
    { minScore: 55, rate: 0.08 },
    { minScore: 45, rate: 0.04 },
    { minScore: 0, rate: 0.02 },
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

/** Follower-based band (heuristic). Never below what an unknown account would get for this score. */
export const followerBand = ({ viralityScore, followers }) => {
    const ceiling = viewCeilingFor(viralityScore);
    const expected = Math.max(ceiling.expected, followers * reachRateFor(viralityScore));
    return ordered(Math.max(Math.min(ceiling.low, expected), expected * 0.25), expected, Math.max(ceiling.high, expected * 4));
};

/** Band from comparable videos' views-per-follower ratios. Measured data wins: no heuristic floor here. */
export const datasetBand = ({ ratios, followers }) => {
    const sorted = ratios.filter((r) => Number.isFinite(r) && r >= 0).sort((a, b) => a - b);
    return ordered(
        Math.max(1, followers * percentile(sorted, 0.2)),
        followers * percentile(sorted, 0.5),
        followers * percentile(sorted, 0.85)
    );
};

/** Views-per-follower ratios of similar videos with real results. Never throws. */
export const findComparableRatios = async ({ viralityScore, platform, excludeVideoId }) => {
    if (!Number.isFinite(viralityScore)) return [];
    const scoreRange = { $gte: viralityScore - SCORE_WINDOW, $lte: viralityScore + SCORE_WINDOW };
    try {
        const datasetFilter = { viralityScore: scoreRange, actualViews: { $gte: 0 }, subscriberCount: { $gt: 0 } };
        if (platform && platform !== 'other') datasetFilter.platform = platform;
        const videoFilter = { viralityScore: scoreRange, actualViews: { $gte: 0 }, creatorFollowers: { $gt: 0 } };
        if (platform && platform !== 'other') videoFilter.creatorPlatform = platform;
        if (excludeVideoId) videoFilter._id = { $ne: excludeVideoId };

        const [dataset, reported] = await Promise.all([
            VideoPerformanceDataset.find(datasetFilter).select('actualViews subscriberCount').limit(500).lean(),
            Video.find(videoFilter).select('actualViews creatorFollowers').limit(500).lean(),
        ]);
        return [
            ...dataset.map((row) => row.actualViews / row.subscriberCount),
            ...reported.map((row) => row.actualViews / row.creatorFollowers),
        ];
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
        const capped = calibrateViewBand(modelBand ?? {}, viralityScore);
        return { low: capped.low, expected: capped.expected, high: capped.high, method: 'score', comparables: 0 };
    }

    const ratios = await findRatios({ viralityScore, platform: normalizePlatform(platform), excludeVideoId });
    if (ratios.length >= MIN_COMPARABLES) {
        return { ...datasetBand({ ratios, followers: knownFollowers }), method: 'dataset', comparables: ratios.length };
    }
    return { ...followerBand({ viralityScore, followers: knownFollowers }), method: 'followers', comparables: ratios.length };
};
