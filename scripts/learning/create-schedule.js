/**
 * Create (or replace) the QStash schedule that calls POST /api/v1/learning/run daily at 01:30 New York time.
 *
 *   node scripts/learning/create-schedule.js            # dry run: print what would be created
 *   node scripts/learning/create-schedule.js --apply
 *
 * Needs QSTASH_TOKEN and BACKEND_URL (the public API origin). The job itself does nothing until
 * LEARNING_ENABLED=true is set on the backend.
 */
import '../../src/config/load-env.js';
import { flag, value } from '../research/_db.js';
import { getQStashClient } from '../../src/lib/qstash.js';

export const LEARNING_SCHEDULE_CRON = 'CRON_TZ=America/New_York 30 1 * * *';
const SCHEDULE_ID = 'vireact-learning-daily';

const base = (value('--backend') || process.env.BACKEND_URL || '').replace(/\/+$/, '');
if (!/^https:\/\//.test(base)) {
    console.log('Set BACKEND_URL (https://...) or pass --backend https://your-api');
    process.exit(1);
}
const destination = `${base}/api/v1/learning/run`;
console.log(`Schedule ${SCHEDULE_ID}: POST ${destination}  cron "${LEARNING_SCHEDULE_CRON}"`);
if (!flag('--apply')) {
    console.log('Dry run. Re-run with --apply to create it.');
    process.exit(0);
}
const client = getQStashClient();
const result = await client.schedules.create({
    scheduleId: SCHEDULE_ID,
    destination,
    cron: LEARNING_SCHEDULE_CRON,
    method: 'POST',
    body: '{}',
    headers: { 'Content-Type': 'application/json' },
    retries: 1,
});
console.log(`Created schedule ${result.scheduleId}`);
