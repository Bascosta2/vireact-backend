/**
 * Pull approved research from Bascosta2/vireact-research and ingest it (see SLASH_DOC "Autonomous research ingest").
 *
 *   node scripts/research/pull-and-ingest.js            # dry run (default): gates, dedupe, caps; writes nothing
 *   node scripts/research/pull-and-ingest.js --apply    # ingest + retrieval health check (+ auto rollback) + retire
 *
 * --apply needs RESEARCH_INGEST_ENABLED=true and RESEARCH_REPO_TOKEN. Production runs on Railway via the
 * QStash schedule (POST /api/v1/research/run); this script is for manual runs.
 */
import { connectDb, disconnectDb, flag } from './_db.js';
import { runResearchIngest } from '../../src/service/research-ingest/ingest.service.js';
import { shutdownAnalytics } from '../../src/lib/analytics.js';

const apply = flag('--apply');
await connectDb();
try {
    const result = await runResearchIngest({ apply, trigger: 'script', log: (line) => console.log(line) });
    if (result.skipped) {
        console.log(`Skipped: ${result.skipped}`);
        process.exitCode = 1;
    } else {
        console.log(JSON.stringify(result.summary, null, 2));
    }
} finally {
    await shutdownAnalytics().catch(() => {});
    await disconnectDb();
}
