/**
 * Build draft library items from the owner's hooks PDF chunks (plan §5.2).
 *
 *   node scripts/library/extract-drafts.js [--suggest] [--out data/library/drafts.json]
 *
 * Read-only on the KB: reads the 8 chunks by filter and writes a JSON file.
 * Prints a KB fingerprint (doc count + chunk hash) before and after and fails
 * if they differ. --suggest asks OpenAI for draft niche/problem tags from the
 * item text only; suggestions are marked as such for owner review.
 */
import '../../src/config/load-env.js';
import fs from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { assertSafeDatabase } from '../../src/config/env-guards.js';
import { DB_URL, DB_NAME } from '../../src/config/index.js';
import { findHookPdfChunks, kbSnapshot, sameSnapshot } from '../../src/service/library/kb-readonly.js';
import { extractHookPdfDrafts } from '../../src/service/library/extract-hooks-pdf.js';
import { suggestTags } from '../../src/service/library/suggest-tags.js';
import { argValue } from '../../src/service/admin-account.js';

const outFile = path.resolve(argValue(process.argv, '--out') || 'data/library/drafts.json');
const suggest = process.argv.includes('--suggest');

assertSafeDatabase();
await mongoose.connect(DB_URL, { dbName: DB_NAME, autoIndex: false, autoCreate: false });
try {
    const db = mongoose.connection.db;
    console.log(`Database: ${db.databaseName}`);
    const before = await kbSnapshot(db);
    console.log(`KB before: ${before.count} docs; PDF chunks ${before.pdfChunks}; sha256 ${before.pdfChunksSha256}`);

    const chunks = await findHookPdfChunks(db);
    const { items, counts } = extractHookPdfDrafts(chunks);

    if (suggest) {
        const suggestions = await suggestTags(items);
        for (const item of items) {
            const s = suggestions.get(item.slug);
            if (s) item.suggested = { niches: s.niches, problemTags: s.problemTags };
        }
        console.log(`Tag suggestions: ${suggestions.size} of ${items.length} items (stored under "suggested", not applied).`);
    }

    const drafts = items.map((item) => ({
        ...item,
        niches: [],
        problemTags: [],
        createdBy: 'extractor',
    }));

    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `${JSON.stringify({ generatedAt: new Date().toISOString(), counts, items: drafts }, null, 2)}\n`);

    const after = await kbSnapshot(db);
    console.log(`KB after:  ${after.count} docs; PDF chunks ${after.pdfChunks}; sha256 ${after.pdfChunksSha256}`);
    if (!sameSnapshot(before, after)) {
        throw new Error('KB fingerprint changed during extraction. Stop and investigate.');
    }

    console.log(`\nWrote ${drafts.length} drafts to ${path.relative(process.cwd(), outFile)}`);
    console.log(`Hooks: ${counts.hooks} across ${counts.hookCategories} categories`);
    for (const [category, n] of Object.entries(counts.hooksPerCategory)) console.log(`  ${String(n).padStart(3)}  ${category}`);
    console.log(`Structure templates: ${counts.structureTemplates}; structure/insight sections: ${counts.structureSections}`);
} finally {
    await mongoose.disconnect();
}
