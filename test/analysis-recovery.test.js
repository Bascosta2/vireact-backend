import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Video } from '../src/model/video.model.js';
import { ANALYSIS_STATUS } from '../src/constants.js';
import {
    RECOVERY,
    RECOVERY_MESSAGES,
    recoveryActionFor,
    stuckVideosFilter,
    sweepStuckAnalyses,
} from '../src/service/analysis-recovery.service.js';
import { markShuttingDown, resetAnalysisRuntimeForTests, trackJobStart, trackJobEnd, runningJobIds, waitForRunningJobs } from '../src/queue/analysis-runtime.js';
import { processVideoAnalysis } from '../src/controller/video.controller.js';

console.log = () => {};
console.warn = () => {};

const original = { find: Video.find, findOneAndUpdate: Video.findOneAndUpdate, updateOne: Video.updateOne };
afterEach(() => {
    Object.assign(Video, original);
    resetAnalysisRuntimeForTests();
});

const now = new Date('2026-11-06T12:00:00Z');
const minutesAgo = (m) => new Date(now.getTime() - m * 60 * 1000);

test('recovery decision: requeue, give up after two attempts, too old, or never reached Twelve Labs', () => {
    const base = { twelveLabsAssetId: 'a', updatedAt: minutesAgo(30), analysisAttempts: 0 };
    assert.equal(recoveryActionFor(base, now), 'requeue');
    assert.equal(recoveryActionFor({ ...base, analysisAttempts: RECOVERY.maxAttempts }, now), 'fail-attempts');
    assert.equal(recoveryActionFor({ ...base, updatedAt: minutesAgo(8 * 24 * 60) }, now), 'fail-old');
    assert.equal(recoveryActionFor({ ...base, twelveLabsAssetId: null }, now), 'fail-no-asset');
});

test('stuck filter covers stale heartbeats, pre-heartbeat jobs and undelivered queue messages', () => {
    const filter = stuckVideosFilter(now);
    assert.equal(filter.$or.length, 3);
    assert.equal(filter.$or[0].analysisStatus, ANALYSIS_STATUS.PROCESSING);
    assert.deepEqual(filter.$or[0].analysisHeartbeatAt, { $lt: minutesAgo(10) });
    assert.equal(filter.$or[2].analysisStatus, ANALYSIS_STATUS.QUEUED);
    assert.deepEqual(filter.$or[2].updatedAt, { $lt: minutesAgo(15) });
});

test('sweep re-queues stuck videos, fails exhausted ones, and skips jobs this instance is running', async () => {
    const rows = [
        { _id: 'v1', analysisStatus: ANALYSIS_STATUS.PROCESSING, analysisAttempts: 0, updatedAt: minutesAgo(20), twelveLabsAssetId: 'a1', uploader_id: 'u' },
        { _id: 'v2', analysisStatus: ANALYSIS_STATUS.PROCESSING, analysisAttempts: 2, updatedAt: minutesAgo(20), twelveLabsAssetId: 'a2' },
        { _id: 'v3', analysisStatus: ANALYSIS_STATUS.QUEUED, analysisAttempts: 0, updatedAt: minutesAgo(20), twelveLabsAssetId: 'a3' },
        { _id: 'running', analysisStatus: ANALYSIS_STATUS.PROCESSING, analysisAttempts: 0, updatedAt: minutesAgo(20), twelveLabsAssetId: 'a4' },
    ];
    Video.find = () => ({ select: () => ({ sort: () => ({ limit: () => ({ lean: async () => rows }) }) }) });
    const claims = [];
    Video.findOneAndUpdate = async (filter, update) => {
        claims.push({ filter, update });
        return { ...rows.find((r) => r._id === filter._id), analysisStatus: ANALYSIS_STATUS.QUEUED };
    };
    const failures = [];
    Video.updateOne = async (filter, update) => {
        failures.push({ filter, update });
        return { modifiedCount: 1 };
    };
    const published = [];
    const summary = await sweepStuckAnalyses({ now, skipIds: ['running'], publish: async (job, opts) => published.push({ job, opts }) });

    assert.deepEqual(summary, { checked: 4, requeued: 2, failed: 1, skipped: 1 });
    assert.deepEqual(published.map((p) => p.job.videoId).sort(), ['v1', 'v3']);
    assert.deepEqual(claims[0].update.$inc, { analysisAttempts: 1 });
    assert.equal(claims[0].filter.analysisStatus, ANALYSIS_STATUS.PROCESSING, 'conditional on the status we read');
    assert.equal(failures[0].filter._id, 'v2');
    assert.equal(failures[0].update.$set.lastError, RECOVERY_MESSAGES.interruptedTwice);
});

test('a video another instance already re-queued is left alone', async () => {
    Video.find = () => ({ select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [
        { _id: 'v1', analysisStatus: ANALYSIS_STATUS.PROCESSING, analysisAttempts: 0, updatedAt: minutesAgo(20), twelveLabsAssetId: 'a1' },
    ] }) }) }) });
    Video.findOneAndUpdate = async () => null;
    let published = 0;
    const summary = await sweepStuckAnalyses({ now, skipIds: [], publish: async () => { published++; } });
    assert.equal(published, 0);
    assert.equal(summary.skipped, 1);
});

test('while shutting down the webhook answers 503 so QStash retries on the new instance', async () => {
    markShuttingDown();
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await processVideoAnalysis({ body: { videoId: 'v1' } }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.retry, true);
});

test('runtime tracks running jobs and waits for them', async () => {
    trackJobStart('a');
    assert.deepEqual(runningJobIds(), ['a']);
    setTimeout(() => trackJobEnd('a'), 20);
    assert.deepEqual(await waitForRunningJobs(1000, 5), []);
    trackJobStart('b');
    assert.deepEqual(await waitForRunningJobs(15, 5), ['b']);
});

test('upload semaphore never runs more than its limit at once and keeps order', async () => {
    const { createSemaphore } = await import('../src/utils/semaphore.js');
    const slots = createSemaphore(2);
    let active = 0;
    let peak = 0;
    const order = [];
    const task = (id) => slots.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        order.push(id);
        active--;
        return id;
    });
    const results = await Promise.all([1, 2, 3, 4, 5].map(task));
    assert.deepEqual(results, [1, 2, 3, 4, 5]);
    assert.equal(peak, 2);
    assert.deepEqual(slots.stats(), { active: 0, waiting: 0, limit: 2 });
});
