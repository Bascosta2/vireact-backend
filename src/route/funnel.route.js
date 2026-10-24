import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { optionalAuth } from '../middleware/auth.js';
import { isFunnelV2Enabled } from '../config/flags.js';
import { ApiError } from '../utils/ApiError.js';
import {
    postSession,
    patchSession,
    postComplete,
    getResults,
    postEmail,
    postHookRewrite,
} from '../controller/funnel.controller.js';

const ipKey = (req) => ipKeyGenerator(req.ip || req.socket?.remoteAddress || '');
const limiter = (windowMs, max) =>
    rateLimit({
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: ipKey,
        message: { error: 'Too many requests, please try again later' },
    });

const funnelRoutes = Router();

funnelRoutes.use((req, res, next) => {
    if (!isFunnelV2Enabled()) return next(new ApiError(404, 'Not found'));
    next();
});
funnelRoutes.use(limiter(10 * 60 * 1000, 200));
funnelRoutes.use(optionalAuth);

funnelRoutes.post('/sessions', limiter(60 * 60 * 1000, 30), postSession);
funnelRoutes.patch('/sessions/:id', patchSession);
funnelRoutes.post('/sessions/:id/complete', postComplete);
funnelRoutes.get('/sessions/:id/results', getResults);
funnelRoutes.post('/sessions/:id/email', limiter(60 * 60 * 1000, 10), postEmail);
funnelRoutes.post('/hook-rewrite', limiter(60 * 1000, 10), postHookRewrite);

export default funnelRoutes;
