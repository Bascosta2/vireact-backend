/**
 * Build VideoAnalysis DTO from Video document (slash-doc shape).
 * Maps analysis[], scenes, timestampFeedback, viralityScore, view bands, retentionCurve
 * and normalizes timestampFeedback to FeedbackItem (timestampStart, timestampEnd, whatIsWrong, suggestionsToImprove).
 */

const FEATURE_LABELS = {
    hook: 'hook',
    caption: 'caption',
    pacing: 'pacing',
    audio: 'audio',
    views_predictor: 'views_predictor',
    advanced_analytics: 'advanced_analytics'
};

const FEEDBACK_SEVERITIES = new Set(['critical', 'important', 'minor']);

function getFeatureScore(analysisArray, featureName) {
    const entry = (analysisArray || []).find((a) => a.feature === featureName);
    return entry?.score ?? null;
}

function getFeatureEntry(analysisArray, featureName) {
    const entry = (analysisArray || []).find((a) => a.feature === featureName);
    if (!entry) return null;
    return {
        score: entry.score ?? null,
        rating: entry.rating ?? null,
        feedback: entry.feedback ?? null,
        suggestions: Array.isArray(entry.suggestions) ? entry.suggestions : [],
    };
}

function mapCategoryToFeature(category) {
    const c = (category || '').toLowerCase();
    if (FEATURE_LABELS[c]) return c;
    if (c === 'visual' || c === 'engagement' || c === 'cta') return 'advanced_analytics';
    return 'advanced_analytics';
}

/**
 * Map timestampFeedback entry to slash-doc FeedbackItem
 */
function toFeedbackItem(f) {
    const sev = f.severity && FEEDBACK_SEVERITIES.has(f.severity) ? f.severity : 'minor';
    return {
        feature: mapCategoryToFeature(f.category),
        whatIsWrong: f.issue || '',
        suggestionsToImprove: f.suggestion ? [f.suggestion].concat(f.example ? [f.example] : []) : [],
        timestampStart: f.timestamp,
        timestampEnd: f.endTimestamp,
        severity: sev,
    };
}

/**
 * Build VideoAnalysis object from video document
 */
export function buildVideoAnalysisDTO(video) {
    if (!video) return null;

    const analysis = video.analysis || [];
    const hookEntry = analysis.find(a => a.feature === 'hook');
    const pacingEntry = analysis.find(a => a.feature === 'pacing');
    const audioEntry = analysis.find(a => a.feature === 'audio');
    const captionEntry = analysis.find(a => a.feature === 'caption');

    const score = (entry) => (entry && entry.score != null) ? entry.score : null;

    const dto = {
        viralityScore: video.viralityScore ?? 0,
        hookScore: score(hookEntry) ?? 0,
        pacingScore: score(pacingEntry) ?? 0,
        audioScore: score(audioEntry) ?? 0,
        captionClarityScore: score(captionEntry) ?? 0,
        hookSwipeRate: 0,
        predictedViewsLow: video.predictedViewsLow ?? 0,
        predictedViewsHigh: video.predictedViewsHigh ?? 0,
        predictedViewsExpected: video.predictedViewsExpected ?? 0,
        retentionCurve: Array.isArray(video.retentionCurve) ? video.retentionCurve : [],
        feedbackItems: (video.timestampFeedback || []).map(toFeedbackItem),
        scores: {
            virality: video.viralityScore ?? null,
            hook: getFeatureScore(analysis, 'hook'),
            pacing: getFeatureScore(analysis, 'pacing'),
            audio: getFeatureScore(analysis, 'audio'),
            caption: getFeatureScore(analysis, 'caption'),
            viewsPredictor: getFeatureScore(analysis, 'views_predictor'),
        },
        predictedViews: {
            low: video.predictedViewsLow ?? null,
            expected: video.predictedViewsExpected ?? null,
            high: video.predictedViewsHigh ?? null,
        },
        features: {
            hook: getFeatureEntry(analysis, 'hook'),
            pacing: getFeatureEntry(analysis, 'pacing'),
            audio: getFeatureEntry(analysis, 'audio'),
            caption: getFeatureEntry(analysis, 'caption'),
            viewsPredictor: getFeatureEntry(analysis, 'views_predictor'),
            advanced: getFeatureEntry(analysis, 'advanced_analytics'),
        },
    };

    return dto;
}

/**
 * Build full video response with analysis DTO for GET /videos/:videoId
 */
export function buildVideoWithAnalysisResponse(video) {
    if (!video) return null;
    const doc = video.toObject ? video.toObject() : video;
    return {
        ...doc,
        id: doc._id?.toString(),
        analysis: buildVideoAnalysisDTO(doc)
    };
}
