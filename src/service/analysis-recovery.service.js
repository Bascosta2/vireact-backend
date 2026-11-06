/**
 * Recovery for analysis jobs that stopped without finishing.
 *
 * Why: the QStash webhook answers 200 before the work starts, so QStash never retries, and a Railway
 * deploy or crash kills jobs mid-run. Without this, those videos stay "processing" forever.
 *
 * - Running jobs write `analysisHeartbeatAt` every minute (see processVideoAnalysis).
 * - The sweeper re-queues a "processing" video whose heartbeat stopped, and a "queued" video QStash never
 *   delivered. After MAX_ATTEMPTS automatic retries the video fails with a message the user can act on.
 * - On shutdown, jobs still running on this instance are handed back to the queue (not counted as an
 *   attempt: a deploy is not the video's fault).
 *
 * Every state change is a conditional update on the status we read, so two instances never both grab
 * the same video.
 */
import { Video } from '../model/video.model.js';
import { ANALYSIS_STATUS } from '../constants.js';
import { publishVideoAnalysisJob } from '../queue/video.queue.js';
import { runningJobIds } from '../queue/analysis-runtime.js';
import { alertFailure } from './ops-monitoring.service.js';

export const RECOVERY = Object.freeze({
    heartbeatEveryMs: 60 * 1000,
    staleHeartbeatMs: 10 * 60 * 1000,
    stuckQueuedMs: 15 * 60 * 1000,
    maxAttempts: 2,
    lookbackMs: 7 * 24 * 60 * 60 * 1000,
    batchSize: 50,
});

export const RECOVERY_MESSAGES = Object.freeze({
    interruptedTwice: 'Analysis was interrupted twice. Press Re-analyze to try again.',
    tooOld: 'This analysis stopped and is too old to resume. Press Re-analyze or upload the video again.',
    noAsset: 'This video never reached Twelve Labs. Please upload it again.',
    queueFailed: 'Failed to queue analysis job. Please use Re-analyze.',
});

const jobPayload = (video) => ({
    videoId: String(video._id),
    twelveLabsVideoId: video.twelveLabsVideoId || null,
    twelveLabsAssetId: video.twelveLabsAssetId || null,
    userId: video.uploader_id ? String(video.uploader_id) : undefined,
});

/** Fail a video only if it is still in the status we saw. */
const failIfUnchanged = async (video, message, now) => {
    const result = await Video.updateOne(
        { _id: video._id, analysisStatus: video.analysisStatus, updatedAt: video.updatedAt },
        { $set: { analysisStatus: ANALYSIS_STATUS.FAILED, lastError: message, lastErrorAt: now, analysisHeartbeatAt: null } }
    );
    return result.modifiedCount === 1;
};

/**
 * Put one video back on the queue.
 * @param {object} video lean doc with _id, analysisStatus, updatedAt, ids
 * @param {{ countAttempt?: boolean, delaySeconds?: number, now?: Date, publish?: Function }} [options]
 * @returns {Promise<boolean>} true when this call re-queued it
 */
export const requeueVideo = async (video, { countAttempt = true, delaySeconds = 0, now = new Date(), publish = publishVideoAnalysisJob } = {}) => {
    const filter = { _id: video._id, analysisStatus: video.analysisStatus };
    if (video.updatedAt) filter.updatedAt = video.updatedAt;
    const update = { $set: { analysisStatus: ANALYSIS_STATUS.QUEUED, analysisHeartbeatAt: null, lastError: null, lastErrorAt: null } };
    if (countAttempt) update.$inc = { analysisAttempts: 1 };

    const claimed = await Video.findOneAndUpdate(filter, update, { new: true });
    if (!claimed) return false;

    try {
        await publish(jobPayload(claimed), { delaySeconds });
        return true;
    } catch (error) {
        console.error(`[Recovery] Could not re-queue video ${video._id}: ${error.message}`);
        await Video.updateOne(
            { _id: video._id, analysisStatus: ANALYSIS_STATUS.QUEUED },
            { $set: { analysisStatus: ANALYSIS_STATUS.FAILED, lastError: RECOVERY_MESSAGES.queueFailed, lastErrorAt: now } }
        );
        return false;
    }
};

/**
 * Decide what to do with one stuck video. Pure, so it is unit-tested.
 * @returns {'requeue'|'fail-attempts'|'fail-old'|'fail-no-asset'}
 */
export const recoveryActionFor = (video, now = new Date()) => {
    if (!video.twelveLabsAssetId && !video.twelveLabsVideoId) return 'fail-no-asset';
    const updated = video.updatedAt ? new Date(video.updatedAt).getTime() : 0;
    if (now.getTime() - updated > RECOVERY.lookbackMs) return 'fail-old';
    if ((video.analysisAttempts ?? 0) >= RECOVERY.maxAttempts) return 'fail-attempts';
    return 'requeue';
};

/** Mongo filter for videos that look abandoned at `now`. */
export const stuckVideosFilter = (now = new Date()) => {
    const staleHeartbeat = new Date(now.getTime() - RECOVERY.staleHeartbeatMs);
    const stuckSince = new Date(now.getTime() - RECOVERY.stuckQueuedMs);
    return {
        $or: [
            { analysisStatus: ANALYSIS_STATUS.PROCESSING, analysisHeartbeatAt: { $lt: staleHeartbeat } },
            // Jobs started before heartbeats existed, or that died before the first beat.
            { analysisStatus: ANALYSIS_STATUS.PROCESSING, analysisHeartbeatAt: null, updatedAt: { $lt: stuckSince } },
            // QStash never delivered (or every delivery hit a server that was shutting down).
            { analysisStatus: ANALYSIS_STATUS.QUEUED, updatedAt: { $lt: stuckSince } },
        ],
    };
};

/**
 * One sweep. Safe to run on every instance at the same time.
 * @returns {Promise<{ checked: number, requeued: number, failed: number, skipped: number }>}
 */
export const sweepStuckAnalyses = async ({ now = new Date(), skipIds = runningJobIds(), publish = publishVideoAnalysisJob } = {}) => {
    const skip = new Set(skipIds.map(String));
    const candidates = await Video.find(stuckVideosFilter(now))
        .select('_id analysisStatus analysisAttempts updatedAt twelveLabsAssetId twelveLabsVideoId uploader_id')
        .sort({ updatedAt: 1 })
        .limit(RECOVERY.batchSize)
        .lean();

    const summary = { checked: candidates.length, requeued: 0, failed: 0, skipped: 0 };
    for (const video of candidates) {
        if (skip.has(String(video._id))) {
            summary.skipped++;
            continue;
        }
        const action = recoveryActionFor(video, now);
        if (action === 'requeue') {
            if (await requeueVideo(video, { countAttempt: true, now, publish })) summary.requeued++;
            else summary.skipped++;
            continue;
        }
        const message =
            action === 'fail-attempts' ? RECOVERY_MESSAGES.interruptedTwice
            : action === 'fail-old' ? RECOVERY_MESSAGES.tooOld
            : RECOVERY_MESSAGES.noAsset;
        if (await failIfUnchanged(video, message, now)) {
            summary.failed++;
            void alertFailure({ stage: 'recovery', videoId: String(video._id), userId: video.uploader_id ? String(video.uploader_id) : undefined, error: new Error(message) });
        } else {
            summary.skipped++;
        }
    }

    if (summary.requeued || summary.failed) {
        console.log(`[Recovery] Sweep: ${JSON.stringify(summary)}`);
    }
    return summary;
};

/**
 * On shutdown: hand every job still running here back to the queue, delayed so this instance has
 * time to finish it first (a finished job's final save wins; the delayed message then finds it done).
 * @returns {Promise<number>} jobs handed off
 */
export const handOffRunningJobs = async ({ delaySeconds = 45 } = {}) => {
    let handed = 0;
    for (const videoId of runningJobIds()) {
        const video = await Video.findOne({ _id: videoId, analysisStatus: ANALYSIS_STATUS.PROCESSING })
            .select('_id analysisStatus updatedAt twelveLabsAssetId twelveLabsVideoId uploader_id')
            .lean();
        if (!video) continue;
        if (await requeueVideo(video, { countAttempt: false, delaySeconds })) handed++;
    }
    if (handed) console.log(`[Recovery] Handed ${handed} running job(s) back to the queue before shutdown`);
    return handed;
};

/** Heartbeat for a running job. Returns a stop function. */
export const startHeartbeat = (videoId) => {
    const beat = () =>
        Video.updateOne(
            { _id: videoId, analysisStatus: ANALYSIS_STATUS.PROCESSING },
            { $set: { analysisHeartbeatAt: new Date() } }
        ).catch((error) => console.warn(`[Recovery] Heartbeat failed for ${videoId}: ${error.message}`));
    void beat();
    const timer = setInterval(beat, RECOVERY.heartbeatEveryMs);
    timer.unref?.();
    return () => clearInterval(timer);
};
