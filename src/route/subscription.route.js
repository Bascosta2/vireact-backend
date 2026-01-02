import express from 'express';
import { authenticateToken } from '../middleware/auth.js';

import {
    getSubscription,
    createCheckoutSession,
    cancelSubscription
} from '../controller/subscription.controller.js';

const router = express.Router();

// Get current subscription and usage
router.get('/', authenticateToken, getSubscription);

// Create Stripe checkout session
router.post('/checkout', authenticateToken, createCheckoutSession);

// Note: Webhook route is handled directly in app.js before express.json() middleware
// This is required for Stripe signature verification to work with raw body

// Cancel subscription
router.post('/cancel', authenticateToken, cancelSubscription);

export default router;

