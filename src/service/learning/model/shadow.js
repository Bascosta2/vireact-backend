/**
 * The trained matrix engine in shadow (flag LEARNING_SHADOW_PREDICTIONS, default off).
 *
 *   1. Promotion: after each training run, the new model is scored on users' own videos with a real result,
 *      using out-of-fold predictions (the model never saw that creator), against the live prediction those
 *      users were shown. evaluate.js promotionDecision decides, with its own rules (enough results, a clearly
 *      smaller typical miss, band coverage 0.75-0.85, the owner's two real cases). A passing model gets status
 *      'shadow' and the previous shadow model is retired; a failing one stays 'candidate' and the previous
 *      shadow model keeps running.
 *   2. Shadow prediction: when an upload's analysis finishes (after its VideoFeatures are stored), the shadow
 *      model predicts its views and the result is stored on VideoFeatures.shadowPrediction, next to the live
 *      band the user saw. Users never see it. Any failure is logged and swallowed.
 *   3. Comparison: once real views arrive (OutcomeSnapshot: reported views and connected-account readings),
 *      compareShadow measures both predictions on the same videos, per platform (owner console).
 *
 * The model predicts a video's log deviation from its creator's usual, ln((views + 1) / (usual + 1)), the same
 * label the trainer uses. Served views = (usual + 1) x exp(prediction) - 1, where "usual" is the creator's median
 * of their other settled results (3+) or typicalViews(followers). The band comes from the spread of out-of-fold
 * errors in training (engine.js residualSpread). Only the ridge model is used (not the neural network).
 */
import { LearningModel, OutcomeSnapshot, VideoFeatures } from '../../../model/learning.model.js';
import { Video } from '../../../model/video.model.js';
import { captureError } from '../../ops-monitoring.service.js';
import { typicalViews } from '../../view-prediction.service.js';
import { OUTLIER_LOG } from '../deep-features.js';
import { checkOwnerCases, logError, metrics, promotionDecision } from '../evaluate.js';
import { baselineFor, outcomeAtHorizon } from '../labels.js';
import { creatorCentre, predictLogDeviation } from './engine.js';

export const MATRIX_KIND = 'matrix_engine';
export const SHADOW_STATUS = 'shadow';
const CACHE_MS = 10 * 60 * 1000;

export const shadowEnabled = (env = process.env) => String(env.LEARNING_SHADOW_PREDICTIONS ?? '').trim().toLowerCase() === 'true';

const round = (x, d = 4) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const clampLog = (x) => Math.max(-OUTLIER_LOG, Math.min(OUTLIER_LOG, x));
const ordered = (low, expected, high) => {
    const l = Math.max(0, Math.round(low));
    const e = Math.max(l, Math.round(expected));
    const h = Math.max(e, Math.round(high));
    return { low: l, expected: e, high: h };
};

/** The model inputs of a stored VideoFeatures row, exactly as the trainer builds them. */
export const rowFeatures = (vf) => ({
    ...(vf?.features ?? {}),
    ...(vf?.niche ? { niche: vf.niche } : {}),
    ...(vf?.format ? { format: vf.format } : {}),
    ...(vf?.hookPattern ? { hookPattern: vf.hookPattern } : {}),
});

/** What serving needs from a stored LearningModel (or a fresh engine result shaped like one). */
export const servingModel = (doc) => (doc ? {
    id: doc._id ? String(doc._id) : null,
    version: doc.version ?? null,
    spec: doc.standardization ?? null,
    beta: doc.coefficients?.beta ?? null,
    spread: doc.metrics?.spread ?? null,
} : null);

/** Views band from a creator's usual and a predicted log deviation, widened by the training spread. */
export const shadowBand = ({ baselineViews, logDeviation, spread }) => {
    if (!Number.isFinite(baselineViews) || baselineViews < 0 || !Number.isFinite(logDeviation)) return null;
    const at = (d) => Math.max(0, (baselineViews + 1) * Math.exp(clampLog(d)) - 1);
    const lo = Math.min(0, Number.isFinite(spread?.low) ? spread.low : 0);
    const hi = Math.max(0, Number.isFinite(spread?.high) ? spread.high : 0);
    return ordered(at(logDeviation + lo), at(logDeviation), at(logDeviation + hi));
};

/**
 * One shadow prediction. `centreFeatures` = the creator's other videos (their usual in feature space), used
 * only when the baseline is the creator's own median. Returns null when the model cannot score the video.
 */
export const shadowPredictionFor = ({ model, features, baseline, centreFeatures = [] }) => {
    if (!model?.spec || !baseline || !Number.isFinite(baseline.views)) return null;
    const centre = baseline.method === 'creator_median' ? creatorCentre(model.spec, centreFeatures) : null;
    const logDeviation = predictLogDeviation(model, features, { centre });
    const band = shadowBand({ baselineViews: baseline.views, logDeviation, spread: model.spread });
    if (!band) return null;
    return {
        modelId: model.id,
        modelVersion: model.version,
        ...band,
        logDeviation: round(logDeviation),
        baseline: { views: Math.round(baseline.views), method: baseline.method, n: baseline.n ?? 0 },
    };
};

// ---------------------------------------------------------------- promotion

/** The owner's calibration cases, asked of the model with only a score and a follower count. */
export const ownerCasePredictor = (model) => ({ viralityScore, followers }) => shadowBand({
    baselineViews: typicalViews(followers),
    logDeviation: predictLogDeviation(model, { viralityScore }),
    spread: model.spread,
}) ?? { low: null, expected: null, high: null };

/**
 * The promotion gate (pure). testRows: users' videos with a real result:
 *   { actual, baseline (creator's usual), pred (out-of-fold log deviation), champion: { low, expected, high } }
 * champion = the live prediction the user was shown; challenger = this model on the SAME videos.
 */
export const promotionCheck = ({ testRows = [], model }) => {
    const same = testRows.filter((r) => Number.isFinite(r?.actual) && Number.isFinite(r.pred) && Number.isFinite(r.baseline)
        && Number.isFinite(r.champion?.expected));
    const champion = metrics(same.map((r) => ({ actual: r.actual, predicted: r.champion })));
    const challenger = metrics(same.map((r) => ({ actual: r.actual, predicted: shadowBand({ baselineViews: r.baseline, logDeviation: r.pred, spread: model?.spread }) })));
    const ownerCases = checkOwnerCases(ownerCasePredictor(model ?? {}));
    return { ...promotionDecision({ champion, challenger, ownerCases }), champion, challenger, ownerCases };
};

let cache = { model: null, at: 0 };
/** Tests, and after a promotion. */
export const resetShadowCache = () => { cache = { model: null, at: 0 }; };

/**
 * Stores the decision on the new model. Passing: it becomes the shadow model and any earlier shadow model is
 * retired (promoted first, so there is never a moment without one). Failing: it stays 'candidate'.
 */
export const applyPromotion = async ({ id, check, now = Date.now(), kind = MATRIX_KIND, model = LearningModel }) => {
    const decision = {
        promote: check.promote, reasons: check.reasons, champion: check.champion, challenger: check.challenger,
        ownerCases: check.ownerCases, checkedAt: new Date(now),
    };
    if (!check.promote) {
        await model.updateOne({ _id: id }, { $set: { 'promotion.decision': decision } });
        return { status: 'candidate', ...decision };
    }
    await model.updateOne({ _id: id }, { $set: { status: SHADOW_STATUS, 'promotion.decision': decision, 'promotion.shadowSince': new Date(now) } });
    await model.updateMany({ kind, status: SHADOW_STATUS, _id: { $ne: id } }, { $set: { status: 'retired' } });
    resetShadowCache();
    return { status: SHADOW_STATUS, ...decision };
};

/** The live bands users were shown, by video id. */
const liveBands = async (ids) => {
    const videos = await Video.find({ _id: { $in: ids }, predictedViewsExpected: { $ne: null } })
        .select('predictedViewsLow predictedViewsExpected predictedViewsHigh').lean();
    return new Map(videos.map((v) => [String(v._id), { low: v.predictedViewsLow, expected: v.predictedViewsExpected, high: v.predictedViewsHigh }]));
};

/**
 * After a training run (trainer.js, flag on): score the new model on users' videos and apply the decision.
 * rows: the trainer's rows (users' rows carry `meta`); result: runEngine output with `evaluation`.
 */
export const promoteAfterTraining = async ({ id, result, rows, now = Date.now(), deps = {} }) => {
    const evaluated = (result.evaluation ?? []).map((e) => ({ ...rows[e.row]?.meta, pred: e.pred })).filter((r) => r.subjectId);
    const bands = await (deps.liveBands ?? liveBands)(evaluated.map((r) => r.subjectId));
    const testRows = evaluated.map((r) => ({ ...r, champion: bands.get(String(r.subjectId)) ?? null }));
    const model = servingModel({ _id: id, standardization: result.spec, coefficients: { beta: result.ridge?.beta }, metrics: { spread: result.spread } });
    return applyPromotion({ id, check: promotionCheck({ testRows, model }), now, model: deps.model ?? LearningModel });
};

// ---------------------------------------------------------------- shadow predictions

/** The current shadow model (cached CACHE_MS), or null. */
export const loadShadowModel = async ({ now = Date.now() } = {}) => {
    if (cache.at && now - cache.at < CACHE_MS) return cache.model;
    const doc = await LearningModel.findOne({ kind: MATRIX_KIND, status: SHADOW_STATUS }).sort({ version: -1 })
        .select('_id version standardization coefficients.beta metrics.spread').lean();
    cache = { model: servingModel(doc), at: now };
    return cache.model;
};

const bySubject = (snaps) => {
    const map = new Map();
    for (const s of snaps) {
        const k = String(s.subjectId);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(s);
    }
    return map;
};

/** The upload's features, the creator's usual and their other videos, from the stores the trainer reads. */
export const loadShadowInputs = async (video) => {
    const vf = await VideoFeatures.findOne({ subjectType: 'video', subjectId: video._id }).select('creatorKey features niche format hookPattern followers').lean();
    if (!vf) return { skipped: 'no features stored for this video' };
    const others = vf.creatorKey
        ? await VideoFeatures.find({ subjectType: 'video', creatorKey: vf.creatorKey, subjectId: { $ne: video._id } }).select('subjectId features niche format hookPattern').lean()
        : [];
    const snaps = others.length
        ? bySubject(await OutcomeSnapshot.find({ subjectType: 'video', subjectId: { $in: others.map((o) => o.subjectId) } }).select('subjectId views ageHours capturedAt source').lean())
        : new Map();
    const settled = others.map((o) => ({ o, out: outcomeAtHorizon(snaps.get(String(o.subjectId)) ?? []) })).filter((r) => r.out);
    return {
        features: rowFeatures(vf),
        baseline: baselineFor({ otherViews: settled.map((r) => r.out.views), followers: vf.followers }),
        centreFeatures: settled.map((r) => rowFeatures(r.o)),
    };
};

const saveShadow = (videoId, record) => VideoFeatures.updateOne({ subjectType: 'video', subjectId: videoId }, { $set: { shadowPrediction: record } });

/**
 * Hook for the end of an upload's analysis (learning.service.js onVideoAnalyzed). Flag off: returns at once.
 * Never throws and never changes the Video: the user's prediction is untouched.
 */
export const recordShadowPrediction = async (video, { env = process.env, now = new Date(), deps = {} } = {}) => {
    if (!shadowEnabled(env)) return { skipped: 'LEARNING_SHADOW_PREDICTIONS is off' };
    if (!video?._id) return { skipped: 'no video' };
    try {
        const model = await (deps.loadModel ?? loadShadowModel)();
        if (!model) return { skipped: 'no promoted model' };
        const inputs = await (deps.loadInputs ?? loadShadowInputs)(video);
        if (inputs.skipped) return inputs;
        if (!inputs.baseline) return { skipped: 'no follower count and too few past results for a baseline' };
        const prediction = shadowPredictionFor({ model, ...inputs });
        if (!prediction) return { skipped: 'the model could not score this video' };
        const record = {
            ...prediction,
            formula: { low: video.predictedViewsLow ?? null, expected: video.predictedViewsExpected ?? null, high: video.predictedViewsHigh ?? null },
            formulaMethod: video.viewPredictionMethod ?? null,
            platform: video.creatorPlatform ?? null,
            at: now,
        };
        await (deps.save ?? saveShadow)(video._id, record);
        return { recorded: record };
    } catch (error) {
        console.warn(`[learning] shadow prediction for ${video?._id} skipped: ${error.message}`);
        (deps.report ?? captureError)(error, { source: 'server', route: 'learning/shadow', videoId: video?._id });
        return { error: error.message };
    }
};

// ---------------------------------------------------------------- comparison

const usableBand = (b) => Number.isFinite(b?.expected);

/** Metrics for one side (evaluate.js metrics plus the mean |log error|). rows: { actual, predicted }. */
const sideMetrics = (rows) => {
    const m = metrics(rows);
    const abs = rows.map((r) => Math.abs(logError(r)));
    return { ...m, meanAbsLogError: abs.length ? round(abs.reduce((a, b) => a + b, 0) / abs.length, 3) : null };
};

const compareGroup = (rows) => {
    const shadowWins = rows.filter((r) => Math.abs(logError({ actual: r.actual, predicted: r.shadow })) < Math.abs(logError({ actual: r.actual, predicted: r.formula }))).length;
    return {
        n: rows.length,
        formula: sideMetrics(rows.map((r) => ({ actual: r.actual, predicted: r.formula }))),
        shadow: sideMetrics(rows.map((r) => ({ actual: r.actual, predicted: r.shadow }))),
        shadowCloser: rows.length ? round(shadowWins / rows.length, 3) : null,
    };
};

/**
 * Formula (what users saw) vs shadow on the same videos, overall and per platform. Pure.
 * rows: [{ platform, actual, formula: { low, expected, high }, shadow: { low, expected, high } }]
 * Per side: n, typicalMiss = exp(median |log error|), within2x, coverage (band hit rate), bias, meanAbsLogError.
 * shadowCloser = share of videos where the shadow's log error is smaller. Platforms need minN videos.
 */
export const compareShadow = (rows = [], { minN = 1 } = {}) => {
    const ok = rows.filter((r) => Number.isFinite(r?.actual) && r.actual >= 0 && usableBand(r.formula) && usableBand(r.shadow));
    const groups = new Map();
    for (const r of ok) {
        const k = r.platform || 'unknown';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
    }
    return {
        overall: compareGroup(ok),
        byPlatform: Object.fromEntries([...groups.entries()].filter(([, list]) => list.length >= minN)
            .sort((a, b) => b[1].length - a[1].length).map(([k, list]) => [k, compareGroup(list)])),
    };
};

/** Stored shadow records + outcome snapshots -> comparison rows (settled results only). Pure. */
export const shadowRows = (records = [], snapshots = []) => {
    const snaps = bySubject(snapshots);
    const rows = [];
    for (const r of records) {
        const s = r.shadowPrediction;
        const out = outcomeAtHorizon(snaps.get(String(r.subjectId)) ?? []);
        if (!s || !out) continue;
        rows.push({
            platform: s.platform ?? r.platform ?? 'unknown',
            modelVersion: s.modelVersion ?? null,
            actual: out.views,
            formula: s.formula,
            shadow: { low: s.low, expected: s.expected, high: s.high },
        });
    }
    return rows;
};

/** Owner console (read-only): formula vs shadow on every upload with a shadow prediction and a real result. */
export const shadowReport = async ({ env = process.env } = {}) => {
    const records = await VideoFeatures.find({ subjectType: 'video', 'shadowPrediction.expected': { $ne: null } })
        .select('subjectId platform shadowPrediction').lean();
    const snapshots = records.length
        ? await OutcomeSnapshot.find({ subjectType: 'video', subjectId: { $in: records.map((r) => r.subjectId) } }).select('subjectId views ageHours capturedAt source').lean()
        : [];
    const current = await LearningModel.findOne({ kind: MATRIX_KIND, status: SHADOW_STATUS }).sort({ version: -1 })
        .select('version trainedAt promotion.decision promotion.shadowSince').lean();
    const rows = shadowRows(records, snapshots);
    const versions = rows.reduce((m, r) => ({ ...m, [r.modelVersion ?? 'unknown']: (m[r.modelVersion ?? 'unknown'] ?? 0) + 1 }), {});
    return {
        enabled: shadowEnabled(env),
        model: current ? { version: current.version, trainedAt: current.trainedAt, shadowSince: current.promotion?.shadowSince ?? null, decision: current.promotion?.decision ?? null } : null,
        predictions: records.length,
        withResults: rows.length,
        byModelVersion: versions,
        ...compareShadow(rows),
    };
};
