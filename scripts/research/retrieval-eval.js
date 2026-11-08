/**
 * Run the 30 fixed retrieval queries and print the top-10 composition for each
 * (research docs vs the owner's core content). Read-only.
 *
 *   node scripts/research/retrieval-eval.js [--json]
 */
import { connectDb, disconnectDb, flag } from './_db.js';
import { embedTexts } from '../../src/service/kb-research/research.service.js';
import { embedEvalQueries, takeSnapshot } from '../../src/service/research-ingest/retrieval-eval.js';

await connectDb();
try {
    const vectors = await embedEvalQueries(embedTexts);
    const snapshot = await takeSnapshot({ vectors });
    if (flag('--json')) console.log(JSON.stringify(snapshot, null, 2));
    else {
        if (!snapshot.ok) console.log(`ERROR: ${snapshot.error}`);
        for (const q of snapshot.queries) console.log(`${q.category.padEnd(8)} results ${String(q.ids.length).padStart(2)}  research ${q.research}  core ${q.core}  ${q.query}`);
    }
    if (!snapshot.ok) process.exitCode = 1;
} finally {
    await disconnectDb();
}
