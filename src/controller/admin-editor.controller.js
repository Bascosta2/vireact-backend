import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';
import { ApiError } from '../utils/ApiError.js';
import { VideoPerformanceDataset } from '../model/VideoPerformanceDataset.model.js';
import { KnowledgeBase } from '../model/knowledge-base.model.js';
import { SoundAsset, MUSIC_MOODS } from '../model/sound-asset.model.js';
import { storage, isStorageConfigured } from '../lib/storage.js';
import { isClaudeConfigured } from '../lib/anthropic.js';
import { ffprobe } from '../lib/ffmpeg.js';
import { profileExample } from '../service/editor/exemplar-profile.service.js';
import { createSemaphore } from '../utils/semaphore.js';

/**
 * Admin: the viral examples the editor learns from (video + real analytics) and the licensed sound
 * library. Used by the private /admin/editor page; every route is behind adminAuth.
 */

const PLATFORMS = ['tiktok', 'instagram', 'youtube', 'facebook'];
const SFX_TYPES = ['whoosh', 'pop', 'riser', 'ding', 'boom'];
const profileGate = createSemaphore(Number(process.env.EDITOR_PROFILE_CONCURRENCY) || 1);

const num = (v) => {
    if (v === undefined || v === null || String(v).trim() === '') return undefined;
    const n = Number(String(v).replace(/[, ]/g, ''));
    return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const text = (v, max = 80) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const date = (v) => {
    const d = v ? new Date(v) : null;
    return d && !Number.isNaN(d.getTime()) ? d : undefined;
};
const removeTemp = (file) => file?.path && fs.promises.unlink(file.path).catch(() => {});

const toExample = (d) => ({
    id: String(d._id),
    filename: d.filename,
    platform: d.platform,
    niche: d.niche ?? null,
    actualViews: d.actualViews,
    followers: d.followers ?? null,
    likes: d.likes ?? null,
    comments: d.comments ?? null,
    shares: d.shares ?? null,
    saves: d.saves ?? null,
    retentionRate: d.retentionRate ?? null,
    postedAt: d.postedAt ?? null,
    status: d.editProfileStatus ?? 'none',
    error: d.editProfileError ?? null,
    canReprofile: Boolean(d.editorSourceKey),
    profile: d.editProfile ?? null,
    createdAt: d.createdAt,
});

/** Run profiling in the background on a local copy, then delete the copy. */
const profileInBackground = (id, filePath) => {
    setImmediate(() => {
        void profileGate.run(() => profileExample(id, filePath)).finally(() => fs.promises.unlink(filePath).catch(() => {}));
    });
};

export async function listExamples(req, res, next) {
    try {
        const docs = await VideoPerformanceDataset.find({}).sort({ createdAt: -1 }).limit(300).lean();
        const counts = { total: docs.length, ready: docs.filter((d) => d.editProfileStatus === 'ready').length };
        res.json({ ok: true, counts, examples: docs.map(toExample), claude: isClaudeConfigured(), storage: isStorageConfigured() });
    } catch (err) {
        next(err);
    }
}

export async function createExample(req, res, next) {
    const file = req.file;
    try {
        if (!file) throw new ApiError(400, 'Choose a video file.');
        if (!isClaudeConfigured()) throw new ApiError(503, 'Set ANTHROPIC_API_KEY before adding examples (the edit profile is built with Claude).');
        const b = req.body ?? {};
        const platform = String(b.platform || '').toLowerCase();
        if (!PLATFORMS.includes(platform)) throw new ApiError(400, 'Pick a platform.');
        const actualViews = num(b.actualViews);
        if (actualViews == null) throw new ApiError(400, 'Views are required.');

        const doc = await VideoPerformanceDataset.create({
            sourceType: 'creator_video',
            filename: text(file.originalname, 200) ?? 'video',
            platform,
            niche: text(b.niche),
            creatorHandle: text(b.creatorHandle),
            actualViews,
            followers: num(b.followers),
            likes: num(b.likes),
            comments: num(b.comments),
            shares: num(b.shares),
            saves: num(b.saves),
            retentionRate: num(b.retentionRate),
            postedAt: date(b.postedAt),
            status: 'complete',
            editProfileStatus: 'pending',
        });

        if (isStorageConfigured()) {
            const key = `editor/examples/${doc._id}/source${path.extname(file.originalname || '.mp4').toLowerCase() || '.mp4'}`;
            try {
                await storage.uploadFile(file.path, key, file.mimetype);
                await VideoPerformanceDataset.updateOne({ _id: doc._id }, { $set: { editorSourceKey: key } });
            } catch (err) {
                console.warn('[Editor] Could not keep the example file:', err.message);
            }
        }
        profileInBackground(String(doc._id), file.path);
        res.status(202).json({ ok: true, example: toExample(doc.toObject()) });
    } catch (err) {
        await removeTemp(file);
        next(err);
    }
}

export async function reprofileExample(req, res, next) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 'Example not found');
        const doc = await VideoPerformanceDataset.findById(req.params.id).lean();
        if (!doc) throw new ApiError(404, 'Example not found');
        if (!doc.editorSourceKey || !isStorageConfigured()) throw new ApiError(400, 'The original file was not kept, so this example cannot be re-profiled. Upload it again.');
        const local = path.join(os.tmpdir(), 'vireact-admin-uploads', `${doc._id}-${Date.now()}${path.extname(doc.editorSourceKey)}`);
        await fs.promises.mkdir(path.dirname(local), { recursive: true });
        await storage.downloadToFile(doc.editorSourceKey, local);
        await VideoPerformanceDataset.updateOne({ _id: doc._id }, { $set: { editProfileStatus: 'pending', editProfileError: null } });
        profileInBackground(String(doc._id), local);
        res.status(202).json({ ok: true });
    } catch (err) {
        next(err);
    }
}

export async function updateExample(req, res, next) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 'Example not found');
        const b = req.body ?? {};
        const set = {};
        for (const k of ['actualViews', 'followers', 'likes', 'comments', 'shares', 'saves', 'retentionRate']) if (k in b) set[k] = num(b[k]) ?? null;
        if ('niche' in b) set.niche = text(b.niche) ?? null;
        if ('platform' in b) {
            if (!PLATFORMS.includes(b.platform)) throw new ApiError(400, 'Unknown platform');
            set.platform = b.platform;
        }
        if (set.actualViews === null) throw new ApiError(400, 'Views are required.');
        const doc = await VideoPerformanceDataset.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();
        if (!doc) throw new ApiError(404, 'Example not found');
        res.json({ ok: true, example: toExample(doc) });
    } catch (err) {
        next(err);
    }
}

export async function deleteExample(req, res, next) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 'Example not found');
        const doc = await VideoPerformanceDataset.findByIdAndDelete(req.params.id).lean();
        if (!doc) throw new ApiError(404, 'Example not found');
        await KnowledgeBase.deleteMany({ 'metadata.source': `editor_example:${doc._id}` });
        if (doc.editorSourceKey && isStorageConfigured()) await storage.deletePrefix(`editor/examples/${doc._id}/`).catch(() => {});
        res.json({ ok: true });
    } catch (err) {
        next(err);
    }
}

const toSound = (s) => ({
    id: String(s._id),
    kind: s.kind,
    slug: s.slug,
    title: s.title,
    mood: s.mood,
    energy: s.energy,
    bpm: s.bpm,
    genre: s.genre,
    sfxType: s.sfxType,
    durationSec: s.durationSec,
    licenseSource: s.licenseSource,
    attribution: s.attribution,
    active: s.active,
});

export async function listSounds(req, res, next) {
    try {
        const sounds = await SoundAsset.find({}).sort({ kind: 1, createdAt: -1 }).lean();
        res.json({ ok: true, sounds: sounds.map(toSound), moods: MUSIC_MOODS, sfxTypes: SFX_TYPES, storage: isStorageConfigured() });
    } catch (err) {
        next(err);
    }
}

export async function createSound(req, res, next) {
    const file = req.file;
    try {
        if (!file) throw new ApiError(400, 'Choose an audio file.');
        if (!isStorageConfigured()) throw new ApiError(503, 'Storage (S3) must be set up before adding sounds.');
        const b = req.body ?? {};
        const kind = b.kind === 'sfx' ? 'sfx' : 'music';
        const licenseSource = text(b.licenseSource, 200);
        if (!licenseSource) throw new ApiError(400, 'Record where the license comes from (for example "Pixabay Music license").');
        const title = text(b.title, 120);
        if (!title) throw new ApiError(400, 'Add a title.');
        const base = (text(b.slug, 40) ?? `${kind === 'sfx' ? 'sfx' : 'm'}_${title}`).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 34);
        let slug = base.length >= 3 ? base : `${kind}_${base}`.slice(0, 34);
        if (await SoundAsset.exists({ slug })) slug = `${slug}_${Date.now().toString(36).slice(-4)}`;
        if (kind === 'sfx' && !SFX_TYPES.includes(b.sfxType)) throw new ApiError(400, `Pick the effect type (${SFX_TYPES.join(', ')}).`);
        if (kind === 'music' && b.mood && !MUSIC_MOODS.includes(b.mood)) throw new ApiError(400, 'Unknown mood.');

        let durationSec = null;
        try {
            const { stdout } = await ffprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file.path]);
            durationSec = Math.round(Number(stdout.trim()) * 10) / 10 || null;
        } catch {
            throw new ApiError(400, 'That file could not be read as audio.');
        }
        const ext = path.extname(file.originalname || '.mp3').toLowerCase() || '.mp3';
        const key = `editor/library/${kind}/${slug}${ext}`;
        await storage.uploadFile(file.path, key, file.mimetype);
        const sound = await SoundAsset.create({
            kind,
            slug,
            title,
            key,
            contentType: file.mimetype,
            durationSec,
            sizeBytes: file.size,
            mood: kind === 'music' ? b.mood || null : null,
            energy: kind === 'music' && num(b.energy) ? Math.min(5, Math.max(1, Math.round(num(b.energy)))) : null,
            bpm: kind === 'music' ? num(b.bpm) ?? null : null,
            genre: kind === 'music' ? text(b.genre, 60) ?? null : null,
            sfxType: kind === 'sfx' ? b.sfxType : null,
            licenseSource,
            attribution: text(b.attribution, 300) ?? null,
        });
        res.status(201).json({ ok: true, sound: toSound(sound.toObject()) });
    } catch (err) {
        next(err);
    } finally {
        await removeTemp(file);
    }
}

export async function updateSound(req, res, next) {
    try {
        if (!mongoose.isValidObjectId(req.params.id)) throw new ApiError(404, 'Sound not found');
        const set = {};
        if ('active' in (req.body ?? {})) set.active = req.body.active === true;
        if (text(req.body?.title, 120)) set.title = text(req.body.title, 120);
        const sound = await SoundAsset.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();
        if (!sound) throw new ApiError(404, 'Sound not found');
        res.json({ ok: true, sound: toSound(sound) });
    } catch (err) {
        next(err);
    }
}

