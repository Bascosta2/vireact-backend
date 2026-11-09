/**
 * Give every legacy actualViews value a performance snapshot (Analytics tab). Idempotent.
 *
 *   node scripts/migrate-actual-views-to-snapshots.js            # dry run: count only
 *   node scripts/migrate-actual-views-to-snapshots.js --apply    # write
 *
 * Outside NODE_ENV=production the database-name guard applies (see ensure-indexes.js).
 */
import '../src/config/load-env.js';
import mongoose from 'mongoose';
import { assertSafeDatabase } from '../src/config/env-guards.js';
import { DB_URL, DB_NAME } from '../src/config/index.js';
import { migrateLegacyActualViews } from '../src/service/performance.service.js';

const apply = process.argv.includes('--apply');
assertSafeDatabase();

try {
    await mongoose.connect(DB_URL, { dbName: DB_NAME, autoIndex: false });
    const result = await migrateLegacyActualViews({ dryRun: !apply });
    console.log(`${apply ? 'Applied' : 'Dry run'}: ${result.matched} video(s) need a snapshot, ${result.modified} written.`);
} catch (error) {
    console.error('Migration failed:', error?.message);
    process.exitCode = 1;
} finally {
    await mongoose.disconnect();
}
