/**
 * Create missing schema indexes explicitly (MONGO_AUTO_INDEX is off by default).
 *
 *   node scripts/ensure-indexes.js            # dry run (default): print the plan
 *   node scripts/ensure-indexes.js --apply    # create the planned indexes
 *
 * Create-only: never drops anything. Never touches `knowledgebases`.
 * Outside NODE_ENV=production the database-name guard applies; running against
 * production from a laptop requires ALLOW_PROD_DB_IN_DEV=true on purpose.
 */
import '../src/config/load-env.js';
import mongoose from 'mongoose';
import { assertSafeDatabase } from '../src/config/env-guards.js';
import { DB_URL, DB_NAME } from '../src/config/index.js';
import { planIndexes, formatPlan, applyPlan } from '../src/db/index-plan.js';
import { User } from '../src/model/user.model.js';
import { Admin } from '../src/model/admin.model.js';
import { Video } from '../src/model/video.model.js';
import { Chat } from '../src/model/chat.model.js';
import { Subscription } from '../src/model/subscription.model.js';
import { StripeWebhookEvent } from '../src/model/stripe-webhook-event.model.js';
import { EarlyAccess } from '../src/model/early-access.model.js';
import { VideoPerformanceDataset } from '../src/model/VideoPerformanceDataset.model.js';
import { LibraryItem } from '../src/model/library-item.model.js';
import { FunnelSession } from '../src/model/funnel-session.model.js';
import { RewriteUsage } from '../src/model/rewrite-usage.model.js';
import { KbCandidate } from '../src/model/kb-candidate.model.js';
import { KbResearchRun } from '../src/model/kb-research-run.model.js';
import { ErrorEvent } from '../src/model/error-event.model.js';

const MODELS = [
    User, Admin, Video, Chat, Subscription, StripeWebhookEvent, EarlyAccess, VideoPerformanceDataset,
    LibraryItem, FunnelSession, RewriteUsage, KbCandidate, KbResearchRun, ErrorEvent,
];

const apply = process.argv.includes('--apply');

assertSafeDatabase();
await mongoose.connect(DB_URL, { dbName: DB_NAME, autoIndex: false, autoCreate: false });
try {
    console.log(`Database: ${mongoose.connection.db.databaseName}  mode: ${apply ? 'APPLY' : 'dry run'}`);
    const plan = await planIndexes(MODELS);
    console.log(formatPlan(plan));
    if (apply) {
        const created = await applyPlan(MODELS, plan);
        console.log(`Created ${created.length} index(es)${created.length ? ': ' + created.join(', ') : ''}`);
    } else {
        const total = plan.reduce((n, e) => n + e.toCreate.length, 0);
        console.log(`Dry run: ${total} index(es) would be created. Re-run with --apply to create them.`);
    }
} finally {
    await mongoose.disconnect();
}
