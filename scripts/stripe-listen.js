/**
 * Local Stripe webhook forwarding (test mode only).
 * Run from vireact-backend: npm run stripe:listen
 * The Stripe CLI login defaults to live mode, so the test key from .env.local / .env
 * is handed to the CLI via STRIPE_API_KEY. Refuses to run with anything but an sk_test_ key.
 */
import { spawn } from 'node:child_process';
import '../src/config/load-env.js';

const key = process.env.STRIPE_SECRET_KEY || '';
if (!key.startsWith('sk_test_')) {
    console.error('stripe:listen refused: STRIPE_SECRET_KEY is not a test-mode key (expected sk_test_ in .env.local).');
    process.exit(1);
}

const events = [
    'checkout.session.completed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'customer.subscription.trial_will_end',
    'invoice.payment_succeeded',
    'invoice.payment_failed',
].join(',');

const child = spawn(
    'stripe',
    ['listen', '--forward-to', 'localhost:5000/api/v1/subscription/webhook', '--events', events],
    { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, STRIPE_API_KEY: key } }
);
child.on('exit', (code) => process.exit(code ?? 0));
