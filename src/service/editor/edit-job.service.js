import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EditProject, EDIT_STATUS, IN_FLIGHT_STATUSES } from '../../model/edit-project.model.js';
import { User } from '../../model/user.model.js';
import { storage, editorKey } from '../../lib/storage.js';
import { getQStashClient } from '../../lib/qstash.js';
import { BACKEND_URL } from '../../config/index.js';
import { withAiContext, newTraceId } from '../../lib/ai-tracking.js';
import { captureServerEvent } from '../../lib/analytics.js';
import { createSemaphore } from '../../utils/semaphore.js';
import { prepareMedia } from './media-prep.js';
import { transcribeWords } from './transcribe.js';
import { buildCutCandidates } from './cut-candidates.js';
import { planEdit } from './edit-planner.service.js';
import { chargeEdit } from './editor-access.service.js';
import { resolveCreatorProfile } from '../creator-profile.service.js';

/**
 * Runs one AI edit end to end: download the upload, prepare media, transcribe, plan with Claude,
 * then mark it ready and charge it. Durable: jobs arrive via QStash, a heartbeat marks progress,
 * and the sweeper re-queues projects whose worker died. Failures release the in-flight slot and
 * never use up an edit.
 */

export const EDITOR_CONCURRENCY = Math.max(1, Number(process.env.EDITOR_CONCURRENCY) || 2);
export const STALE_JOB_MS = 6 * 60 * 1000;
export const STALE_UPLOAD_MS = 2 * 60 * 60 * 1000;
export const MAX_ATTEMPTS = 3;
const HEARTBEAT_MS = 30 * 1000;
const WORK_ROOT = path.join(os.tmpdir(), 'vireact-editor');

const gate = createSemaphore(EDITOR_CONCURRENCY);
export const editorQueueStats = () => gate.stats();

const GENERIC_FAILURE = 'Something went wrong while editing this video. This did not use up an edit. Try again.';

let publisherOverride = null;
/** Tests: capture published jobs instead of calling QStash. Pass null to restore. */
export const setEditJobPublisherForTests = (fn) => {
    publisherOverride = fn;
};

export async function publishEditJob(projectId, { delaySeconds = 0, publish } = {}) {
    const fake = publish ?? publisherOverride;
    if (fake) return fake({ projectId: String(projectId) });
    if (!BACKEND_URL) throw new Error('BACKEND_URL is required to publish editor jobs');
    const result = await getQStashClient().publishJSON({
        url: `${BACKEND_URL}/api/v1/editor/jobs/run`,
        body: { projectId: String(projectId) },
        retries: 3,
        ...(delaySeconds > 0 ? { delay: Math.round(delaySeconds) } : {}),
    });
    return typeof result === 'string' ? result : result?.messageId ?? null;
}

const setStage = (id, stage, progress) =>
    EditProject.updateOne({ _id: id }, { $set: { stage, progress, heartbeatAt: new Date() } });

/** Mark failed, free the slot, keep billing untouched (failures never count). */
export async function failProject(id, message) {
    await EditProject.updateOne(
        { _id: id, status: { $ne: EDIT_STATUS.DELETED } },
        { $set: { status: EDIT_STATUS.FAILED, inFlight: false, error: message, stage: 'failed' } }
    );
}

/**
 * Run the job for one project. Only a QUEUED project is claimed (atomic), so duplicate deliveries and
 * sweeper re-queues can never run it twice at once.
 * @param {string} projectId
 * @param {object} [deps] injectable for tests: prepare, transcribe, plan, now
 */
export async function runEditJob(projectId, deps = {}) {
    const prepare = deps.prepare ?? prepareMedia;
    const transcribe = deps.transcribe ?? transcribeWords;
    const plan = deps.plan ?? planEdit;

    const project = await EditProject.findOneAndUpdate(
        { _id: projectId, status: EDIT_STATUS.QUEUED },
        { $set: { status: EDIT_STATUS.PREPROCESSING, stage: 'preparing', progress: 5, heartbeatAt: new Date(), error: null }, $inc: { attempts: 1 } },
        { new: true }
    );
    if (!project) return { skipped: true };

    const userId = String(project.userId);
    const workDir = path.join(WORK_ROOT, String(project._id));
    const heartbeat = setInterval(() => {
        void EditProject.updateOne({ _id: project._id }, { $set: { heartbeatAt: new Date() } }).catch(() => {});
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
        // Regeneration (or a retry after planning failed): media is already prepared, only replan.
        if (project.media?.frameSheets?.length && project.source?.proxyKey && project.plan) {
            return await replan(project, userId, plan);
        }
        await fs.promises.mkdir(workDir, { recursive: true });
        const srcPath = path.join(workDir, `source${path.extname(project.source.key) || '.mp4'}`);
        await storage.downloadToFile(project.source.key, srcPath);

        const prepared = await prepare(srcPath, workDir, { onStage: (stage, progress) => void setStage(project._id, stage, progress) });
        const { info } = prepared;

        await setStage(project._id, 'saving preview', 55);
        const keys = (name) => editorKey(name === 'proxy.mp4' || name === 'thumb.jpg' ? 'proxies' : 'frames', userId, project._id, name);
        const proxyKey = keys('proxy.mp4');
        const thumbKey = keys('thumb.jpg');
        await storage.uploadFile(prepared.proxyPath, proxyKey, 'video/mp4');
        await storage.uploadFile(prepared.thumbPath, thumbKey, 'image/jpeg');
        let masterKey = null;
        if (prepared.masterPath) {
            masterKey = editorKey('sources', userId, project._id, 'master.mp4');
            await storage.uploadFile(prepared.masterPath, masterKey, 'video/mp4');
        }
        const frameSheets = [];
        for (const s of prepared.sheets) {
            const key = keys(s.name);
            await storage.uploadFile(s.path, key, 'image/jpeg');
            frameSheets.push({ key, from: s.from, to: s.to, cols: s.cols, rows: s.rows, intervalSec: s.intervalSec });
        }

        let words = [];
        let language = null;
        if (prepared.audioPath) {
            await setStage(project._id, 'transcribing', 62);
            ({ words, language } = await transcribe(prepared.audioPath));
        }
        const cutCandidates = buildCutCandidates({ words, silences: prepared.silences, durationSec: info.durationSec });

        const media = {
            words,
            silences: prepared.silences,
            sceneCuts: prepared.sceneCuts,
            loudnessLufs: prepared.loudnessLufs,
            frameSheets,
            cutCandidates,
            transcriptLanguage: language,
        };
        const updated = await EditProject.findOneAndUpdate(
            { _id: project._id },
            {
                $set: {
                    status: EDIT_STATUS.PLANNING,
                    stage: 'studying viral patterns',
                    progress: 70,
                    heartbeatAt: new Date(),
                    media,
                    'source.durationSec': info.durationSec,
                    'source.width': info.width,
                    'source.height': info.height,
                    'source.fps': info.fps,
                    'source.rotation': info.rotation,
                    'source.hasAudio': info.hasAudio,
                    'source.proxyKey': proxyKey,
                    'source.thumbnailKey': thumbKey,
                    'source.masterKey': masterKey,
                },
            },
            { new: true, lean: true }
        );

        const user = await User.findById(userId).select('creatorProfile onboarding').lean();
        await setStage(project._id, 'planning your edit', 80);
        const result = await withAiContext(
            { feature: 'video_editor', userId, distinctId: userId, traceId: newTraceId(`edit-${project._id}`) },
            () => plan({ project: updated, profile: resolveCreatorProfile(user ?? {}) })
        );

        await EditProject.updateOne(
            { _id: project._id },
            {
                $set: {
                    status: EDIT_STATUS.READY,
                    inFlight: false,
                    stage: 'ready',
                    progress: 100,
                    plan: result.plan,
                    planGenerationId: result.generationId ?? null,
                    edits: {},
                    readyAt: new Date(),
                    error: null,
                },
            }
        );
        const charged = await chargeEdit(project._id, userId);
        captureServerEvent(userId, 'edit_ready', {
            project_id: String(project._id),
            duration_sec: info.durationSec,
            words: words.length,
            exemplars: result.exemplarCount ?? 0,
            charged: charged ?? 'already',
        });
        return { ok: true };
    } catch (err) {
        console.error(`[Editor] Job failed for project ${projectId}:`, err.message);
        if (project.plan) {
            // A failed regeneration keeps the edit the creator already had, and isn't counted.
            await EditProject.updateOne(
                { _id: project._id, status: { $ne: EDIT_STATUS.DELETED } },
                { $set: { status: EDIT_STATUS.READY, inFlight: false, stage: 'ready', progress: 100, pendingRevision: null, error: 'Could not apply your changes. Your previous edit is unchanged and this did not use a regeneration.' } }
            );
            return { ok: false, error: err.message };
        }
        await failProject(project._id, err.userFacing ? err.message : GENERIC_FAILURE);
        captureServerEvent(userId, 'edit_failed', { project_id: String(project._id), reason: err.userFacing ? 'media' : 'internal' });
        return { ok: false, error: err.message };
    } finally {
        clearInterval(heartbeat);
        await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}

/** Plan again on prepared media with the creator's note. Already charged, so nothing is counted. */
async function replan(project, userId, plan) {
    await EditProject.updateOne({ _id: project._id }, { $set: { status: EDIT_STATUS.PLANNING, stage: 'planning your edit', progress: 80, heartbeatAt: new Date() } });
    const user = await User.findById(userId).select('creatorProfile onboarding').lean();
    const revision = project.pendingRevision ?? { note: '', previousPlan: project.plan };
    const result = await withAiContext(
        { feature: 'video_editor', userId, distinctId: userId, traceId: newTraceId(`edit-${project._id}-rev`) },
        () => plan({ project: project.toObject(), profile: resolveCreatorProfile(user ?? {}), revision })
    );
    await EditProject.updateOne(
        { _id: project._id },
        {
            $set: { status: EDIT_STATUS.READY, inFlight: false, stage: 'ready', progress: 100, plan: result.plan, planGenerationId: result.generationId ?? null, edits: {}, pendingRevision: null, readyAt: new Date(), error: null },
            $push: { revisions: { note: revision.note, plan: revision.previousPlan, createdAt: new Date() } },
        }
    );
    captureServerEvent(userId, 'edit_regenerated', { project_id: String(project._id) });
    return { ok: true, replanned: true };
}

/** Run a job within this instance's concurrency limit (used by the QStash webhook). */
export const runEditJobGated = (projectId, deps) => gate.run(() => runEditJob(projectId, deps));

/**
 * Recover editor jobs: re-queue projects whose worker died mid-run (stale heartbeat), give up after
 * MAX_ATTEMPTS, and release slots held by uploads that never finished.
 */
export async function sweepStuckEdits({ now = Date.now(), publish } = {}) {
    const stale = await EditProject.find({
        status: { $in: [EDIT_STATUS.PREPROCESSING, EDIT_STATUS.PLANNING] },
        heartbeatAt: { $lt: new Date(now - STALE_JOB_MS) },
    }).select('_id attempts readyAt').lean();
    let requeued = 0;
    for (const p of stale) {
        if ((p.attempts ?? 0) >= MAX_ATTEMPTS) {
            if (p.readyAt) {
                // A regeneration that keeps dying: give the creator back the edit they had.
                await EditProject.updateOne({ _id: p._id }, { $set: { status: EDIT_STATUS.READY, inFlight: false, stage: 'ready', progress: 100, pendingRevision: null, error: 'Could not apply your changes. Your previous edit is unchanged.' } });
            } else {
                await failProject(p._id, GENERIC_FAILURE);
            }
            continue;
        }
        const res = await EditProject.updateOne(
            { _id: p._id, status: { $in: [EDIT_STATUS.PREPROCESSING, EDIT_STATUS.PLANNING] }, heartbeatAt: { $lt: new Date(now - STALE_JOB_MS) } },
            { $set: { status: EDIT_STATUS.QUEUED, stage: 'queued', heartbeatAt: new Date(now) } }
        );
        if (res.modifiedCount) {
            requeued += 1;
            await publishEditJob(p._id, { publish }).catch((err) => console.error('[Editor] Re-queue publish failed:', err.message));
        }
    }
    const abandoned = await EditProject.updateMany(
        { status: EDIT_STATUS.AWAITING_UPLOAD, createdAt: { $lt: new Date(now - STALE_UPLOAD_MS) } },
        { $set: { status: EDIT_STATUS.FAILED, inFlight: false, error: 'The upload did not finish.', stage: 'failed' } }
    );
    // Queued projects whose message was lost: re-publish once they've waited too long.
    const lost = await EditProject.find({ status: EDIT_STATUS.QUEUED, heartbeatAt: { $lt: new Date(now - STALE_JOB_MS) } }).select('_id').lean();
    for (const p of lost) {
        await EditProject.updateOne({ _id: p._id }, { $set: { heartbeatAt: new Date(now) } });
        await publishEditJob(p._id, { publish }).catch(() => {});
    }
    return { requeued, abandoned: abandoned.modifiedCount ?? 0, republished: lost.length };
}

export { IN_FLIGHT_STATUSES };
