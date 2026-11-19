/**
 * Learning engine, database side (docs/learning-engine/PLAN.md). Phase 0 foundations + collection:
 *
 *   - keep VideoFeatures / OutcomeSnapshot in step with users' videos (hooks in the analysis job and
 *     the performance service; failures there never affect the user request)
 *   - backfill existing videos and admin examples
 *   - data inventory (how much labelled data we have, by source, platform and niche)
 *   - report card for today's predictions vs real results (and the rules-only base, to show what the
 *     learning loop adds)
 *   - the daily job: backfill -> collect (when a provider is configured) -> label -> inventory -> report
 *
 * Settings (Railway):
 *   LEARNING_ENABLED=true        the daily job runs (otherwise the webhook answers 503)
 *   LEARNING_PROVIDER=<name>     public data provider adapter (social/providers.js); unset = no collection
 *   LEARNING_DAILY_RECORDS=2000  provider records per day (spending cap)
 *   LEARNING_LABEL_LIMIT=300     videos labelled by the classifier per day
 *   LEARNING_DEEP_DAILY=60       public videos deep-analyzed per day (Twelve Labs + measured cuts); 0 = off
 *   LEARNING_DEEP_CONCURRENCY=3  deep analyses at once (Twelve Labs is shared with users' uploads)
 *   LEARNING_DEEP_MAX_SEC=180    longest public video worth analyzing
 */
import mongoose from 'mongoose';
import { Video } from '../../model/video.model.js';
import { User } from '../../model/user.model.js';
import { VideoPerformanceDataset } from '../../model/VideoPerformanceDataset.model.js';
import { VideoFeatures, OutcomeSnapshot, SocialCreator, SocialVideo, SocialVideoAnalysis, LearningRun } from '../../model/learning.model.js';
import { runDeepAnalysis, isDeepRunning } from './deep-analyzer.js';
import { factorReport } from './deep-features.js';
import { ANALYSIS_STATUS } from '../../constants.js';
import { TAXONOMY_VERSION, isNiche } from '../../constants/taxonomy.js';
import { FEATURE_VERSION, featuresFromVideo, featuresFromDataset } from './features.js';
import { ageHoursAt, SETTLE_HOURS } from './labels.js';
import { metrics, metricsBy, timeSplit, checkOwnerCases } from './evaluate.js';
import { getProvider } from './social/providers.js';
import './social/brightdata.js'; // registers LEARNING_PROVIDER=brightdata
import { runCollection, TRACK_SHARE } from './social/collector.js';
import { labelPending } from './classifier.js';

export const MILESTONES = Object.freeze([
    { at: 300, unlocks: 'Trained model runs in shadow; benchmarks for the biggest niches' },
    { at: 1000, unlocks: 'Trained model can take over; reliable per-feature explanations' },
    { at: 5000, unlocks: 'Sub-niche benchmarks; 24-hour to 7-day projections' },
    { at: 50000, unlocks: 'Similar-video lookup; region and language effects' },
]);

const intEnv = (name, fallback, env = process.env) => {
    const n = Number(env[name]);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};
/** A 0..1 share from the environment; unset, empty or out of range -> fallback. */
const shareEnv = (name, fallback, env = process.env) => {
    const raw = String(env[name] ?? '').trim();
    const n = Number(raw);
    return raw !== '' && Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
};

export const learningConfig = (env = process.env) => ({
    enabled: String(env.LEARNING_ENABLED ?? '').trim().toLowerCase() === 'true',
    provider: String(env.LEARNING_PROVIDER ?? '').trim().toLowerCase() || null,
    dailyRecords: intEnv('LEARNING_DAILY_RECORDS', 2000, env),
    // ~1,800 public videos arrive a day; 2,000 keeps labelling ahead of collection (one small call per 25).
    labelLimit: intEnv('LEARNING_LABEL_LIMIT', 2000, env),
    trackShare: shareEnv('LEARNING_TRACK_SHARE', TRACK_SHARE, env),
    deepDaily: intEnv('LEARNING_DEEP_DAILY', 60, env),
    deepConcurrency: Math.max(1, Math.min(6, intEnv('LEARNING_DEEP_CONCURRENCY', 3, env))),
    deepMaxSec: Math.max(10, intEnv('LEARNING_DEEP_MAX_SEC', 180, env)),
});

// ---- users' videos

const userNicheCache = new Map();
const nicheOfUser = async (userId) => {
    const key = String(userId);
    if (userNicheCache.has(key)) return userNicheCache.get(key);
    const user = await User.findById(userId).select('creatorProfile.niche onboarding.answers.niche').lean();
    const niche = [user?.creatorProfile?.niche, user?.onboarding?.answers?.niche].find(isNiche) ?? null;
    if (userNicheCache.size > 5000) userNicheCache.clear();
    userNicheCache.set(key, niche);
    return niche;
};

/** Upsert the features of one analyzed upload. Keeps an existing AI/admin label. */
export const upsertVideoFeatures = async (video) => {
    if (!video?._id || video.analysisStatus !== ANALYSIS_STATUS.COMPLETED) return null;
    const userId = video.uploader_id ?? null;
    const existing = await VideoFeatures.findOne({ subjectType: 'video', subjectId: video._id }).select('labelSource').lean();
    const set = {
        userId,
        creatorKey: userId ? `user:${userId}` : null,
        platform: video.creatorPlatform ?? null,
        featureVersion: FEATURE_VERSION,
        features: featuresFromVideo(video),
        followers: Number.isFinite(video.creatorFollowers) ? video.creatorFollowers : null,
        postedAt: video.postedAt ?? null,
        extractedAt: new Date(),
    };
    if (!existing || !['ai', 'admin'].includes(existing.labelSource)) {
        const niche = userId ? await nicheOfUser(userId) : null;
        if (niche) Object.assign(set, { niche, labelSource: 'creator_profile' });
    }
    await VideoFeatures.updateOne({ subjectType: 'video', subjectId: video._id }, { $set: set }, { upsert: true });
    return set;
};

/** Mirror a video's performanceSnapshots into OutcomeSnapshot (idempotent; removes deleted ones). */
export const syncUserOutcomes = async (video) => {
    if (!video?._id) return 0;
    const snaps = video.performanceSnapshots ?? [];
    const refs = snaps.map((s) => `perf:${s._id}`);
    await OutcomeSnapshot.deleteMany({ subjectType: 'video', subjectId: video._id, sourceRef: { $nin: refs } });
    if (!snaps.length) return 0;
    const creatorKey = video.uploader_id ? `user:${video.uploader_id}` : null;
    await OutcomeSnapshot.bulkWrite(snaps.map((s) => ({
        updateOne: {
            filter: { subjectType: 'video', subjectId: video._id, sourceRef: `perf:${s._id}` },
            update: {
                $set: {
                    creatorKey, platform: video.creatorPlatform ?? null, capturedAt: s.capturedAt,
                    ageHours: ageHoursAt(video.postedAt, s.capturedAt), views: s.views, likes: s.likes ?? null,
                    comments: s.comments ?? null, shares: s.shares ?? null, saves: s.saves ?? null,
                    followers: Number.isFinite(video.creatorFollowers) ? video.creatorFollowers : null,
                    source: !s.source || s.source === 'manual' ? 'user_reported' : 'api_verified',
                },
            },
            upsert: true,
        },
    })), { ordered: false });
    return snaps.length;
};

/** Fire-and-forget hooks for the request paths: a learning failure never fails the user's action. */
export const onVideoAnalyzed = (video) => {
    Promise.resolve()
        .then(() => upsertVideoFeatures(video))
        .then(() => syncUserOutcomes(video))
        .catch((error) => console.warn(`[learning] features for ${video?._id} skipped: ${error.message}`));
};
export const onPerformanceChanged = (video) => {
    Promise.resolve()
        .then(async () => {
            await syncUserOutcomes(video);
            await VideoFeatures.updateOne({ subjectType: 'video', subjectId: video._id }, { $set: { postedAt: video.postedAt ?? null, platform: video.creatorPlatform ?? null } });
        })
        .catch((error) => console.warn(`[learning] outcomes for ${video?._id} skipped: ${error.message}`));
};
export const removeVideoLearningData = async (videoId) => {
    if (!mongoose.isValidObjectId(videoId)) return;
    await Promise.all([
        VideoFeatures.deleteMany({ subjectType: 'video', subjectId: videoId }),
        OutcomeSnapshot.deleteMany({ subjectType: 'video', subjectId: videoId }),
    ]);
};

// ---- backfill

const VIDEO_FIELDS = 'uploader_id analysisStatus creatorPlatform creatorFollowers postedAt duration scenes rawTranscript analysis viralityScore sourceDescription contentProfile performanceSnapshots';

/**
 * Features + outcomes for completed uploads and admin examples that are missing or outdated.
 * `limit` per source per run (the daily job catches up over several days if needed).
 */
export const backfillLearning = async ({ limit = 500 } = {}) => {
    const done = await VideoFeatures.find({ subjectType: { $in: ['video', 'dataset'] }, featureVersion: FEATURE_VERSION })
        .select('subjectId').lean();
    const have = done.map((d) => d.subjectId);
    const videos = await Video.find({ analysisStatus: ANALYSIS_STATUS.COMPLETED, _id: { $nin: have } })
        .sort({ createdAt: -1 }).limit(limit).select(VIDEO_FIELDS).lean();
    let videoCount = 0;
    for (const video of videos) {
        await upsertVideoFeatures(video);
        await syncUserOutcomes(video);
        videoCount += 1;
    }
    const examples = await VideoPerformanceDataset.find({ status: 'complete', _id: { $nin: have } })
        .sort({ createdAt: -1 }).limit(limit).lean();
    let datasetCount = 0;
    for (const doc of examples) {
        const creatorKey = doc.creatorHandle ? `handle:${doc.platform}:${String(doc.creatorHandle).toLowerCase().replace(/^@/, '')}` : null;
        const followers = Number.isFinite(doc.followers) ? doc.followers : Number.isFinite(doc.subscriberCount) ? doc.subscriberCount : null;
        const set = {
            creatorKey, platform: doc.platform, featureVersion: FEATURE_VERSION, features: featuresFromDataset(doc),
            followers, postedAt: doc.postedAt ?? null, extractedAt: new Date(),
        };
        if (isNiche(doc.niche)) Object.assign(set, { niche: doc.niche, labelSource: 'admin', taxonomyVersion: TAXONOMY_VERSION });
        await VideoFeatures.updateOne({ subjectType: 'dataset', subjectId: doc._id }, { $set: set }, { upsert: true });
        if (Number.isFinite(doc.actualViews)) {
            const capturedAt = doc.analyzedAt ?? doc.ingestedAt ?? doc.createdAt ?? new Date();
            await OutcomeSnapshot.updateOne(
                { subjectType: 'dataset', subjectId: doc._id, sourceRef: 'dataset' },
                {
                    $set: {
                        creatorKey, platform: doc.platform, capturedAt, ageHours: ageHoursAt(doc.postedAt, capturedAt),
                        views: doc.actualViews, likes: doc.likes ?? null, comments: doc.comments ?? null, shares: doc.shares ?? null,
                        saves: doc.saves ?? null, followers, source: 'dataset',
                    },
                },
                { upsert: true },
            );
        }
        datasetCount += 1;
    }
    return { videos: videoCount, dataset: datasetCount };
};

// ---- inventory

/** Subjects with at least one usable (settled, or age unknown) outcome, by source. */
export const dataInventory = async () => {
    const settled = { $or: [{ ageHours: null }, { ageHours: { $gte: SETTLE_HOURS } }] };
    const labelled = await OutcomeSnapshot.aggregate([
        { $match: settled },
        { $group: { _id: { t: '$subjectType', s: '$subjectId' }, platform: { $first: '$platform' }, sources: { $addToSet: '$source' } } },
        { $group: { _id: '$_id.t', n: { $sum: 1 } } },
    ]);
    const bySubject = Object.fromEntries(labelled.map((r) => [r._id, r.n]));
    const totalLabelled = Object.values(bySubject).reduce((a, b) => a + b, 0);
    const [features, nicheRows, platformRows, creators, socialVideos, withBaseline] = await Promise.all([
        VideoFeatures.aggregate([{ $group: { _id: '$subjectType', n: { $sum: 1 } } }]),
        VideoFeatures.aggregate([{ $group: { _id: '$niche', n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
        OutcomeSnapshot.aggregate([{ $match: settled }, { $group: { _id: { p: '$platform', s: '$subjectId' } } }, { $group: { _id: '$_id.p', n: { $sum: 1 } } }]),
        SocialCreator.countDocuments({}),
        SocialVideo.countDocuments({}),
        SocialCreator.countDocuments({ baselineViews: { $ne: null } }),
    ]);
    const next = MILESTONES.find((m) => totalLabelled < m.at) ?? null;
    return {
        labelled: { total: totalLabelled, bySubject },
        features: Object.fromEntries(features.map((r) => [r._id, r.n])),
        byNiche: Object.fromEntries(nicheRows.map((r) => [r._id ?? 'unlabelled', r.n])),
        byPlatform: Object.fromEntries(platformRows.map((r) => [r._id ?? 'unknown', r.n])),
        social: { creators, videos: socialVideos, creatorsWithBaseline: withBaseline },
        nextMilestone: next ? { ...next, progress: Math.round((totalLabelled / next.at) * 1000) / 1000 } : null,
        milestones: MILESTONES,
    };
};

// ---- report card for today's predictions

/** Users' videos with a settled real result and a stored prediction. */
export const predictionRows = async () => {
    const videos = await Video.find({
        analysisStatus: ANALYSIS_STATUS.COMPLETED, actualViews: { $gte: 0 }, predictedViewsExpected: { $ne: null },
    }).select('actualViews actualViewsReportedAt postedAt creatorPlatform creatorFollowers predictedViewsLow predictedViewsExpected predictedViewsHigh viewBase viewLearning createdAt').lean();
    const rows = [];
    for (const v of videos) {
        const age = ageHoursAt(v.postedAt, v.actualViewsReportedAt);
        if (age != null && age < SETTLE_HOURS) continue;
        rows.push({
            at: v.actualViewsReportedAt ?? v.createdAt,
            actual: v.actualViews,
            platform: v.creatorPlatform ?? 'unknown',
            followersKnown: Number(v.creatorFollowers) > 0 ? 'yes' : 'no',
            predicted: { low: v.predictedViewsLow, expected: v.predictedViewsExpected, high: v.predictedViewsHigh },
            base: v.viewBase?.expected != null ? v.viewBase : null,
        });
    }
    return rows;
};

export const reportCard = async ({ now = Date.now() } = {}) => {
    const rows = await predictionRows();
    const { test } = timeSplit(rows, { testDays: 14, now });
    const withBase = rows.filter((r) => r.base);
    return {
        generatedAt: new Date(now),
        live: metrics(rows),
        last14Days: metrics(test),
        // Same videos, rules only (before the learning loop): shows what learning adds.
        rulesOnly: metrics(withBase.map((r) => ({ ...r, predicted: r.base }))),
        liveOnSameVideos: metrics(withBase),
        byPlatform: metricsBy(rows, 'platform'),
        byFollowersKnown: metricsBy(rows, 'followersKnown'),
        ownerCases: checkOwnerCases(),
    };
};

// ---- daily job

let running = false;
export const isLearningRunning = () => running;

export const runDailyLearning = async ({ now = Date.now(), config = learningConfig(), deps = {}, log = (l) => console.log(`[learning] ${l}`) } = {}) => {
    if (running) return { status: 'already_running' };
    running = true;
    const provider = (deps.getProvider ?? getProvider)();
    const run = await LearningRun.create({ startedAt: new Date(now), provider: provider?.name ?? null });
    const step = async (name, fn) => {
        const t0 = Date.now();
        try {
            const counts = await fn();
            run.steps.push({ name, ok: true, ms: Date.now() - t0, counts });
            return counts;
        } catch (error) {
            run.steps.push({ name, ok: false, ms: Date.now() - t0, detail: String(error.message).slice(0, 500) });
            log(`${name} failed: ${error.message}`);
            return null;
        }
    };
    try {
        await step('backfill', () => backfillLearning());
        const collected = await step('collect', () => (provider
            ? runCollection({ provider, budget: config.dailyRecords, trackShare: config.trackShare ?? TRACK_SHARE, now, log })
            : { skipped: 'no provider configured (LEARNING_PROVIDER)' }));
        run.recordsUsed = collected?.used ?? 0;
        const deep = await step('deep', () => (provider && config.deepDaily > 0
            ? runDeepAnalysis({ provider, limit: config.deepDaily, concurrency: config.deepConcurrency, maxDurationSec: config.deepMaxSec, now, deps: deps.deep, log })
            : { skipped: provider ? 'LEARNING_DEEP_DAILY=0' : 'no provider configured' }));
        run.recordsUsed += deep?.used ?? 0;
        await step('label', () => (config.labelLimit > 0 ? labelPending({ limit: config.labelLimit, complete: deps.complete, log }) : { skipped: 'LEARNING_LABEL_LIMIT=0' }));
        run.inventory = await step('inventory', () => dataInventory());
        run.reportCard = await step('report_card', () => reportCard({ now }));
        run.ok = run.steps.every((s) => s.ok);
    } finally {
        run.finishedAt = new Date();
        await run.save().catch((error) => log(`run record not saved: ${error.message}`));
        running = false;
    }
    return { status: 'done', runId: String(run._id), ok: run.ok };
};

// ---- deep analysis (owner console)

/** Counts, the hit-vs-miss factor report and the latest analyses. */
export const deepOverview = async () => {
    const [rows, failed, captions] = await Promise.all([
        SocialVideoAnalysis.find({}).select('creatorId role outperformance features cutsSource niche views baselineViews externalId analyzedAt media.durationSec').sort({ analyzedAt: -1 }).lean(),
        SocialVideo.countDocuments({ 'deep.status': 'failed' }),
        SocialVideo.countDocuments({ 'captions.0': { $exists: true } }),
    ]);
    const report = factorReport(rows);
    return {
        analyzed: rows.length,
        exactCuts: rows.filter((r) => r.cutsSource === 'ffmpeg').length,
        failed,
        withCaptions: captions,
        videoMinutes: Math.round(rows.reduce((s, r) => s + (Number(r.media?.durationSec) || 0), 0) / 6) / 10,
        running: isDeepRunning(),
        creatorsWithPairs: report.creatorsWithPairs,
        factors: report.factors.filter((f) => f.status !== 'too_few').slice(0, 40),
        recent: rows.slice(0, 25).map((r) => ({
            id: String(r._id), externalId: r.externalId, niche: r.niche, role: r.role, views: r.views, baselineViews: r.baselineViews,
            outperformance: r.outperformance, durationSec: r.media?.durationSec ?? null, shots: r.features?.shotCountExact ?? r.features?.sceneCount ?? null,
            cutsSource: r.cutsSource, analyzedAt: r.analyzedAt,
        })),
    };
};

/** One analysis with its video's public details, for the timeline view. */
export const deepDetail = async (id) => {
    if (!mongoose.isValidObjectId(id)) return null;
    const a = await SocialVideoAnalysis.findById(id).lean();
    if (!a) return null;
    const v = await SocialVideo.findById(a.socialVideoId).select('url caption hashtags soundTitle postedAt latest captions captionsLang topComments').lean();
    const creator = a.creatorId ? await SocialCreator.findById(a.creatorId).select('handle followers baselineViews baselineN niche').lean() : null;
    return { analysis: a, video: v, creator };
};

/** Starts a deep run now (owner console), in the background. */
export const startDeepRun = ({ limit = 10, config = learningConfig(), log = (l) => console.log(`[learning] ${l}`) } = {}) => {
    if (isDeepRunning() || running) return { status: 'already_running' };
    const provider = getProvider();
    if (!provider) return { status: 'no_provider' };
    const n = Math.max(2, Math.min(100, Math.floor(Number(limit) || 10)));
    (async () => {
        const run = await LearningRun.create({ kind: 'deep', startedAt: new Date(), provider: provider.name });
        const t0 = Date.now();
        try {
            const counts = await runDeepAnalysis({ provider, limit: n, concurrency: config.deepConcurrency, maxDurationSec: config.deepMaxSec, log });
            run.steps.push({ name: 'deep', ok: true, ms: Date.now() - t0, counts });
            run.recordsUsed = counts.used ?? 0;
            run.ok = true;
        } catch (error) {
            run.steps.push({ name: 'deep', ok: false, ms: Date.now() - t0, detail: String(error.message).slice(0, 500) });
            run.ok = false;
        } finally {
            run.finishedAt = new Date();
            await run.save().catch(() => {});
        }
    })().catch((error) => log(`deep run failed: ${error.message}`));
    return { status: 'started', limit: n };
};

/** For the owner console. */
export const learningOverview = async () => {
    const [inventory, card, runs, deep] = await Promise.all([
        dataInventory(),
        reportCard(),
        LearningRun.find({}).sort({ startedAt: -1 }).limit(10).select('kind startedAt finishedAt ok provider recordsUsed steps').lean(),
        deepOverview(),
    ]);
    const config = learningConfig();
    return {
        config: {
            enabled: config.enabled, provider: config.provider, dailyRecords: config.dailyRecords, labelLimit: config.labelLimit, trackShare: config.trackShare,
            deepDaily: config.deepDaily, deepConcurrency: config.deepConcurrency, deepMaxSec: config.deepMaxSec,
        },
        inventory, reportCard: card, runs, deep,
    };
};
