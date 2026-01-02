import {
    getOrCreateSubscription,
    createCheckoutSession as createCheckoutSessionService,
    cancelSubscription as cancelSubscriptionService,
    handleStripeWebhook
} from '../service/subscription.service.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { PLAN_LIMITS } from '../constants.js';
import stripe from '../lib/stripe.js';
import { STRIPE_WEBHOOK_SECRET } from '../config/index.js';

// GET /subscription - Get current subscription and usage
export const getSubscription = async (req, res, next) => {
    try {
        const userId = req.user._id;

        const subscription = await getOrCreateSubscription(userId);
        const limits = PLAN_LIMITS[subscription.plan];

        res.status(200).json(
            ApiResponse.success(
                200,
                'Subscription fetched successfully',
                {
                    subscription,
                    limits
                }
            )
        );
    } catch (error) {
        next(error);
    }
};

// POST /subscription/checkout - Create Stripe checkout session
export const createCheckoutSession = async (req, res, next) => {
    try {
        const userId = req.user._id;
        const userEmail = req.user.email;
        const { plan } = req.body;

        if (!plan) {
            throw new ApiError(400, 'Plan is required');
        }

        const { url, sessionId } = await createCheckoutSessionService(userId, userEmail, plan);

        res.status(200).json(
            ApiResponse.success(
                200,
                'Checkout session created successfully',
                { url, sessionId }
            )
        );
    } catch (error) {
        next(error);
    }
};

// POST /subscription/webhook - Handle Stripe webhooks
export const handleWebhook = async (req, res, next) => {
    if (!stripe) {
        return res.status(500).json(
            ApiResponse.error(500, 'Stripe is not configured')
        );
    }

    const sig = req.headers['stripe-signature'];

    if (!sig) {
        console.error('[Stripe Webhook] Missing stripe-signature header');
        return res.status(400).json(
            ApiResponse.error(400, 'Missing stripe-signature header')
        );
    }

    let event;

    try {
        // Verify webhook signature
        if (STRIPE_WEBHOOK_SECRET) {
            event = stripe.webhooks.constructEvent(
                req.body,
                sig,
                STRIPE_WEBHOOK_SECRET
            );
        } else {
            // In development without webhook secret, parse body directly
            console.warn('[Stripe Webhook] No webhook secret configured - skipping signature verification');
            event = JSON.parse(req.body.toString());
        }
    } catch (err) {
        console.error('[Stripe Webhook] Signature verification failed:', err.message);
        return res.status(400).json(
            ApiResponse.error(400, `Webhook signature verification failed: ${err.message}`)
        );
    }

    try {
        await handleStripeWebhook(event);

        res.status(200).json(
            ApiResponse.success(200, 'Webhook processed successfully', null)
        );
    } catch (error) {
        console.error('[Stripe Webhook] Error processing webhook:', error);
        next(error);
    }
};

// POST /subscription/cancel - Cancel subscription
export const cancelSubscription = async (req, res, next) => {
    try {
        const userId = req.user._id;

        const subscription = await cancelSubscriptionService(userId);

        res.status(200).json(
            ApiResponse.success(
                200,
                'Subscription cancelled successfully. You have been downgraded to the FREE plan.',
                { subscription }
            )
        );
    } catch (error) {
        next(error);
    }
};

