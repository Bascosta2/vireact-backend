import { Video } from '../model/video.model.js';
import { ApiError } from '../utils/ApiError.js';
import { allowedFeaturesForPlan } from '../constants.js';
import {
    severityToLegacy,
    legacyToSeverity,
    formatTimecode,
} from './analyzer/feedback-schema.js';

/**
 * Frame-level feedback reader for GET /videos/:videoId/feedback.
 *
 * CHANGED: 2026-09 — this service no longer GENERATES feedback. The six analyzers
 * author `Video.timestampFeedback` under OpenAI structured outputs during the
 * QStash analysis job, so generating a second, heuristic set here would compete
 * with them and reintroduce exactly the vague prose the new schema removes.
 *
 * Reads in this order:
 *  1. `timestampFeedback` (FrameFeedback) when present.
 *  2. `timestampFeedbackLegacy` (pre-2026-09 prose), adapted read-only so
 *     historical videos keep rendering without a bulk re-analysis.
 *
 * Plan gating: items authored by `advanced_analytics` are stripped for plans that
 * cannot see Advanced Analytics, matching the `features.advanced` / `scores.advanced`
 * behaviour in `video-analysis-dto.service.js`.
 */

/** Present a stored FrameFeedback item, with legacy aliases for existing consumers. */
const toFeedbackResponseItem = (item) => ({
    id: item.id,
    tStart: item.tStart,
    tEnd: item.tEnd,
    tStartLabel: formatTimecode(item.tStart),
    tEndLabel: formatTimecode(item.tEnd),
    category: item.category,
    severity: item.severity,
    severityLabel: severityToLegacy(item.severity),
    sourceFeature: item.sourceFeature,
    observed: item.observed,
    issue: item.issue,
    fix: {
        type: item.fix?.type ?? null,
        before: item.fix?.before ?? null,
        after: item.fix?.after ?? '',
    },
    expectedImpact: item.expectedImpact ?? null,
    sourceConfidence: item.sourceConfidence ?? null,
    isLegacy: false,
});

/**
 * Adapt a pre-2026-09 prose entry. `fix.after` carries the old `suggestion` so the
 * UI has something to render, and `isLegacy` lets it be labelled as not
 * frame-verified rather than presented as a literal drop-in fix.
 */
const toLegacyResponseItem = (item, index) => {
    const tStart = item.timestamp ?? 0;
    const tEnd = item.endTimestamp ?? tStart;
    return {
        id: `legacy_${String(index + 1).padStart(4, '0')}`,
        tStart,
        tEnd,
        tStartLabel: formatTimecode(tStart),
        tEndLabel: formatTimecode(tEnd),
        category: item.category ?? 'visual',
        severity: legacyToSeverity(item.severity),
        severityLabel: item.severity ?? 'minor',
        sourceFeature: null,
        observed: item.issue ?? '',
        issue: item.issue ?? '',
        fix: {
            type: null,
            before: null,
            after: item.suggestion ?? '',
        },
        expectedImpact: item.example ?? null,
        sourceConfidence: null,
        isLegacy: true,
    };
};

/**
 * @param {string} videoId
 * @param {string} userId Owner — feedback is scoped exactly like GET /videos/:videoId
 * @param {string} [userPlan] Requester's plan, for Advanced Analytics stripping
 */
export const getVideoFeedbackService = async (videoId, userId, userPlan) => {
    if (!videoId || !userId) {
        throw new ApiError(400, 'Video ID and User ID are required');
    }

    const video = await Video.findOne({ _id: videoId, uploader_id: userId })
        .select('timestampFeedback timestampFeedbackLegacy scriptRewrites analysisStatus')
        .lean();

    if (!video) {
        throw new ApiError(404, 'Video not found');
    }

    const allowed = allowedFeaturesForPlan(userPlan);
    const canSeeAdvanced = allowed.includes('advanced_analytics');

    const stored = video.timestampFeedback || [];
    const usingLegacy = stored.length === 0 && (video.timestampFeedbackLegacy || []).length > 0;

    const feedback = usingLegacy
        ? (video.timestampFeedbackLegacy || []).map(toLegacyResponseItem)
        : stored
            .filter((item) => canSeeAdvanced || item.sourceFeature !== 'advanced_analytics')
            .map(toFeedbackResponseItem);

    const scriptRewrites = usingLegacy
        ? []
        : (video.scriptRewrites || [])
            .filter((item) => canSeeAdvanced || item.sourceFeature !== 'advanced_analytics')
            .map((item) => ({
                ...item,
                timestampLabel: formatTimecode(item.timestamp),
            }));

    const bySeverityLabel = (label) => feedback.filter((f) => f.severityLabel === label).length;

    return {
        videoId: String(videoId),
        feedback,
        scriptRewrites,
        totalIssues: feedback.length,
        criticalIssues: bySeverityLabel('critical'),
        importantIssues: bySeverityLabel('important'),
        minorIssues: bySeverityLabel('minor'),
        isLegacyFeedback: usingLegacy,
        summary: buildFeedbackSummary(feedback, usingLegacy),
    };
};

function buildFeedbackSummary(feedback, usingLegacy) {
    if (feedback.length === 0) {
        return 'No frame-level feedback is stored for this video yet. Re-analyze to generate it.';
    }

    const counts = [
        ['critical', feedback.filter((f) => f.severityLabel === 'critical').length],
        ['important', feedback.filter((f) => f.severityLabel === 'important').length],
        ['minor', feedback.filter((f) => f.severityLabel === 'minor').length],
    ]
        .filter(([, count]) => count > 0)
        .map(([label, count]) => `${count} ${label}`);

    const prefix = `Found ${counts.join(', ')} issue${feedback.length === 1 ? '' : 's'}`;
    return usingLegacy
        ? `${prefix}. This video was analyzed before frame-level fixes shipped — re-analyze for literal fixes at each timestamp.`
        : `${prefix}, each with a timestamp and a drop-in fix.`;
}
