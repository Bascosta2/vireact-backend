/**
 * Read-only pre-merge check for the billing status fix (PR "close easy payment holes").
 * Finds subscriptions on a paid plan whose status is not active/trial (after the fix those get Free
 * features) and compares each one with Stripe. Prints counts and internal subscription ids only:
 * no names, emails or user ids. Writes nothing to MongoDB or Stripe.
 *
 *   railway run node scripts/check-paid-status.js
 */
import '../src/config/load-env.js';
import mongoose from 'mongoose';
import { assertSafeDatabase } from '../src/config/env-guards.js';
import { DB_URL, DB_NAME } from '../src/config/index.js';
import stripe from '../src/lib/stripe.js';
import { Subscription } from '../src/model/subscription.model.js';
import { mapStripeStatus } from '../src/service/subscription.service.js';
import { effectivePlan } from '../src/service/access.service.js';

assertSafeDatabase();

const QUERY = { plan: { $ne: 'free' }, status: { $nin: ['active', 'trial'] } };

async function stripeStatus(id) {
    if (!id) return 'no Stripe subscription';
    if (!stripe) return 'Stripe not configured';
    try {
        return (await stripe.subscriptions.retrieve(id)).status;
    } catch (err) {
        return err?.code === 'resource_missing' ? 'missing in Stripe' : `lookup failed (${err?.type ?? 'error'})`;
    }
}

async function run() {
    if (!DB_URL) throw new Error('DB_URL is not set');
    // autoIndex/autoCreate off: this script must not write anything, indexes included.
    await mongoose.connect(DB_URL, { dbName: DB_NAME || undefined, autoIndex: false, autoCreate: false });

    const rows = await Subscription.find(QUERY).select('_id plan status promo stripeSubscriptionId paymentFailed').lean();
    console.log(`Paid-plan subscriptions not active/trial: ${rows.length}`);
    if (rows.length === 0) {
        console.log('Nothing to check. Safe to merge.');
        return;
    }

    let match = 0;
    let mismatch = 0;
    for (const row of rows) {
        const remote = await stripeStatus(row.stripeSubscriptionId);
        const same = mapStripeStatus(remote) === row.status;
        if (same) match += 1; else mismatch += 1;
        console.log([
            `sub ${row._id}`,
            `plan=${row.plan}`,
            `local=${row.status}`,
            `stripe=${remote}`,
            same ? 'MATCH' : 'MISMATCH',
            `after merge gets=${effectivePlan(row)}`,
            row.paymentFailed ? 'paymentFailed' : '',
        ].filter(Boolean).join('  '));
    }
    console.log(`\nMatch: ${match}  Mismatch: ${mismatch}`);
    if (mismatch) console.log('Check each MISMATCH row in Stripe before merging: a paying customer must not be on "after merge gets=free".');
}

run()
    .catch((err) => { console.error(`Check failed: ${err.message}`); process.exitCode = 1; })
    .finally(() => mongoose.disconnect());
