import Stripe from 'stripe';
import { STRIPE_SECRET_KEY } from '../config/index.js';

if (!STRIPE_SECRET_KEY) {
    console.warn('STRIPE_SECRET_KEY is not defined in environment variables. Stripe functionality will be disabled.');
}

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, {
    apiVersion: '2024-11-20.acacia'
}) : null;

export default stripe;

