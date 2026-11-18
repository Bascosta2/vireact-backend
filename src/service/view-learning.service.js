/**
 * Database side of the views learning loop (math in view-learning.js).
 *
 * getLearnedModel() returns the current model. It refits when the set of reported results changed
 * (count or newest report time), at most once per CHECK_MS, and immediately after markLearningStale()
 * (called whenever a creator logs, removes or dates a result). Each fit is stored as a new
 * PredictionModel version, so the history shows how accuracy moves as results come in.
 * Never throws: on any failure predictions fall back to the base rules.
 */
import { Video } from '../model/video.model.js';
import { PredictionModel } from '../model/prediction-model.model.js';
import { ANALYSIS_STATUS } from '../constants.js';
import { displayViewBand } from './view-prediction.service.js';
import { LEARNING, fitLearnedModel, residualOf, scoreBandOf } from './view-learning.js';

export const CHECK_MS = 10 * 60 * 1000;
const MAX_ROWS = 5000;
const KEEP_VERSIONS = 200;

const REPORTED = { actualViews: { $gte: 0 }, viralityScore: { $ne: null }, analysisStatus: ANALYSIS_STATUS.COMPLETED };

let cache = { model: null, checkedAt: 0 };

/** Next getLearnedModel() call checks for new results right away. */
export const markLearningStale = () => {
    cache = { ...cache, checkedAt: 0 };
};

/** Tests only. */
export const resetLearningCache = () => {
    cache = { model: null, checkedAt: 0 };
};

const time = (d) => (d ? new Date(d).getTime() : NaN);

const latestCapture = (video) => {
    const snaps = video.performanceSnapshots ?? [];
    const latest = snaps.reduce((best, s) => (!best || time(s.capturedAt) > time(best.capturedAt) ? s : best), null);
    return latest?.capturedAt ?? video.actualViewsReportedAt ?? null;
};

/** One reported video as a learning observation, or null when it can't be used yet. */
export const toObservation = (video) => {
    const actual = video.actualViews;
    if (!Number.isFinite(actual) || actual < 0) return null;
    const capturedAt = latestCapture(video);
    const start = video.postedAt ?? video.createdAt;
    // Views logged within two days of posting are still climbing.
    if (!capturedAt || !start || time(capturedAt) - time(start) < LEARNING.SETTLE_MS) return null;
    const base = video.viewBase?.expected ?? displayViewBand(video)?.expected;
    if (!Number.isFinite(base) || base < 0) return null;
    return {
        userId: String(video.uploader_id ?? ''),
        at: new Date(capturedAt),
        platform: video.creatorPlatform || null,
        scoreBand: scoreBandOf(video.viralityScore),
        followers: Number(video.creatorFollowers) > 0,
        residual: residualOf(actual, base),
    };
};

const FIELDS = [
    'uploader_id', 'viralityScore', 'creatorPlatform', 'creatorFollowers', 'postedAt', 'createdAt',
    'actualViews', 'actualViewsReportedAt', 'performanceSnapshots.capturedAt',
    'predictedViewsLow', 'predictedViewsExpected', 'predictedViewsHigh', 'viewPredictionMethod', 'viewBase', 'viewLearning',
    'duration', 'analysis.feature', 'analysis.score', 'scenes.startTime', 'scenes.endTime', 'scenes.audioSummary',
    'scenes.visualDescription', 'scenes.primaryAction',
].join(' ');

export const loadObservations = async () => {
    const rows = await Video.find(REPORTED).select(FIELDS).sort({ actualViewsReportedAt: -1 }).limit(MAX_ROWS).lean();
    return rows.map(toObservation).filter(Boolean);
};

const reportSignature = async () => {
    const [count, newest] = await Promise.all([
        Video.countDocuments(REPORTED),
        Video.findOne(REPORTED).sort({ actualViewsReportedAt: -1 }).select('actualViewsReportedAt').lean(),
    ]);
    return `${count}:${newest?.actualViewsReportedAt ? new Date(newest.actualViewsReportedAt).toISOString() : '-'}`;
};

/** Fit and store a new version now. Returns the stored model (plain object). */
export const refitLearnedModel = async ({ signature, now = new Date() } = {}) => {
    const sig = signature ?? (await reportSignature());
    const fit = fitLearnedModel(await loadObservations());
    const latest = await PredictionModel.findOne().sort({ version: -1 }).select('version').lean();
    const version = (latest?.version ?? 0) + 1;
    try {
        const doc = await PredictionModel.create({ ...fit, version, fittedAt: now, signature: sig });
        await PredictionModel.deleteMany({ version: { $lte: version - KEEP_VERSIONS } });
        const m = fit.metrics;
        console.log(
            `[ViewLearning] v${version}: ${fit.observations} results from ${fit.users} creators, ` +
            `global x${Math.exp(fit.global?.mu ?? 0).toFixed(2)}, ${fit.enabled ? 'on' : 'off'}` +
            (m ? `; holdout typical miss ${m.baseTypicalMiss}x -> ${m.modelTypicalMiss}x` : '')
        );
        return doc.toObject();
    } catch (err) {
        // Another instance fitted the same version at the same moment: use theirs.
        if (err?.code === 11000) return PredictionModel.findOne().sort({ version: -1 }).lean();
        throw err;
    }
};

/** The model to apply to new predictions (null = none yet, use the base rules). */
export const getLearnedModel = async ({ now = Date.now() } = {}) => {
    if (cache.checkedAt && now - cache.checkedAt < CHECK_MS) return cache.model;
    try {
        const [signature, latest] = await Promise.all([reportSignature(), PredictionModel.findOne().sort({ version: -1 }).lean()]);
        const model = latest && latest.signature === signature ? latest : await refitLearnedModel({ signature });
        cache = { model, checkedAt: now };
        return model;
    } catch (err) {
        console.warn(`[ViewLearning] Using the last model (or base rules): ${err.message}`);
        cache = { ...cache, checkedAt: now };
        return cache.model;
    }
};

/** Admin view: the model in use and how accuracy moved over the last fits. */
export const learningReport = async ({ limit = 20 } = {}) => {
    const history = await PredictionModel.find()
        .sort({ version: -1 })
        .limit(Math.min(200, Math.max(1, limit)))
        .select('version fittedAt observations users enabled global metrics')
        .lean();
    const current = await PredictionModel.findOne().sort({ version: -1 }).lean();
    return { current, history };
};
