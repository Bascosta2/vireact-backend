/**
 * Knowledge research agent CLI. Run from vireact-backend.
 *
 *   node scripts/kb-research.js run --dry-run                    # search + read + extract, print lessons, touch no database
 *   node scripts/kb-research.js run --topics hook,pacing         # queue lessons for review in the DB from .env.local
 *   node scripts/kb-research.js list [--status pending] [--topic hook]
 *   node scripts/kb-research.js approve <id> [<id> ...]          # copy into the knowledge base
 *   node scripts/kb-research.js approve --all-pending --min-confidence 0.7
 *   node scripts/kb-research.js reject <id> [<id> ...] [--note "why"]
 *
 * Options: --max-pages N (default 14), --out file.json (save run output), --db <name>, --yes (required for a prod database).
 */
import '../src/config/load-env.js';
import fs from 'fs';
import mongoose from 'mongoose';
import { runResearch, approveCandidate, rejectCandidate, RESEARCH_TOPICS } from '../src/service/kb-research/research.service.js';

const args = process.argv.slice(2);
const command = args[0];
const flag = (name) => args.includes(name);
const value = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
/** Candidate ids given on the command line. */
const positional = args.slice(1).filter((a) => /^[0-9a-f]{24}$/i.test(a));

const usage = () => {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
    process.exit(1);
};
if (!['run', 'list', 'approve', 'reject'].includes(command)) usage();

const dryRun = command === 'run' && flag('--dry-run');
const connect = async () => {
    const url = process.env.MONGODB_URI || process.env.DB_URL;
    const dbName = value('--db') || process.env.DB_NAME;
    if (!url) throw new Error('Missing DB_URL in .env / .env.local');
    if (/^prod/i.test(dbName || '') && !flag('--yes')) throw new Error(`Target database is "${dbName}". Re-run with --yes to confirm.`);
    await mongoose.connect(url, { dbName });
    console.log(`Connected to database "${dbName}"`);
};

const main = async () => {
    if (!dryRun) await connect();
    const { KbCandidate } = await import('../src/model/kb-candidate.model.js');

    if (command === 'run') {
        const topics = value('--topics') ? value('--topics').split(',').map((t) => t.trim()) : [...RESEARCH_TOPICS];
        const invalid = topics.filter((t) => !RESEARCH_TOPICS.includes(t));
        if (invalid.length) throw new Error(`Unknown topics: ${invalid.join(', ')}. Use: ${RESEARCH_TOPICS.join(', ')}`);
        const result = await runResearch({
            topics,
            maxPages: Number(value('--max-pages')) || 14,
            dryRun,
            log: (line) => console.log(line),
        });
        for (const c of result.candidates) {
            console.log(`\n[${c.topic} | ${c.specificity} | conf ${c.confidence}] ${c.sourceDomain}\n${c.content}`);
        }
        if (value('--out')) {
            fs.writeFileSync(value('--out'), JSON.stringify(result, null, 2));
            console.log(`\nSaved run output to ${value('--out')}`);
        }
        console.log(`\n${result.stats.candidates} lessons ${dryRun ? 'found (dry run, nothing saved)' : 'queued for review'}.`);
    }

    if (command === 'list') {
        const filter = { status: value('--status') || 'pending' };
        if (value('--topic')) filter.topic = value('--topic');
        const items = await KbCandidate.find(filter).sort({ confidence: -1, createdAt: -1 }).limit(Number(value('--limit')) || 50).lean();
        for (const c of items) console.log(`\n${c._id}  [${c.topic} | conf ${c.confidence}] ${c.sourceUrl}\n${c.content}`);
        console.log(`\n${items.length} ${filter.status} lessons shown.`);
    }

    if (command === 'approve') {
        let ids = positional;
        if (flag('--all-pending')) {
            const min = Number(value('--min-confidence') || 0.7);
            ids = (await KbCandidate.find({ status: 'pending', confidence: { $gte: min } }).select('_id').lean()).map((c) => String(c._id));
        }
        let ok = 0;
        for (const id of ids) {
            const result = await approveCandidate(id);
            if (result.ok) ok++;
            console.log(`${id}: ${result.ok ? `approved -> knowledge base ${result.knowledgeBaseId}` : result.reason}`);
        }
        console.log(`\n${ok} of ${ids.length} approved.`);
    }

    if (command === 'reject') {
        for (const id of positional) {
            const result = await rejectCandidate(id, value('--note'));
            console.log(`${id}: ${result.ok ? 'rejected' : result.reason}`);
        }
    }
};

main()
    .catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect().catch(() => {}));
