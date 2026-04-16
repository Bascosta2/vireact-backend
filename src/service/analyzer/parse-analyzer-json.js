/**
 * Parse analyzer JSON response. Handles code fences and validates score 0-100.
 * @param {string} response - Raw response from OpenAI
 * @returns {{ score: number, rating: string, reasoning: string, suggestions: string[] } | null}
 */
export function parseAnalyzerJson(response) {
    if (response == null) return null;
    const text = typeof response === 'string' ? response.trim() : '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        const obj = JSON.parse(match[0]);
        const score = Math.min(100, Math.max(0, Number(obj.score) ?? 0));
        return {
            score,
            rating: obj.rating || 'Unknown',
            reasoning: obj.reasoning || obj.feedback || '',
            suggestions: Array.isArray(obj.suggestions) ? obj.suggestions : []
        };
    } catch {
        return null;
    }
}

/**
 * Map Weak/Medium/Strong to approximate 0-100 for backward compatibility if model returns only rating.
 */
export function ratingToScore(rating) {
    const r = (rating || '').toLowerCase();
    if (r.includes('strong')) return 85;
    if (r.includes('medium')) return 55;
    if (r.includes('weak')) return 25;
    return 50;
}

/**
 * Parse views predictor JSON: tier + view bands.
 * @param {string} response
 * @returns {{ tier: string, conservativeLow: number, conservativeHigh: number, expectedLow: number, expectedHigh: number, optimisticLow: number, optimisticHigh: number, confidence: number, reasoning?: string, suggestions?: string[] } | null}
 */
/**
 * Parse advanced analytics JSON: score/rating/reasoning/suggestions plus enrichment fields.
 * @param {string} response
 * @returns {{ score: number, rating: string, reasoning: string, suggestions: string[], emotionalTriggers: string[], retentionDrivers: string[], psychologicalProfile: string | null, weakestMoment: string | null } | null}
 */
export function parseAdvancedAnalyticsJson(response) {
    if (response == null) return null;
    const text = typeof response === 'string' ? response.trim() : '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        const obj = JSON.parse(match[0]);
        const score = Math.min(100, Math.max(0, Number(obj.score) ?? 0));
        const asStringList = (v) =>
            Array.isArray(v)
                ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
                : [];
        const psych =
            typeof obj.psychologicalProfile === 'string' && obj.psychologicalProfile.trim()
                ? obj.psychologicalProfile.trim()
                : null;
        const weak =
            typeof obj.weakestMoment === 'string' && obj.weakestMoment.trim()
                ? obj.weakestMoment.trim()
                : null;
        return {
            score,
            rating: obj.rating || 'Unknown',
            reasoning: obj.reasoning || obj.feedback || '',
            suggestions: Array.isArray(obj.suggestions) ? obj.suggestions : [],
            emotionalTriggers: asStringList(obj.emotionalTriggers),
            retentionDrivers: asStringList(obj.retentionDrivers),
            psychologicalProfile: psych,
            weakestMoment: weak,
        };
    } catch {
        return null;
    }
}

export function parseViewsPredictorJson(response) {
    if (response == null) return null;
    const text = typeof response === 'string' ? response.trim() : '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
        const obj = JSON.parse(match[0]);
        const toNum = (v) => Math.max(0, Math.round(Number(v) || 0));
        return {
            tier: obj.tier || 'medium',
            conservativeLow: toNum(obj.conservativeLow),
            conservativeHigh: toNum(obj.conservativeHigh),
            expectedLow: toNum(obj.expectedLow),
            expectedHigh: toNum(obj.expectedHigh),
            optimisticLow: toNum(obj.optimisticLow),
            optimisticHigh: toNum(obj.optimisticHigh),
            confidence: Math.min(1, Math.max(0, Number(obj.confidence) ?? 0.5)),
            reasoning: obj.reasoning,
            suggestions: Array.isArray(obj.suggestions) ? obj.suggestions : []
        };
    } catch {
        return null;
    }
}
