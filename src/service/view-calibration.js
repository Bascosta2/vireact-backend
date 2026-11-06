/**
 * Hard ceiling on predicted views, keyed to the video's overall virality score.
 *
 * The knowledge base the predictor reads is dominated by videos that already went viral, so the model
 * over-predicts. Real base rates: most short-form posts from typical creators get under 1,000 views,
 * 10K+ is roughly the top 10%, 100K+ is well under 1%. The model may predict lower than these
 * ceilings, never higher.
 */
export const VIEW_CEILINGS = [
    { minScore: 85, low: 3000, expected: 20000, high: 150000 },
    { minScore: 75, low: 1000, expected: 6000, high: 40000 },
    { minScore: 65, low: 400, expected: 2000, high: 12000 },
    { minScore: 55, low: 150, expected: 800, high: 5000 },
    { minScore: 45, low: 80, expected: 400, high: 2500 },
    { minScore: 0, low: 30, expected: 200, high: 1200 },
];

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
