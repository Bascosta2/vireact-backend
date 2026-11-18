/**
 * Report cards for view predictions (docs/learning-engine/PLAN.md, section 5.5). Pure functions.
 *
 * A row is one video with a real result: { predicted: { low, expected, high }, actual, at, ...groupKeys }.
 * Error is measured on the log scale, ln((actual + 1) / (expected + 1)), because being off by 2x matters
 * the same at 500 views as at 500K.
 *
 *   typicalMiss   exp(median |log error|): "usually off by this factor" (1.0 = perfect)
 *   within2x      share of results within 2x of the expected number
 *   coverage      share of results inside [low, high] (target about 0.8)
 *   bias          exp(mean log error): > 1 means we predict too low, < 1 too high
 *
 * The same report is used for today's model and, later, to decide whether a trained model may replace it.
 */
import { estimateBand } from '../view-prediction.service.js';

export const COVERAGE_TARGET = Object.freeze({ min: 0.75, max: 0.85 });
const r3 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);

export const logError = (row) => Math.log((row.actual + 1) / (row.predicted.expected + 1));

const usable = (row) => row && Number.isFinite(row.actual) && row.actual >= 0 && Number.isFinite(row.predicted?.expected);

export const metrics = (rows = []) => {
    const ok = rows.filter(usable);
    if (!ok.length) return { n: 0, typicalMiss: null, within2x: null, coverage: null, bias: null };
    const errors = ok.map(logError);
    const abs = errors.map(Math.abs).sort((a, b) => a - b);
    const mid = Math.floor(abs.length / 2);
    const medianAbs = abs.length % 2 ? abs[mid] : (abs[mid - 1] + abs[mid]) / 2;
    const banded = ok.filter((r) => Number.isFinite(r.predicted.low) && Number.isFinite(r.predicted.high));
    return {
        n: ok.length,
        typicalMiss: r3(Math.exp(medianAbs)),
        within2x: r3(abs.filter((e) => e <= Math.log(2)).length / abs.length),
        coverage: banded.length ? r3(banded.filter((r) => r.actual >= r.predicted.low && r.actual <= r.predicted.high).length / banded.length) : null,
        bias: r3(Math.exp(errors.reduce((a, b) => a + b, 0) / errors.length)),
    };
};

/** Metrics per value of `key` (e.g. platform, niche), only for groups with at least minN results. */
export const metricsBy = (rows, key, { minN = 5 } = {}) => {
    const groups = new Map();
    for (const row of rows.filter(usable)) {
        const k = row[key] ?? 'unknown';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(row);
    }
    return Object.fromEntries([...groups.entries()]
        .filter(([, list]) => list.length >= minN)
        .sort((a, b) => b[1].length - a[1].length)
        .map(([k, list]) => [k, metrics(list)]));
};

/** Oldest rows train, the newest `testDays` test. Rows need `at` (Date). */
export const timeSplit = (rows, { testDays = 14, now = Date.now() } = {}) => {
    const cut = now - testDays * 24 * 60 * 60 * 1000;
    const train = [];
    const test = [];
    for (const row of rows) (new Date(row.at).getTime() >= cut ? test : train).push(row);
    return { train, test, cut: new Date(cut) };
};

/**
 * The owner's two real calibration cases (memory: view-predictions). Any model that replaces today's
 * must keep both true. `predict({ viralityScore, followers })` returns { low, expected, high }.
 */
export const OWNER_CASES = Object.freeze([
    {
        id: '200k_score80_got_1.7k',
        label: '200K followers, score 80, really got 1.7K: 1.7K must be inside the band',
        input: { viralityScore: 80, followers: 200000 },
        pass: (b) => b.low <= 1700 && 1700 <= b.high,
    },
    {
        id: '9k_score62_not_300',
        label: '9K followers, engaging video (score 62): expect 900-1,500 with a high of 3,000+',
        input: { viralityScore: 62, followers: 9000 },
        pass: (b) => b.expected >= 900 && b.expected <= 1500 && b.high >= 3000,
    },
]);

export const checkOwnerCases = (predict = (input) => estimateBand(input)) => OWNER_CASES.map((c) => {
    const band = predict(c.input);
    return { id: c.id, label: c.label, band: { low: band.low, expected: band.expected, high: band.high }, pass: Boolean(c.pass(band)) };
});

/**
 * Whether a challenger may replace the champion. Both are metrics() on the SAME test rows.
 * Used once a trained model exists (phase 5); defined now so the rules are fixed and tested up front.
 */
export const promotionDecision = ({ champion, challenger, ownerCases = [], minN = 50, minGain = 0.03 }) => {
    const reasons = [];
    if (!challenger || challenger.n < minN) reasons.push(`needs at least ${minN} test results (has ${challenger?.n ?? 0})`);
    if (challenger?.typicalMiss != null && champion?.typicalMiss != null && challenger.typicalMiss > champion.typicalMiss * (1 - minGain)) {
        reasons.push(`typical miss ${challenger.typicalMiss} is not ${Math.round(minGain * 100)}% better than ${champion.typicalMiss}`);
    }
    if (challenger?.coverage == null || challenger.coverage < COVERAGE_TARGET.min || challenger.coverage > COVERAGE_TARGET.max) {
        reasons.push(`band coverage ${challenger?.coverage ?? 'unknown'} is outside ${COVERAGE_TARGET.min}-${COVERAGE_TARGET.max}`);
    }
    for (const c of ownerCases) if (!c.pass) reasons.push(`owner case failed: ${c.id}`);
    return { promote: reasons.length === 0, reasons };
};
