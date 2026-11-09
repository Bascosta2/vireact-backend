import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import {
    getAnalyticsOverview,
    getAnalyticsVideos,
    getCreatorProfile,
    updateCreatorProfile,
    getStrategy,
    createStrategy,
    updateStrategySlot,
} from '../controller/analytics.controller.js';

const analyticsRoutes = Router();

analyticsRoutes.use(authenticateToken);

analyticsRoutes.get('/overview', getAnalyticsOverview);
analyticsRoutes.get('/videos', getAnalyticsVideos);
analyticsRoutes.get('/profile', getCreatorProfile);
analyticsRoutes.put('/profile', updateCreatorProfile);

// AI content strategy (Premium and up, capped per billing period)
analyticsRoutes.get('/strategy', getStrategy);
analyticsRoutes.post('/strategy', createStrategy);
analyticsRoutes.patch('/strategy/:id/slots/:slotId', updateStrategySlot);

export default analyticsRoutes;
