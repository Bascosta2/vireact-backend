/**
 * Real results the creator logs after posting: when/where it was posted, and view snapshots over time.
 *
 * Invariant: video.actualViews / actualViewsReportedAt always mirror the newest snapshot, so the
 * prediction code that reads actualViews (view-prediction.service.js) keeps working unchanged.
 */
import mongoose from 'mongoose';
import { Video } from '../model/video.model.js';
import { ApiError } from '../utils/ApiError.js';
import { normalizeFollowers, normalizePlatform } from './view-prediction.service.js';

export const MAX_SNAPSHOTS = 20;
const MAX_URL_LENGTH = 500;
// A post date can't be in the future (small allowance for clock skew) or absurdly old.
const FUTURE_SKEW_MS = 10 * 60 * 1000;
const EARLIEST_POST = Date.UTC(2005, 0, 1);

const OPTIONAL_COUNTS = ['likes', 'comments', 'shares', 'saves'];

/** http(s) URL, trimmed, max 500 chars. '' or null clears it. Returns undefined when invalid. */
export const normalizePostUrl = (value) => {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim();
    if (raw === '') return null;
    if (raw.length > MAX_URL_LENGTH) return undefined;
    try {
        const url = new URL(raw);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
    } catch {
        return undefined;
    }
};

/** A Date within [2005, now]. null/'' clears. Returns undefined when invalid. */
export const normalizePastDate = (value, now = Date.now()) => {
    if (value === null || value === undefined || value === '') return null;
    const date = new Date(value);
    const t = date.getTime();
    if (!Number.isFinite(t) || t < EARLIEST_POST || t > now + FUTURE_SKEW_MS) return undefined;
    return date;
};

/** Validates a snapshot body. Throws ApiError(400) with a user-facing message. */
export const normalizeSnapshotInput = (body = {}, now = Date.now()) => {
    const views = normalizeFollowers(body.views);
    if (views == null) throw new ApiError(400, 'Enter the number of views as a whole number.');
    const snapshot = { views, source: 'manual' };
    for (const key of OPTIONAL_COUNTS) {
        if (body[key] === undefined || body[key] === null || body[key] === '') continue;
        const n = normalizeFollowers(body[key]);
        if (n == null) throw new ApiError(400, `Enter ${key} as a whole number.`);
        snapshot[key] = n;
    }
    const capturedAt = body.capturedAt === undefined ? new Date(now) : normalizePastDate(body.capturedAt, now);
    if (!capturedAt) throw new ApiError(400, 'That date is not valid.');
    snapshot.capturedAt = capturedAt;
    return snapshot;
};

const byCapturedAt = (a, b) => new Date(a.capturedAt) - new Date(b.capturedAt);

export const latestSnapshot = (snapshots = []) =>
    snapshots.length ? [...snapshots].sort(byCapturedAt)[snapshots.length - 1] : null;

/** Mutates a Video doc so actualViews mirrors the newest snapshot (or clears it). */
const syncActualViews = (video) => {
    const latest = latestSnapshot(video.performanceSnapshots);
    video.actualViews = latest ? latest.views : null;
    video.actualViewsReportedAt = latest ? latest.capturedAt : null;
};

const loadOwnedVideo = async (userId, videoId) => {
    if (!mongoose.isValidObjectId(videoId)) throw new ApiError(404, 'Video not found');
    const video = await Video.findOne({ _id: videoId, uploader_id: userId });
    if (!video) throw new ApiError(404, 'Video not found');
    return video;
};

export const toPerformanceResponse = (video) => ({
    videoId: String(video._id),
    postedAt: video.postedAt ?? null,
    postUrl: video.postUrl ?? null,
    creatorPlatform: video.creatorPlatform ?? null,
    creatorFollowers: video.creatorFollowers ?? null,
    actualViews: video.actualViews ?? null,
    actualViewsReportedAt: video.actualViewsReportedAt ?? null,
    snapshots: [...(video.performanceSnapshots ?? [])].sort(byCapturedAt).map((s) => ({
        id: String(s._id),
        capturedAt: s.capturedAt,
        views: s.views,
        likes: s.likes ?? null,
        comments: s.comments ?? null,
        shares: s.shares ?? null,
        saves: s.saves ?? null,
        source: s.source ?? 'manual',
    })),
});

/** Adds a snapshot; keeps the newest MAX_SNAPSHOTS. Optional platform / followers update creator context. */
export const addSnapshot = async (userId, videoId, body = {}) => {
    const snapshot = normalizeSnapshotInput(body);
    const video = await loadOwnedVideo(userId, videoId);
    const snapshots = [...video.performanceSnapshots, snapshot].sort(byCapturedAt);
    video.performanceSnapshots = snapshots.slice(-MAX_SNAPSHOTS);
    syncActualViews(video);
    const platform = normalizePlatform(body.platform);
    if (platform) video.creatorPlatform = platform;
    const followers = normalizeFollowers(body.followers);
    if (followers != null) video.creatorFollowers = followers;
    await video.save();
    return toPerformanceResponse(video);
};

export const deleteSnapshot = async (userId, videoId, snapshotId) => {
    const video = await loadOwnedVideo(userId, videoId);
    const before = video.performanceSnapshots.length;
    video.performanceSnapshots = video.performanceSnapshots.filter((s) => String(s._id) !== String(snapshotId));
    if (video.performanceSnapshots.length === before) throw new ApiError(404, 'That entry was not found.');
    syncActualViews(video);
    await video.save();
    return toPerformanceResponse(video);
};

/** Sets post date / URL / platform. Only keys present in the body change. */
export const setPostDetails = async (userId, videoId, body = {}) => {
    const update = {};
    if ('postedAt' in body) {
        const postedAt = normalizePastDate(body.postedAt);
        if (postedAt === undefined) throw new ApiError(400, 'Enter a post date that is not in the future.');
        update.postedAt = postedAt;
    }
    if ('postUrl' in body) {
        const postUrl = normalizePostUrl(body.postUrl);
        if (postUrl === undefined) throw new ApiError(400, 'Enter a full link starting with https://');
        update.postUrl = postUrl;
    }
    if ('platform' in body) {
        const platform = normalizePlatform(body.platform);
        if (!platform && body.platform) throw new ApiError(400, 'Pick a platform from the list.');
        update.creatorPlatform = platform;
    }
    const video = await loadOwnedVideo(userId, videoId);
    Object.assign(video, update);
    await video.save();
    return toPerformanceResponse(video);
};

export const getPerformance = async (userId, videoId) => toPerformanceResponse(await loadOwnedVideo(userId, videoId));

/**
 * One-off: give every video with a legacy actualViews (reported before snapshots existed) a matching
 * snapshot. Idempotent: only touches videos that have actualViews and no snapshots yet.
 */
export const migrateLegacyActualViews = async ({ dryRun = false } = {}) => {
    const filter = { actualViews: { $ne: null }, 'performanceSnapshots.0': { $exists: false } };
    const legacy = await Video.find(filter).select('_id actualViews actualViewsReportedAt updatedAt').lean();
    if (dryRun || legacy.length === 0) return { matched: legacy.length, modified: 0 };
    const ops = legacy.map((v) => ({
        updateOne: {
            filter: { _id: v._id, 'performanceSnapshots.0': { $exists: false } },
            update: {
                $set: {
                    performanceSnapshots: [{
                        _id: new mongoose.Types.ObjectId(),
                        capturedAt: v.actualViewsReportedAt ?? v.updatedAt ?? new Date(),
                        views: v.actualViews,
                        source: 'manual',
                    }],
                },
            },
        },
    }));
    const result = await Video.bulkWrite(ops, { ordered: false });
    return { matched: legacy.length, modified: result.modifiedCount };
};
