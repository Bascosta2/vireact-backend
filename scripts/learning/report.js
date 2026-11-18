/**
 * Learning engine: backfill features/outcomes and print the data inventory and report card.
 *
 *   node scripts/learning/report.js              # read-only: inventory + report card
 *   node scripts/learning/report.js --backfill   # also write features/outcomes for existing videos
 *
 * Uses the same database guard as the app (scripts/research/_db.js).
 */
import { connectDb, disconnectDb, flag } from '../research/_db.js';
import { backfillLearning, dataInventory, reportCard } from '../../src/service/learning/learning.service.js';

await connectDb();
try {
    if (flag('--backfill')) console.log('Backfill:', await backfillLearning({ limit: 5000 }));
    console.log('Inventory:', JSON.stringify(await dataInventory(), null, 2));
    console.log('Report card:', JSON.stringify(await reportCard(), null, 2));
} finally {
    await disconnectDb();
}
