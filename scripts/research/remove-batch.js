/**
 * Remove research docs from the knowledge base. Only ever touches docs with metadata.origin "research".
 *
 *   node scripts/research/remove-batch.js --batch 2026-11-08            # dry run: count
 *   node scripts/research/remove-batch.js --batch 2026-11-08 --apply
 *   node scripts/research/remove-batch.js --all-research [--apply]
 */
import { connectDb, disconnectDb, flag, value } from './_db.js';
import { removeResearch } from '../../src/service/research-ingest/ingest.service.js';

const all = flag('--all-research');
const batch = value('--batch');
if (!all && !batch) {
    console.log('Pass --batch YYYY-MM-DD or --all-research (add --apply to delete).');
    process.exit(1);
}
await connectDb();
try {
    const result = await removeResearch({ batch, all, apply: flag('--apply') });
    console.log(result.dryRun ? `Dry run: ${result.wouldRemove} research doc(s) would be removed. Re-run with --apply.` : `Removed ${result.removed} research doc(s).`);
} finally {
    await disconnectDb();
}
