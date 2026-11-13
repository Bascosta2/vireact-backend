import crypto from 'node:crypto';
import path from 'node:path';
import mongoose from 'mongoose';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { EditProject, EDIT_STATUS, RENDER_STATUS } from '../model/edit-project.model.js';
import { SoundAsset } from '../model/sound-asset.model.js';
import { storage, editorKey, editorPrefixes, isStorageConfigured } from '../lib/storage.js';
import { isClaudeConfigured } from '../lib/anthropic.js';
import { captureServerEvent } from '../lib/analytics.js';
import { isShuttingDown } from '../queue/analysis-runtime.js';
import { editorUsage, accessError } from '../service/editor/editor-access.service.js';
import { publishEditJob, runEditJobGated, failProject } from '../service/editor/edit-job.service.js';
import { buildRenderProps, sanitizeEdits } from '../service/editor/compose.js';
import { isRenderConfigured, renderProgress, startRender } from '../service/editor/render.service.js';
import { uploadVideoUrlToTwelveLabsService } from '../service/video.service.js';
import { allowedFeaturesForPlan } from '../constants.js';
import { getOrCreateSubscription } from '../service/subscription.service.js';

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
export const MAX_REGENERATIONS = 2;
const ALLOWED_TYPES = new Map([
    ['video/mp4', '.mp4'],
    ['video/quicktime', '.mov'],
    ['video/webm', '.webm'],
    ['video/x-matroska', '.mkv'],
    ['video/mpeg', '.mpg'],
    ['video/x-m4v', '.m4v'],
]);
const SIGNED_TTL = 2 * 60 * 60;

const ok = (res, message, data, status = 200) => res.status(status).json(ApiResponse.success(status, message, data));

const ownedProject = async (req, extraFilter = {}) => {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'Edit not found');
    const project = await EditProject.findOne({ _id: id, userId: req.user._id, status: { $ne: EDIT_STATUS.DELETED }, ...extraFilter });
    if (!project) throw new ApiError(404, 'Edit not found');
    return project;
};

const assertConfigured = () => {
    if (!isStorageConfigured() || !isClaudeConfigured()) {
        throw new ApiError(503, 'The editor is being set up and is not available yet.', { code: 'EDITOR_UNAVAILABLE' });
    }
};

const sign = (key, opts) => (key ? storage.presignDownload(key, { expiresIn: SIGNED_TTL, ...opts }) : null);

/**
 * Built-in sound effects ship with the web app (public/sfx/<type>.mp3), so every edit has sound even
 * when nothing has been uploaded to the sound library. Uploaded effects of the same type win.
 * The www host is used directly: the bare domain redirects, and renders should not depend on that.
 */
export const builtInSfxUrl = (type, base = process.env.PUBLIC_ASSETS_URL || 'https://www.vireact.io') => `${String(base).replace(/\/+$/, '')}/sfx/${type}.mp3`;

/** Signed URLs for the music track and sound effects a set of props uses. */
async function soundUrls(props) {
    const slugs = new Set();
    if (props.music?.trackId) slugs.add(props.music.trackId);
    const sfxTypes = new Set(props.sfx.map((s) => s.type));
    const assets = await SoundAsset.find({ active: true, $or: [{ slug: { $in: [...slugs] } }, { kind: 'sfx', sfxType: { $in: [...sfxTypes] } }] })
        .select('kind slug key sfxType title attribution')
        .lean();
    const music = props.music ? assets.find((a) => a.slug === props.music.trackId) : null;
    const sfx = {};
    for (const type of sfxTypes) {
        const a = assets.find((x) => x.kind === 'sfx' && x.sfxType === type);
        sfx[type] = a ? await sign(a.key) : builtInSfxUrl(type);
    }
    return {
        musicUrl: music ? await sign(music.key) : null,
        musicTitle: music?.title ?? null,
        musicAttribution: music?.attribution ?? null,
        sfxUrls: sfx,
    };
}

const mediaFor = (p) => ({
    words: p.media?.words ?? [],
    silences: p.media?.silences ?? [],
    cutCandidates: p.media?.cutCandidates ?? [],
    durationSec: p.source?.durationSec ?? 0,
});

const trackIdSet = async () => new Set((await SoundAsset.find({ kind: 'music', active: true }).select('slug').lean()).map((t) => t.slug));

/** Summary for lists. */
const toListItem = async (p) => ({
    id: String(p._id),
    title: p.title,
    status: p.status,
    stage: p.stage,
    progress: p.progress,
    error: p.error,
    durationSec: p.source?.durationSec ?? null,
    editedDurationSec: p.plan ? Math.round(buildRenderProps(p.plan, p.edits ?? {}, mediaFor(p)).durationInFrames / 30 * 10) / 10 : null,
    thumbnailUrl: p.source?.thumbnailKey ? await sign(p.source.thumbnailKey) : null,
    createdAt: p.createdAt,
    readyAt: p.readyAt ?? null,
    hasRender: (p.renders ?? []).some((r) => r.status === RENDER_STATUS.DONE),
});

/** Full detail for the project page (preview props are signed and ready to play). */
async function toDetail(p) {
    const base = await toListItem(p);
    const detail = {
        ...base,
        source: p.source ? { durationSec: p.source.durationSec, width: p.source.width, height: p.source.height, hasAudio: p.source.hasAudio } : null,
        regenerationsLeft: Math.max(0, MAX_REGENERATIONS - (p.revisions?.length ?? 0)),
        billing: p.billing?.kind ?? null,
        renders: (p.renders ?? []).map((r) => ({ id: r.id, status: r.status, progress: r.progress, error: r.error ?? null, createdAt: r.createdAt })),
        linkedVideoId: p.linkedVideoId ? String(p.linkedVideoId) : null,
        plan: null,
        edits: p.edits ?? {},
        props: null,
        proxyUrl: null,
        candidates: [],
        words: [],
    };
    if (p.status === EDIT_STATUS.READY && p.plan) {
        const props = buildRenderProps(p.plan, p.edits ?? {}, mediaFor(p));
        // Counts with every layer switched on, so a toggle stays visible after it is turned off.
        const full = buildRenderProps(p.plan, { ...(p.edits ?? {}), sfxOff: false, overlaysOff: false, transitionsOff: false, effectsOff: false }, mediaFor(p));
        detail.plan = {
            summary: p.plan.summary,
            hookStrategy: p.plan.hookStrategy,
            changes: p.plan.changes,
            expectedEffect: p.plan.expectedEffect,
            segments: p.plan.segments,
            captions: p.plan.captions,
            hookOverlay: p.plan.hookOverlay,
            zooms: p.plan.zooms.map((z, index) => ({ index, at: z.at, scale: z.scale, reason: z.reason })),
            music: p.plan.music,
            framing: p.plan.framing,
            sfxCount: full.sfx.length,
            overlayCount: full.graphics.length,
            transitionCount: full.transitions.length,
            effectCount: full.effects.length,
            graphics: full.graphics.map((g) => ({ type: g.type, text: g.text || g.items.join(', ') })),
            look: full.look,
        };
        detail.props = { ...props, ...(await soundUrls(props)) };
        detail.proxyUrl = await sign(p.source?.proxyKey);
        const accepted = new Set(p.plan.acceptedCandidateIds);
        detail.candidates = (p.media?.cutCandidates ?? []).filter((c) => accepted.has(c.id)).map((c) => ({ id: c.id, kind: c.kind, start: c.start, end: c.end, text: c.text ?? null }));
        detail.words = (p.media?.words ?? []).map((w, i) => ({ i, w: w.w, start: w.start }));
        detail.tracks = await SoundAsset.find({ kind: 'music', active: true }).select('slug title mood energy -_id').lean();
    }
    return detail;
}

export const getEditorUsage = async (req, res, next) => {
    try {
        const usage = await editorUsage(req.user._id);
        ok(res, 'Editor usage', { ...usage, available: isStorageConfigured() && isClaudeConfigured(), renderAvailable: isRenderConfigured(), maxUploadBytes: MAX_UPLOAD_BYTES, maxDurationSec: 180 });
    } catch (error) {
        next(error);
    }
};

export const createEditProject = async (req, res, next) => {
    try {
        assertConfigured();
        const userId = req.user._id;
        const { fileName = '', contentType = '', sizeBytes, title } = req.body ?? {};
        const ext = ALLOWED_TYPES.get(String(contentType).toLowerCase());
        if (!ext) throw new ApiError(400, 'Upload an MP4, MOV, WebM or MKV video.', { code: 'BAD_TYPE' });
        const size = Number(sizeBytes);
        if (!Number.isFinite(size) || size <= 0) throw new ApiError(400, 'File size is missing.');
        if (size > MAX_UPLOAD_BYTES) throw new ApiError(413, 'Videos can be up to 500 MB.', { code: 'TOO_LARGE' });

        const usage = await editorUsage(userId);
        const denied = accessError(usage);
        if (denied) throw new ApiError(denied.status, denied.message, { code: denied.code, usage });

        // Release this user's abandoned uploads (older than 2 hours) before claiming the slot.
        await EditProject.updateMany(
            { userId, status: EDIT_STATUS.AWAITING_UPLOAD, createdAt: { $lt: new Date(Date.now() - 2 * 60 * 60 * 1000) } },
            { $set: { status: EDIT_STATUS.FAILED, inFlight: false, error: 'The upload did not finish.' } }
        );

        const _id = new mongoose.Types.ObjectId();
        const key = editorKey('sources', userId, _id, `source${ext}`);
        const cleanTitle = String(title || path.parse(String(fileName)).name || 'Untitled edit').replace(/[\r\n\t]/g, ' ').trim().slice(0, 120) || 'Untitled edit';
        let project;
        try {
            project = await EditProject.create({
                _id,
                userId,
                title: cleanTitle,
                source: { key, contentType, sizeBytes: size, originalName: String(fileName).slice(0, 200) },
            });
        } catch (err) {
            if (err?.code === 11000) {
                throw new ApiError(409, 'You already have an edit in progress. Wait for it to finish, then start the next one.', { code: 'EDIT_IN_PROGRESS' });
            }
            throw err;
        }
        const uploadUrl = await storage.presignUpload({ key, contentType, sizeBytes: size });
        ok(res, 'Upload ready', { project: await toListItem(project), upload: { url: uploadUrl, method: 'PUT', headers: { 'Content-Type': contentType } } }, 201);
    } catch (error) {
        next(error);
    }
};

export const confirmEditUpload = async (req, res, next) => {
    try {
        assertConfigured();
        const project = await ownedProject(req, { status: EDIT_STATUS.AWAITING_UPLOAD });
        const head = await storage.head(project.source.key);
        if (!head || !head.sizeBytes) throw new ApiError(400, 'We could not find your upload. Try uploading again.', { code: 'UPLOAD_MISSING' });
        if (head.sizeBytes > MAX_UPLOAD_BYTES) {
            await failProject(project._id, 'Videos can be up to 500 MB.');
            throw new ApiError(413, 'Videos can be up to 500 MB.', { code: 'TOO_LARGE' });
        }
        project.status = EDIT_STATUS.QUEUED;
        project.stage = 'queued';
        project.progress = 3;
        project.heartbeatAt = new Date();
        project.source.sizeBytes = head.sizeBytes;
        await project.save();
        try {
            await publishEditJob(project._id);
        } catch (err) {
            console.error('[Editor] Could not queue job:', err.message);
            await failProject(project._id, 'We could not start your edit. This did not use up an edit. Try again.');
            throw new ApiError(503, 'We could not start your edit. Try again in a minute.');
        }
        captureServerEvent(String(req.user._id), 'edit_started', { project_id: String(project._id), size_mb: Math.round(head.sizeBytes / 1e6) });
        ok(res, 'Edit queued', await toListItem(project));
    } catch (error) {
        next(error);
    }
};

export const listEditProjects = async (req, res, next) => {
    try {
        const projects = await EditProject.find({ userId: req.user._id, status: { $ne: EDIT_STATUS.DELETED } })
            .select('-media.frameSheets -revisions')
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();
        ok(res, 'Edits', { projects: await Promise.all(projects.map(toListItem)) });
    } catch (error) {
        next(error);
    }
};

export const getEditProject = async (req, res, next) => {
    try {
        const project = await ownedProject(req);
        ok(res, 'Edit', await toDetail(project.toObject()));
    } catch (error) {
        next(error);
    }
};

export const updateEdits = async (req, res, next) => {
    try {
        const project = await ownedProject(req, { status: EDIT_STATUS.READY });
        const changes = sanitizeEdits(req.body ?? {}, { wordCount: project.media?.words?.length ?? 0, trackIds: await trackIdSet() });
        const edits = { ...(project.edits ?? {}), ...changes };
        if (changes.captionText) edits.captionText = { ...(project.edits?.captionText ?? {}), ...changes.captionText };
        // Never allow removing every segment.
        const remaining = project.plan.segments.filter((s) => !(edits.disabledSegments ?? []).includes(s.id));
        if (remaining.length === 0) throw new ApiError(400, 'Keep at least one part of the video.');
        project.edits = edits;
        project.markModified('edits');
        await project.save();
        const props = buildRenderProps(project.plan, edits, mediaFor(project));
        ok(res, 'Saved', { edits, props: { ...props, ...(await soundUrls(props)) } });
    } catch (error) {
        next(error);
    }
};

export const regenerateEdit = async (req, res, next) => {
    try {
        assertConfigured();
        const note = String(req.body?.note ?? '').trim();
        if (note.length < 3) throw new ApiError(400, 'Tell the editor what to change.');
        if (note.length > 500) throw new ApiError(400, 'Keep the note under 500 characters.');
        const project = await ownedProject(req, { status: EDIT_STATUS.READY });
        if ((project.revisions?.length ?? 0) >= MAX_REGENERATIONS) {
            throw new ApiError(429, 'You have used both regenerations for this edit. Start a new edit to try again.', { code: 'REGENERATIONS_USED' });
        }
        const res2 = await EditProject.updateOne(
            { _id: project._id, status: EDIT_STATUS.READY },
            { $set: { status: EDIT_STATUS.QUEUED, inFlight: true, stage: 'queued', progress: 75, attempts: 0, heartbeatAt: new Date(), error: null, pendingRevision: { note, previousPlan: project.plan } } }
        ).catch((err) => {
            if (err?.code === 11000) throw new ApiError(409, 'You already have an edit in progress. Wait for it to finish first.', { code: 'EDIT_IN_PROGRESS' });
            throw err;
        });
        if (!res2.modifiedCount) throw new ApiError(409, 'This edit is already being updated.');
        try {
            await publishEditJob(project._id);
        } catch (err) {
            await EditProject.updateOne({ _id: project._id }, { $set: { status: EDIT_STATUS.READY, inFlight: false, pendingRevision: null, stage: 'ready', progress: 100 } });
            throw new ApiError(503, 'We could not start the update. Try again in a minute.');
        }
        captureServerEvent(String(req.user._id), 'edit_regenerate_requested', { project_id: String(project._id) });
        ok(res, 'Updating your edit', { id: String(project._id), status: EDIT_STATUS.QUEUED });
    } catch (error) {
        next(error);
    }
};

export const startEditRender = async (req, res, next) => {
    try {
        if (!isRenderConfigured()) throw new ApiError(503, 'Export is being set up and is not available yet.', { code: 'RENDER_UNAVAILABLE' });
        const project = await ownedProject(req, { status: EDIT_STATUS.READY });
        const active = (project.renders ?? []).find((r) => r.status === RENDER_STATUS.RENDERING && Date.now() - new Date(r.createdAt).getTime() < 15 * 60 * 1000);
        if (active) return ok(res, 'Already exporting', { renderId: active.id });
        if ((project.renders ?? []).length >= 10) throw new ApiError(429, 'This edit has been exported 10 times. Download an earlier export instead.');

        const props = buildRenderProps(project.plan, project.edits ?? {}, mediaFor(project));
        const sounds = await soundUrls(props);
        // The final render uses the full-quality render master (the original upload for older edits), not the preview proxy.
        const inputProps = { ...props, ...sounds, videoUrl: await storage.presignDownload(project.source.masterKey || project.source.key, { expiresIn: 3 * 60 * 60 }) };
        const id = crypto.randomBytes(6).toString('hex');
        const outKey = editorKey('renders', project.userId, project._id, `${id}.mp4`);
        const { remotionRenderId, bucketName } = await startRender({ inputProps, outKey });
        project.renders.push({ id, status: RENDER_STATUS.RENDERING, progress: 0, remotionRenderId, bucketName, key: outKey });
        await project.save();
        captureServerEvent(String(req.user._id), 'edit_exported', { project_id: String(project._id), frames: props.durationInFrames });
        ok(res, 'Export started', { renderId: id }, 202);
    } catch (error) {
        next(error);
    }
};

export const getEditRender = async (req, res, next) => {
    try {
        const project = await ownedProject(req);
        const render = (project.renders ?? []).find((r) => r.id === req.params.renderId);
        if (!render) throw new ApiError(404, 'Export not found');
        if (render.status === RENDER_STATUS.RENDERING) {
            const p = await renderProgress(render);
            if (p.error) {
                render.status = RENDER_STATUS.FAILED;
                render.error = 'The export failed. Try again.';
                console.error(`[Editor] Render ${render.id} failed:`, p.error);
            } else if (p.done) {
                render.status = RENDER_STATUS.DONE;
                render.progress = 100;
                render.sizeBytes = p.sizeBytes;
                render.finishedAt = new Date();
            } else {
                render.progress = p.progress;
                if (Date.now() - new Date(render.createdAt).getTime() > 15 * 60 * 1000) {
                    render.status = RENDER_STATUS.FAILED;
                    render.error = 'The export took too long. Try again.';
                }
            }
            project.markModified('renders');
            await project.save();
        }
        const safeName = `${project.title.replace(/[^\w -]/g, '').trim().slice(0, 60) || 'vireact-edit'}.mp4`;
        ok(res, 'Export', {
            id: render.id,
            status: render.status,
            progress: render.progress,
            error: render.error ?? null,
            downloadUrl: render.status === RENDER_STATUS.DONE ? await storage.presignDownload(render.key, { expiresIn: 60 * 60, filename: safeName }) : null,
        });
    } catch (error) {
        next(error);
    }
};

/** Send the exported MP4 through the regular analysis so the creator sees the new score. */
export const scoreEditRender = async (req, res, next) => {
    try {
        const project = await ownedProject(req, { status: EDIT_STATUS.READY });
        if (project.linkedVideoId) return ok(res, 'Already scored', { videoId: String(project.linkedVideoId) });
        const render = [...(project.renders ?? [])].reverse().find((r) => r.status === RENDER_STATUS.DONE);
        if (!render) throw new ApiError(400, 'Export the edit first, then score it.');
        const subscription = await getOrCreateSubscription(req.user._id);
        const url = await storage.presignDownload(render.key, { expiresIn: 3 * 60 * 60 });
        const video = await uploadVideoUrlToTwelveLabsService(req.user._id, url, `${project.title} (edited).mp4`, allowedFeaturesForPlan(subscription?.plan));
        project.linkedVideoId = video._id;
        await project.save();
        captureServerEvent(String(req.user._id), 'edit_scored', { project_id: String(project._id), video_id: String(video._id) });
        ok(res, 'Scoring started', { videoId: String(video._id) }, 202);
    } catch (error) {
        next(error);
    }
};

export const deleteEditProject = async (req, res, next) => {
    try {
        const project = await ownedProject(req);
        if (isStorageConfigured()) {
            for (const prefix of editorPrefixes(project.userId, project._id)) {
                await storage.deletePrefix(prefix).catch((err) => console.warn(`[Editor] Could not delete ${prefix}:`, err.message));
            }
        }
        // Keep the record (billing history), drop the content.
        await EditProject.updateOne(
            { _id: project._id },
            { $set: { status: EDIT_STATUS.DELETED, inFlight: false, deletedAt: new Date(), plan: null, edits: {}, media: {}, renders: [], pendingRevision: null } }
        );
        ok(res, 'Deleted', { id: String(project._id) });
    } catch (error) {
        next(error);
    }
};

/** QStash webhook: acknowledge right away, run in the background within the concurrency limit. */
export const runEditJobWebhook = async (req, res) => {
    const projectId = req.body?.projectId;
    if (!projectId || !mongoose.isValidObjectId(projectId)) return res.status(200).json({ received: true });
    if (isShuttingDown()) return res.status(503).json({ received: false, retry: true });
    res.status(200).json({ received: true, projectId });
    setImmediate(() => {
        void runEditJobGated(projectId).catch((err) => console.error('[Editor] Job crashed:', err.message));
    });
};
