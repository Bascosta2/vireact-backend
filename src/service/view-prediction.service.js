/**
 * Predicted views, from the best evidence available for this video:
 *
 * 1. "dataset": the creator gave a follower count and there are at least MIN_COMPARABLES similar videos
 *    with real results users reported (similar virality score, same platform when known). The band is
 *    those videos' views-per-follower (20th / 50th / 80th percentile) scaled to this creator's followers,
 *    then nudged by this video's edit energy. The admin VideoPerformanceDataset is NOT used: it was
 *    collected from videos that went viral and inflated predictions.
 * 2. "followers": follower count known, too few comparables. The reach model below.
 * 3. "score": no follower count. The same reach model for a small account (ASSUMED_FOLLOWERS).
 *
 * Reach model (2026-11-17, replaces flat views-per-follower rates that were far too harsh: a 9K-follower
 * account with an engaging video was told ~300 views):
 *   expected = typicalViews(followers) x quality(viralityScore) x editEnergy(video)
 *   - typicalViews: what an average video (score 60) gets. Grows with followers but slower than linear,
 *     because short-form reach comes mostly from the feed, not from followers.
 *       500 followers -> ~630, 9K -> ~980, 200K -> ~2.4K, 1M -> ~4.5K
 *   - quality: steep both ways. Score 80 ~2.7x, 90 ~4.5x; score 45 ~0.35x, 30 ~0.12x.
 *   - editEnergy (view-signals.js): fast cuts, sound effects, tight pacing, a clear hook lift it (to ~2.2x);
 *     slow cuts, off-center framing, a weak hook or hard-to-follow content pull it down (to ~0.45x).
 *   - band: low = 0.18x expected; high = 3x, wider for strong videos (up to ~7x) so the upside shows.
 *   Check: the owner's real case (200K followers, score 80, got 1.7K) stays inside its band.
 *
 * Last, the learned correction from real results (view-learning.js) is applied when a model is passed in.
 * The band before it is kept as the base, which is what the learning loop measures its misses against.
 */
import { Video } from '../model/video.model.js';
import { limitForScore } from './view-calibration.js';
import { applyLearnedModel } from './view-learning.js';
import { contentSignals, editEnergy } from './view-signals.js';

export const PLATFORMS = Object.freeze(['tiktok', 'instagram', 'youtube', 'facebook', 'other']);
export const MIN_COMPARABLES = 8;
const SCORE_WINDOW = 8;
const MAX_FOLLOWERS = 1_000_000_000;

/** Follower count assumed when the creator didn't give one (a small account). */
export const ASSUMED_FOLLOWERS = 500;
const LOW_X = 0.18;

export const normalizePlatform = (value) => {
    const v = String(value ?? '').trim().toLowerCase();
    return PLATFORMS.includes(v) ? v : null;
};

export const normalizeFollowers = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Math.round(Number(String(value).replace(/[,\s_]/g, '')));
    return Number.isFinite(n) && n >= 0 && n <= MAX_FOLLOWERS ? n : null;
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

/** Views an average video (score 60) gets for this many followers. */
export const typicalViews = (followers) => 500 + 8 * Math.pow(Math.max(0, followers), 0.45);

/** Multiplier for the overall virality score (60 = 1x). Steeper below 60: weak videos are punished hard. */
export const qualityMultiplier = (viralityScore) => {
    const d = (Number.isFinite(viralityScore) ? viralityScore : 50) - 60;
    return Math.exp(d >= 0 ? 0.05 * d : 0.07 * d);
};

/** How far above expected the high end reaches: 3x for ordinary videos, wider for strong or energetic ones. */
const highMultiple = (viralityScore, energy) => {
    const s = Number.isFinite(viralityScore) ? viralityScore : 50;
    return 3 + Math.max(0, s - 60) / 10 + (energy >= 1.3 ? 1 : 0);
};

/**
 * The reach-model band. `signals` from contentSignals(video); without them the edit counts as neutral.
 * Returns the band plus what moved it (`drivers`).
 */
export const estimateBand = ({ viralityScore, followers, signals }) => {
    const f = Number(followers) > 0 ? Number(followers) : ASSUMED_FOLLOWERS;
    const energy = editEnergy(signals ?? {});
    const expected = typicalViews(f) * qualityMultiplier(viralityScore) * energy.multiplier;
    const band = ordered(expected * LOW_X, expected, expected * highMultiple(viralityScore, energy.multiplier));
    return { ...band, drivers: { energy: energy.multiplier, boosts: energy.boosts, drags: energy.drags } };
};

const bandOnly = ({ low, expected, high }) => ({ low, expected, high });

/** Follower-based band (kept name for callers). */
export const followerBand = ({ viralityScore, followers, signals }) => bandOnly(estimateBand({ viralityScore, followers, signals }));

/** Band from comparable videos' views-per-follower ratios (users' reported results only), nudged by edit energy. */
export const datasetBand = ({ ratios, followers, viralityScore, signals }) => {
    const sorted = ratios.filter((r) => Number.isFinite(r) && r >= 0).sort((a, b) => a - b);
    const energy = editEnergy(signals ?? {}).multiplier;
    const band = ordered(
        Math.max(1, followers * percentile(sorted, 0.2) * energy),
        followers * percentile(sorted, 0.5) * energy,
        followers * percentile(sorted, 0.8) * energy
    );
    return limitForScore(band, viralityScore, { followers });
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
 * @param {{ viralityScore: number|null, followers?: number|null, platform?: string|null, signals?: object,
 *           modelBand?: object, excludeVideoId?: unknown, findRatios?: Function, learned?: object|null }} input
 * @returns {Promise<{ low: number|null, expected: number|null, high: number|null, method: 'dataset'|'followers'|'score', comparables: number,
 *                     base: { low: number|null, expected: number|null, high: number|null }, learning: object|null }>}
 */
export const predictViewBand = async (input) => {
    const base = await baseViewBand(input);
    const band = { low: base.low, expected: base.expected, high: base.high };
    const { band: final, learning } = applyLearnedModel(input.learned, band, {
        platform: normalizePlatform(input.platform),
        viralityScore: input.viralityScore,
        followers: normalizeFollowers(input.followers),
    });
    return { ...final, method: base.method, comparables: base.comparables, base: band, learning };
};

/** The prediction from the rules alone, before any learned correction. */
export const baseViewBand = async ({ viralityScore, followers, platform, signals, excludeVideoId, findRatios = findComparableRatios }) => {
    const knownFollowers = normalizeFollowers(followers);
    if (knownFollowers == null || knownFollowers === 0) {
        return { ...followerBand({ viralityScore, followers: null, signals }), method: 'score', comparables: 0 };
    }

    const ratios = await findRatios({ viralityScore, platform: normalizePlatform(platform), excludeVideoId });
    if (ratios.length >= MIN_COMPARABLES) {
        return { ...datasetBand({ ratios, followers: knownFollowers, viralityScore, signals }), method: 'dataset', comparables: ratios.length };
    }
    return { ...followerBand({ viralityScore, followers: knownFollowers, signals }), method: 'followers', comparables: ratios.length };
};

/**
 * The band to show for a stored video. Reach-model estimates ("followers", "score", older rows) are
 * recomputed with the current model on every read, so reports saved under older rules are corrected
 * without reprocessing. Comparable-based and learned predictions are shown as they were made.
 */
export const displayViewBand = (video) => {
    const score = Number.isFinite(video?.viralityScore) ? video.viralityScore : null;
    const stored = { low: video?.predictedViewsLow ?? null, expected: video?.predictedViewsExpected ?? null, high: video?.predictedViewsHigh ?? null };
    const followers = normalizeFollowers(video?.creatorFollowers);
    if (video?.viewLearning?.factor != null) {
        return limitForScore(stored, score, { capMultiplier: Math.max(1, video.viewLearning.factor), followers });
    }
    if (video?.viewPredictionMethod === 'dataset') {
        return limitForScore(stored, score, { followers });
    }
    // Never predicted (no model band and no follower count): nothing to show.
    if (stored.low == null && stored.expected == null && stored.high == null && !followers) return stored;
    return followerBand({ viralityScore: score, followers, signals: contentSignals(video) });
};

/** What moved this video's prediction, for the report ("fast cuts", "slow cuts"...). */
export const viewDrivers = (video) => {
    const { boosts, drags, multiplier } = editEnergy(contentSignals(video));
    return { boosts, drags, energy: multiplier };
};
