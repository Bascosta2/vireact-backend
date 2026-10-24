import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { optionalAuth } from '../middleware/auth.js';
import { isLibraryEnabled } from '../config/flags.js';
import { ApiError } from '../utils/ApiError.js';
import { getLibraryItems, getLibraryItem, getLibraryStats, getRecommended } from '../controller/library.controller.js';

const libraryRoutes = Router();

libraryRoutes.use((req, res, next) => {
    if (!isLibraryEnabled()) return next(new ApiError(404, 'Not found'));
    next();
});

libraryRoutes.use(
    rateLimit({
        windowMs: 60 * 1000,
        max: 120,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: (req) => ipKeyGenerator(req.ip || req.socket?.remoteAddress || ''),
        message: { error: 'Too many requests, please try again shortly' },
    })
);

libraryRoutes.use(optionalAuth);

libraryRoutes.get('/items', getLibraryItems);
libraryRoutes.get('/items/:slug', getLibraryItem);
libraryRoutes.get('/stats', getLibraryStats);
libraryRoutes.get('/recommended', getRecommended);

export default libraryRoutes;
