import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticateToken } from '../middleware/auth.js';
import {
    requirePublishingAccess, getPublishCapabilities, getScheduledPosts, getTikTokCreator, createPost, updatePost, cancelPost,
} from '../controller/posts.controller.js';

/** Scheduled posting to connected accounts. The QStash webhook (/jobs/run) is mounted in app.js. */
const postsRoutes = Router();

// Changes are limited per user: each one can queue work and calls to the platforms.
const writeLimit = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `posts:${String(req.user?._id)}`,
    message: { success: false, message: 'Too many changes to scheduled posts. Try again in a few minutes.' },
});

// TikTok allows 20 creator_info calls a minute per user; answers are reused for 30 s (publish.service.js).
const creatorInfoLimit = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `posts-creator-info:${String(req.user?._id)}`,
    message: { success: false, message: 'Too many TikTok account checks. Try again in a minute.' },
});

postsRoutes.use(authenticateToken);
// Open to every signed-in user: it is how the web app learns scheduling is hidden.
postsRoutes.get('/capabilities', getPublishCapabilities);
postsRoutes.use(requirePublishingAccess);
postsRoutes.get('/', getScheduledPosts);
postsRoutes.get('/tiktok/creator-info', creatorInfoLimit, getTikTokCreator);
postsRoutes.post('/', writeLimit, createPost);
postsRoutes.patch('/:id', writeLimit, updatePost);
postsRoutes.delete('/:id', writeLimit, cancelPost);

export default postsRoutes;
