import express from 'express';
import { authenticateToken } from '../middleware/auth.js';

import {
    getSubscription,
    createCheckoutSession,
    createPortal,
    previewChange,
    changePlan,
    cancelSubscription
} from '../controller/subscription.controller.js';

const router = express.Router();

// Get current subscription and usage
router.get('/', authenticateToken, getSubscription);

// Create Stripe checkout session
router.post('/checkout', authenticateToken, createCheckoutSession);

// Create Stripe Customer Portal session for billing management
router.post('/portal', authenticateToken, createPortal);

// Preview proration for a plan change (no charge)
router.post('/preview-change', authenticateToken, previewChange);

// Execute plan change with immediate proration
router.post('/change-plan', authenticateToken, changePlan);

// Note: Webhook route is handled directly in app.js before express.json() middleware
// This is required for Stripe signature verification to work with raw body

// Cancel subscription
router.post('/cancel', authenticateToken, cancelSubscription);

export default router;

