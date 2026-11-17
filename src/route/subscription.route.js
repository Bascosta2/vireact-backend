import express from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { authenticateToken } from '../middleware/auth.js';

import {
    getSubscription,
    createCheckoutSession,
    createPortal,
    previewChange,
    changePlan,
    cancelSubscription,
    redeemPromo
} from '../controller/subscription.controller.js';

/** Promo codes are words, so stop anyone guessing them: 10 tries per account and network per 15 minutes. */
const promoRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${req.user?._id?.toString() || 'anon'}:${ipKeyGenerator(req.ip || req.socket?.remoteAddress || '')}`,
    message: { success: false, statusCode: 429, message: 'Too many promo code attempts. Try again in 15 minutes.', data: { code: 'PROMO_RATE_LIMIT' } },
});

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

// Redeem a promo code
router.post('/promo', authenticateToken, promoRateLimit, redeemPromo);

export default router;

