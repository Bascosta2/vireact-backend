import { allowedFeaturesForPlan } from '../constants.js';
import { calibrateViewBand } from './view-calibration.js';
import {
    severityToLegacy,
    legacyToSeverity,
    formatTimecode,
} from './analyzer/feedback-schema.js';

/**
 * Build VideoAnalysis DTO from Video document (slash-doc shape).
 * Maps analysis[], scenes, timestampFeedback, viralityScore, view bands, retentionCurve
 * and normalizes timestampFeedback to FeedbackItem (timestampStart, timestampEnd, whatIsWrong, suggestionsToImprove).
 *
 * For GET /api/v1/videos/:videoId, `userPlan` is the requester’s current plan. When the plan is not allowed to
 * see Advanced Analytics (Free/Premium), `features.advanced` and `scores.advanced` are set to `null` in the
 * DTO even if legacy `analysis[]` still contains `advanced_analytics` (data remains in MongoDB; it reappears for Pro+).
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
        emotionalTriggers: Array.isArray(entry.emotionalTriggers) ? entry.emotionalTriggers : [],
        retentionDrivers: Array.isArray(entry.retentionDrivers) ? entry.retentionDrivers : [],
        psychologicalProfile: entry.psychologicalProfile ?? null,
        weakestMoment: entry.weakestMoment ?? null,
        analyzedAt: entry.analyzedAt ?? null,
    };
}

function mapCategoryToFeature(category) {
    const c = (category || '').toLowerCase();
    if (FEATURE_LABELS[c]) return c;
    if (c === 'visual' || c === 'engagement' || c === 'cta' || c === 'script') return 'advanced_analytics';
    return 'advanced_analytics';
}

/**
 * Map a FrameFeedback subdocument to the slash-doc FeedbackItem.
 *
 * CHANGED: 2026-09 — source is now frame-level. The documented keys
 * (`whatIsWrong`, `suggestionsToImprove`, `timestampStart/End`, string `severity`)
 * are preserved so existing consumers keep working; the frame-level fields
 * (`id`, `observed`, `fix`, `expectedImpact`, timecode labels) are additive.
 */
function toFeedbackItem(f) {
    const literalFix = f.fix?.after ? [f.fix.after] : [];
    return {
        // Documented contract
        feature: f.sourceFeature && FEATURE_LABELS[f.sourceFeature]
            ? f.sourceFeature
            : mapCategoryToFeature(f.category),
        whatIsWrong: f.issue || '',
        suggestionsToImprove: literalFix,
        timestampStart: f.tStart,
        timestampEnd: f.tEnd,
        severity: severityToLegacy(f.severity),

        // Frame-level additions
        id: f.id,
        category: f.category,
        severityLevel: f.severity,
        sourceFeature: f.sourceFeature ?? null,
        observed: f.observed || '',
        fix: {
            type: f.fix?.type ?? null,
            before: f.fix?.before ?? null,
            after: f.fix?.after ?? '',
        },
        expectedImpact: f.expectedImpact ?? null,
        sourceConfidence: f.sourceConfidence ?? null,
        timestampStartLabel: formatTimecode(f.tStart),
        timestampEndLabel: formatTimecode(f.tEnd),
        isLegacy: false,
    };
}

/**
 * Map a pre-2026-09 prose entry. Flagged `isLegacy` so the UI can present it as
 * directional rather than as a verified drop-in fix.
 */
function toLegacyFeedbackItem(f, index) {
    const sev = f.severity && FEEDBACK_SEVERITIES.has(f.severity) ? f.severity : 'minor';
    const tStart = f.timestamp ?? 0;
    const tEnd = f.endTimestamp ?? tStart;
    return {
        feature: mapCategoryToFeature(f.category),
        whatIsWrong: f.issue || '',
        suggestionsToImprove: f.suggestion ? [f.suggestion].concat(f.example ? [f.example] : []) : [],
        timestampStart: tStart,
        timestampEnd: tEnd,
        severity: sev,

        id: `legacy_${String(index + 1).padStart(4, '0')}`,
        category: f.category ?? 'visual',
        severityLevel: legacyToSeverity(sev),
        sourceFeature: null,
        observed: f.issue || '',
        fix: { type: null, before: null, after: f.suggestion || '' },
        expectedImpact: f.example ?? null,
        sourceConfidence: null,
        timestampStartLabel: formatTimecode(tStart),
        timestampEndLabel: formatTimecode(tEnd),
        isLegacy: true,
    };
}

/** Present a stored ScriptRewrite with a display timecode. */
function toScriptRewriteItem(r) {
    return {
        lineId: r.lineId,
        timestamp: r.timestamp,
        timestampLabel: formatTimecode(r.timestamp),
        originalTranscript: r.originalTranscript || '',
        rewrittenLine: r.rewrittenLine || '',
        rationale: r.rationale ?? null,
        deliveryNote: r.deliveryNote ?? null,
        sourceFeature: r.sourceFeature ?? null,
    };
}

/**
 * Build VideoAnalysis object from video document
 * @param {string} [userPlan] - Passed to plan-aware Advanced Analytics stripping; see file header.
 */
export function buildVideoAnalysisDTO(video, userPlan) {
    if (!video) return null;

    const analysis = video.analysis || [];
    const hookEntry = analysis.find(a => a.feature === 'hook');
    const pacingEntry = analysis.find(a => a.feature === 'pacing');
    const audioEntry = analysis.find(a => a.feature === 'audio');
    const captionEntry = analysis.find(a => a.feature === 'caption');

    const score = (entry) => (entry && entry.score != null) ? entry.score : null;

    const allowed = allowedFeaturesForPlan(userPlan);
    const canSeeAdvanced = allowed.includes('advanced_analytics');

    // Frame feedback, plan-gated by authoring analyzer. Advanced Analytics items
    // are stripped for Free/Premium exactly like `features.advanced` — without
    // this, Pro-only insight would leak through `feedbackItems`.
    const storedFeedback = (video.timestampFeedback || [])
        .filter((f) => canSeeAdvanced || f.sourceFeature !== 'advanced_analytics');
    const legacyFeedback = video.timestampFeedbackLegacy || [];
    const usingLegacyFeedback = (video.timestampFeedback || []).length === 0 && legacyFeedback.length > 0;

    const feedbackItems = usingLegacyFeedback
        ? legacyFeedback.map(toLegacyFeedbackItem)
        : storedFeedback.map(toFeedbackItem);

    const scriptRewrites = (video.scriptRewrites || [])
        .filter((r) => canSeeAdvanced || r.sourceFeature !== 'advanced_analytics')
        .map(toScriptRewriteItem);

    // Older reports were stored before the view ceiling existed; calibrate on read too.
    const views = calibrateViewBand(
        { low: video.predictedViewsLow, expected: video.predictedViewsExpected, high: video.predictedViewsHigh },
        video.viralityScore
    );

    const dto = {
        viralityScore: video.viralityScore ?? 0,
        hookScore: score(hookEntry) ?? 0,
        pacingScore: score(pacingEntry) ?? 0,
        audioScore: score(audioEntry) ?? 0,
        captionClarityScore: score(captionEntry) ?? 0,
        hookSwipeRate: 0,
        predictedViewsLow: views.low ?? 0,
        predictedViewsHigh: views.high ?? 0,
        predictedViewsExpected: views.expected ?? 0,
        retentionCurve: Array.isArray(video.retentionCurve) ? video.retentionCurve : [],
        feedbackItems,
        scriptRewrites,
        isLegacyFeedback: usingLegacyFeedback,
        scores: {
            virality: video.viralityScore ?? null,
            hook: getFeatureScore(analysis, 'hook'),
            pacing: getFeatureScore(analysis, 'pacing'),
            audio: getFeatureScore(analysis, 'audio'),
            caption: getFeatureScore(analysis, 'caption'),
            viewsPredictor: getFeatureScore(analysis, 'views_predictor'),
            advanced: getFeatureScore(analysis, 'advanced_analytics'),
        },
        predictedViews: {
            low: views.low,
            expected: views.expected,
            high: views.high,
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

    if (!canSeeAdvanced) {
        dto.features.advanced = null;
        dto.scores.advanced = null;
    }

    return dto;
}

/**
 * Build full video response with analysis DTO for GET /api/v1/videos/:videoId
 * @param {string} [userPlan] - Requesting user’s plan; forwarded to buildVideoAnalysisDTO
 */
export function buildVideoWithAnalysisResponse(video, userPlan) {
    if (!video) return null;
    const doc = video.toObject ? video.toObject() : video;
    // `timestampFeedbackLegacy` is surfaced only through `analysis.feedbackItems`
    // (flagged `isLegacy`), never as a second raw array on the video.
    const { lastError, lastErrorAt, timestampFeedbackLegacy, ...safeDoc } = doc;
    return {
        ...safeDoc,
        id: doc._id?.toString(),
        analysis: buildVideoAnalysisDTO(doc, userPlan)
    };
}
