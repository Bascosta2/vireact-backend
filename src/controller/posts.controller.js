import mongoose from 'mongoose';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { hasPublishingAccess } from '../config/flags.js';
import { captureServerEvent } from '../lib/analytics.js';
import { isShuttingDown } from '../queue/analysis-runtime.js';
import {
    cancelScheduledPost, createScheduledPost, getCapabilities, listScheduledPosts, updateScheduledPost,
} from '../service/publish/publish.service.js';
import { runPublishJob } from '../service/publish/publish-job.js';

const ok = (res, message, data, status = 200) => res.status(status).json(ApiResponse.success(status, message, data));
const track = (req, event, properties) => {
    try { captureServerEvent(String(req.user._id), event, properties); } catch { /* analytics never fails a request */ }
};

/** Outside the beta: same answer as a route that does not exist. */
export const requirePublishingAccess = (req, res, next) => {
    if (!hasPublishingAccess(req.user)) return next(new ApiError(404, 'Not found'));
    return next();
};

/** Open to every signed-in user: `enabled` is how the web app knows whether to show scheduling. */
export const getPublishCapabilities = async (req, res) => ok(res, 'OK', await getCapabilities(req.user));

export const getScheduledPosts = async (req, res) => ok(res, 'OK', await listScheduledPosts(req.user._id, { from: req.query.from, to: req.query.to }));

export const createPost = async (req, res) => {
    const post = await createScheduledPost(req.user._id, req.body ?? {});
    track(req, 'post_scheduled', { platforms: post.targets.map((t) => t.platform), mode: post.mode, from_project: Boolean(post.projectId) });
    return ok(res, 'Scheduled', { post }, 201);
};

export const updatePost = async (req, res) => ok(res, 'Saved', { post: await updateScheduledPost(req.user._id, req.params.id, req.body ?? {}) });

export const cancelPost = async (req, res) => {
    const post = await cancelScheduledPost(req.user._id, req.params.id);
    track(req, 'post_cancelled', {});
    return ok(res, 'Cancelled', { post });
};

/**
 * QStash (signed, mounted in app.js): one publishing pass. Answers after the pass so a crash makes QStash
 * deliver again; the post's lease stops two passes from running at once.
 */
export const runPublishWebhook = async (req, res) => {
    const postId = req.body?.postId;
    if (!postId || !mongoose.isValidObjectId(postId)) return res.status(200).json({ received: true });
    if (isShuttingDown()) return res.status(503).json({ received: false, retry: true });
    try {
        const version = Number.isInteger(req.body?.version) ? req.body.version : null;
        const result = await runPublishJob(String(postId), { version });
        return res.status(200).json({ received: true, ...result });
    } catch (err) {
        console.error('[publish] pass failed:', err.message);
        return res.status(500).json({ received: false, retry: true });
    }
};
