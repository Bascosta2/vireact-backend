/**
 * Hard ceiling on predicted views, keyed to the video's overall virality score.
 *
 * The knowledge base the predictor reads is dominated by videos that already went viral, so the model
 * over-predicts. Real base rates: most short-form posts from typical creators get under 1,000 views,
 * 10K+ is roughly the top 10%, 100K+ is well under 1%. The model may predict lower than these
 * ceilings, never higher.
 *
 * Recalibrated 2026-11-06 after a real result: a video predicted at ~157K got 1.7K. No range goes
 * above 5,000 views unless the overall score is at least STANDOUT_SCORE (a clearly strong video).
 */
export const STANDOUT_SCORE = 85;
export const ORDINARY_MAX_VIEWS = 5000;

export const VIEW_CEILINGS = [
    { minScore: 92, low: 1500, expected: 6000, high: 25000 },
    { minScore: 85, low: 800, expected: 3000, high: 12000 },
    { minScore: 75, low: 300, expected: 1200, high: 5000 },
    { minScore: 65, low: 150, expected: 600, high: 2500 },
    { minScore: 55, low: 80, expected: 300, high: 1200 },
    { minScore: 45, low: 40, expected: 180, high: 700 },
    { minScore: 0, low: 20, expected: 100, high: 400 },
];

/**
 * Final guard on any band shown to a user: below STANDOUT_SCORE nothing exceeds ORDINARY_MAX_VIEWS.
 * Keeps the band ordered.
 */
export const limitForScore = (band, viralityScore) => {
    if (!band || (band.low == null && band.expected == null && band.high == null)) return band;
    if (Number.isFinite(viralityScore) && viralityScore >= STANDOUT_SCORE) return band;
    const cap = (n) => (n == null ? n : Math.min(n, ORDINARY_MAX_VIEWS));
    const low = cap(band.low);
    const expected = cap(band.expected);
    const high = cap(band.high);
    return {
        ...band,
        low,
        expected: expected == null ? expected : Math.max(expected, low ?? 0),
        high: high == null ? high : Math.max(high, expected ?? 0, low ?? 0),
    };
};

/** Ceiling row for a virality score. An unknown score gets a below-average ceiling. */
export const viewCeilingFor = (viralityScore) => {
    const score = Number.isFinite(viralityScore) ? viralityScore : 45;
    return VIEW_CEILINGS.find((row) => score >= row.minScore) ?? VIEW_CEILINGS[VIEW_CEILINGS.length - 1];
};

// Number(null) is 0, so missing values must be checked before converting.
const toCount = (value) =>
    value != null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.round(Number(value)) : null;

/**
 * Clamp a predicted band to the ceiling for this score and keep it ordered (low <= expected <= high).
 *
 * @param {{ low: number|null, expected: number|null, high: number|null }} band
 * @param {number|null} viralityScore 0-100
 * @returns {{ low: number|null, expected: number|null, high: number|null, capped: boolean }}
 */
export const calibrateViewBand = (band, viralityScore) => {
    const low = toCount(band?.low);
    const high = toCount(band?.high);
    let expected = toCount(band?.expected);
    if (low == null && high == null && expected == null) {
        return { low: null, expected: null, high: null, capped: false };
    }
    if (expected == null) expected = low != null && high != null ? Math.round((low + high) / 2) : low ?? high;

    const ceiling = viewCeilingFor(viralityScore);
    const capped = {
        low: Math.min(low ?? expected, ceiling.low),
        expected: Math.min(expected, ceiling.expected),
        high: Math.min(high ?? expected, ceiling.high),
    };
    // Keep the band ordered after clamping.
    capped.expected = Math.max(capped.expected, capped.low);
    capped.high = Math.max(capped.high, capped.expected);

    const wasCapped = capped.low !== (low ?? expected) || capped.expected !== expected || capped.high !== (high ?? expected);
    return { ...capped, capped: wasCapped };
};
