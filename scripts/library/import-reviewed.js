/**
 * Import reviewed drafts into library_items (plan §5.2).
 *
 *   node scripts/library/import-reviewed.js --file data/library/drafts.json           # dry run
 *   node scripts/library/import-reviewed.js --file data/library/drafts.json --apply   # upsert by slug
 *
 * New items import as private + draft unless the JSON sets visibility/reviewStatus.
 * Existing items keep their visibility/reviewStatus unless the JSON sets them.
 * Never writes to knowledgebases; prints a KB fingerprint before and after.
 */
import '../../src/config/load-env.js';
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { assertSafeDatabase } from '../../src/config/env-guards.js';
import { DB_URL, DB_NAME } from '../../src/config/index.js';
import { kbSnapshot, sameSnapshot } from '../../src/service/library/kb-readonly.js';
import { importReviewedItems } from '../../src/service/library/import-items.js';
import { argValue } from '../../src/service/admin-account.js';

const file = argValue(process.argv, '--file');
const apply = process.argv.includes('--apply');
if (!file) {
    console.error('Usage: node scripts/library/import-reviewed.js --file <drafts.json> [--apply]');
    process.exit(1);
}
const parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
const items = Array.isArray(parsed) ? parsed : parsed.items;
if (!Array.isArray(items)) {
    console.error('Expected an array of items or { items: [...] }');
    process.exit(1);
}

assertSafeDatabase();
await mongoose.connect(DB_URL, { dbName: DB_NAME, autoIndex: false, autoCreate: false });
try {
    const db = mongoose.connection.db;
    console.log(`Database: ${db.databaseName}  mode: ${apply ? 'APPLY' : 'dry run'}`);
    const before = await kbSnapshot(db);
    const report = await importReviewedItems(db, items, { apply });
    const after = await kbSnapshot(db);
    if (!sameSnapshot(before, after)) throw new Error('KB fingerprint changed during import. Stop and investigate.');

    console.log(`KB unchanged: ${after.count} docs; sha256 ${after.pdfChunksSha256}`);
    console.log(`${apply ? 'Inserted' : 'Would insert'}: ${report.insert.length}`);
    console.log(`${apply ? 'Updated' : 'Would update'}: ${report.update.length}`);
    console.log(`Invalid (skipped): ${report.invalid.length}`);
    for (const entry of report.invalid) console.log(`  ${entry.slug}: ${entry.errors.join('; ')}`);
    if (!apply) console.log('Dry run only. Re-run with --apply to write library_items.');
} finally {
    await mongoose.disconnect();
}
