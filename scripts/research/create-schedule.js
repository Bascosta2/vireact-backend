/**
 * Create (or replace) the QStash schedule that calls POST /api/v1/research/run daily at 06:45 New York time.
 *
 *   node scripts/research/create-schedule.js            # dry run: print what would be created
 *   node scripts/research/create-schedule.js --apply
 *
 * QStash supports a CRON_TZ prefix, so the run stays at 06:45 America/New_York across daylight saving
 * (11:45 UTC in winter, 10:45 UTC in summer). Needs QSTASH_TOKEN and BACKEND_URL (the public API origin).
 */
import '../../src/config/load-env.js';
import { flag, value } from './_db.js';
import { getQStashClient } from '../../src/lib/qstash.js';

export const RESEARCH_SCHEDULE_CRON = 'CRON_TZ=America/New_York 45 6 * * *';
const SCHEDULE_ID = 'vireact-research-ingest';

const base = (value('--backend') || process.env.BACKEND_URL || '').replace(/\/+$/, '');
if (!/^https:\/\//.test(base)) {
    console.log('Set BACKEND_URL (https://...) or pass --backend https://your-api');
    process.exit(1);
}
const destination = `${base}/api/v1/research/run`;
console.log(`Schedule ${SCHEDULE_ID}: POST ${destination}  cron "${RESEARCH_SCHEDULE_CRON}"`);
if (!flag('--apply')) {
    console.log('Dry run. Re-run with --apply to create it.');
    process.exit(0);
}
const client = getQStashClient();
const result = await client.schedules.create({
    scheduleId: SCHEDULE_ID,
    destination,
    cron: RESEARCH_SCHEDULE_CRON,
    method: 'POST',
    body: '{}',
    headers: { 'Content-Type': 'application/json' },
    retries: 2,
});
console.log(`Created schedule ${result.scheduleId}`);
