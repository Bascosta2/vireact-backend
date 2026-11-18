/**
 * Learning loop for predicted views (pure functions; the database side is view-learning.service.js).
 *
 * Every real result a creator logs is an observation: how far the BASE prediction (the rules in
 * view-prediction.service.js, before any learning) was from the views the video actually got, as a
 * log ratio: ln((actual + 1) / (base + 1)). From all observations we learn a correction per segment
 * (platform, score band, follower count known or not) and how wide the miss usually is.
 *
 * New predictions = base x learned factor, with a band from the learned spread. Their errors are again
 * measured against the base, so corrections never compound, and each new report sharpens the next fit.
 *
 * Small data is handled by shrinkage: a segment with few results is pulled toward its platform, a
 * platform toward the global correction, and the global correction toward "no change". Guards:
 *   - each creator counts for at most MAX_PER_USER results (their newest), so one account can't steer it;
 *   - each observation is clipped to +/- ln(CLIP_FACTOR) and the mean is trimmed;
 *   - with HOLDOUT_MIN+ results the newest HOLDOUT_SHARE are held out, and the learned correction is
 *     switched off unless it beats the base on them.
 */
import { limitForScore } from './view-calibration.js';

export const LEARNING = Object.freeze({
    MAX_PER_USER: 10,
    CLIP_FACTOR: 100,
    MAX_FACTOR: 50,
    K_GLOBAL: 10,
    K_PLATFORM: 8,
    K_CELL: 8,
    /** A platform or segment gets its own correction only from this many results; below, it uses its parent's. */
    MIN_PLATFORM_OBS: 3,
    MIN_CELL_OBS: 5,
    HOLDOUT_MIN: 20,
    HOLDOUT_SHARE: 0.2,
    MIN_SPREAD_OBS: 15,
    /** Views logged sooner than this after posting are still climbing; they are not used. */
    SETTLE_MS: 2 * 24 * 60 * 60 * 1000,
});

const CLIP = Math.log(LEARNING.CLIP_FACTOR);
const MAX_MU = Math.log(LEARNING.MAX_FACTOR);
const WITHIN_2X = Math.log(2);

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x, d = 4) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

export const quantile = (sorted, p) => {
    if (!sorted.length) return null;
    const i = (sorted.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

/** Mean of the middle 80% once there are 10+ values (one wild report can't drag it). */
export const robustMean = (values) => {
    if (values.length < 10) return mean(values);
    const sorted = [...values].sort((a, b) => a - b);
    const cut = Math.floor(sorted.length * 0.1);
    return mean(sorted.slice(cut, sorted.length - cut));
};

/** Score bands used as segments. */
export const scoreBandOf = (score) => {
    if (!Number.isFinite(score)) return 'unknown';
    if (score >= 85) return '85+';
    if (score >= 75) return '75-84';
    if (score >= 65) return '65-74';
    if (score >= 55) return '55-64';
    if (score >= 45) return '45-54';
    return '0-44';
};

const platformKey = (platform) => (platform ? String(platform) : 'unknown');
const cellKey = ({ platform, scoreBand, followers }) => `${platformKey(platform)}|${scoreBand}|${followers ? 'f' : 'n'}`;

/** Log miss of a base prediction: positive = the video did better than predicted. */
export const residualOf = (actual, base) => Math.log((actual + 1) / (base + 1));

const shrink = (sampleMean, n, prior, k) => (n * sampleMean + k * prior) / (n + k);

/** Keep each creator's newest MAX_PER_USER observations, oldest first overall. */
export const capPerUser = (observations, max = LEARNING.MAX_PER_USER) => {
    const byUser = new Map();
    for (const o of observations) {
        const key = String(o.userId ?? 'unknown');
        if (!byUser.has(key)) byUser.set(key, []);
        byUser.get(key).push(o);
    }
    const kept = [];
    for (const list of byUser.values()) {
        list.sort((a, b) => new Date(b.at) - new Date(a.at));
        kept.push(...list.slice(0, max));
    }
    return { kept: kept.sort((a, b) => new Date(a.at) - new Date(b.at)), users: byUser.size };
};

/** Corrections (log factors) per segment from observations. */
export const estimate = (observations) => {
    const obs = observations.map((o) => ({ ...o, r: clamp(o.residual, -CLIP, CLIP) }));
    const n = obs.length;
    const globalMu = clamp(shrink(robustMean(obs.map((o) => o.r)), n, 0, LEARNING.K_GLOBAL), -MAX_MU, MAX_MU);

    const group = (keyFn) => {
        const groups = new Map();
        for (const o of obs) {
            const key = keyFn(o);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(o.r);
        }
        return groups;
    };

    const platforms = {};
    for (const [key, rs] of group((o) => platformKey(o.platform))) {
        if (rs.length < LEARNING.MIN_PLATFORM_OBS) continue;
        platforms[key] = { mu: round(clamp(shrink(robustMean(rs), rs.length, globalMu, LEARNING.K_PLATFORM), -MAX_MU, MAX_MU)), n: rs.length };
    }
    const cells = {};
    for (const [key, rs] of group(cellKey)) {
        if (rs.length < LEARNING.MIN_CELL_OBS) continue;
        const prior = platforms[key.split('|')[0]]?.mu ?? globalMu;
        cells[key] = { mu: round(clamp(shrink(robustMean(rs), rs.length, prior, LEARNING.K_CELL), -MAX_MU, MAX_MU)), n: rs.length };
    }

    const model = { global: { mu: round(globalMu), n }, platforms, cells, spread: null };
    if (n >= LEARNING.MIN_SPREAD_OBS) {
        const errors = obs.map((o) => o.r - correctionFor(model, o).mu).sort((a, b) => a - b);
        model.spread = { low: round(Math.min(0, quantile(errors, 0.2))), high: round(Math.max(0, quantile(errors, 0.8))), n };
    }
    return model;
};

/** The learned log correction for a prediction context: its segment, else its platform, else global. */
export const correctionFor = (model, { platform, scoreBand, followers }) => {
    const cell = model?.cells?.[cellKey({ platform, scoreBand, followers })];
    if (cell) return cell;
    const plat = model?.platforms?.[platformKey(platform)];
    if (plat) return plat;
    return model?.global ?? { mu: 0, n: 0 };
};

/**
 * Fit the model. Observations: { userId, at, platform, scoreBand, followers (bool), residual }.
 * Returns the model plus holdout metrics and whether it is enabled.
 */
export const fitLearnedModel = (observations) => {
    const { kept, users } = capPerUser(observations.filter((o) => Number.isFinite(o.residual)));
    const n = kept.length;
    let enabled = n > 0;
    let metrics = null;

    if (n >= LEARNING.HOLDOUT_MIN) {
        const cut = Math.floor(n * (1 - LEARNING.HOLDOUT_SHARE));
        const train = estimate(kept.slice(0, cut));
        const test = kept.slice(cut);
        const baseErr = test.map((o) => Math.abs(clamp(o.residual, -CLIP, CLIP)));
        const modelErr = test.map((o) => Math.abs(clamp(o.residual, -CLIP, CLIP) - correctionFor(train, o).mu));
        const baseError = mean(baseErr);
        const modelError = mean(modelErr);
        enabled = modelError <= baseError;
        metrics = {
            holdout: test.length,
            // Typical miss as a multiple (e.g. 3.1 = off by about 3x either way).
            baseTypicalMiss: round(Math.exp(baseError), 2),
            modelTypicalMiss: round(Math.exp(modelError), 2),
            baseWithin2x: round(baseErr.filter((e) => e <= WITHIN_2X).length / test.length, 3),
            modelWithin2x: round(modelErr.filter((e) => e <= WITHIN_2X).length / test.length, 3),
        };
    }

    return { observations: n, users, enabled, ...estimate(kept), metrics };
};

const ordered = (low, expected, high) => {
    const l = Math.max(0, Math.round(low));
    const e = Math.max(l, Math.round(expected));
    const h = Math.max(e, Math.round(high));
    return { low: l, expected: e, high: h };
};

/**
 * Apply a learned model to a base band. Without a usable model the base band comes back unchanged
 * and `learning` is null. The 5,000-view cap for ordinary scores grows with an upward correction,
 * because then real results have shown the cap is too low.
 */
export const applyLearnedModel = (model, band, { platform, viralityScore, followers }) => {
    if (!model?.enabled || !model.observations || band?.expected == null) return { band, learning: null };
    const { mu, n } = correctionFor(model, { platform, scoreBand: scoreBandOf(viralityScore), followers: Boolean(followers) });
    const factor = Math.exp(mu);
    const expected = band.expected * factor;
    const corrected = model.spread
        ? ordered(expected * Math.exp(model.spread.low), expected, expected * Math.exp(model.spread.high))
        : ordered((band.low ?? band.expected) * factor, expected, (band.high ?? band.expected) * factor);
    return {
        band: limitForScore(corrected, viralityScore, { capMultiplier: Math.max(1, factor), followers }),
        learning: { version: model.version ?? null, factor: round(factor, 3), n, observations: model.observations },
    };
};
