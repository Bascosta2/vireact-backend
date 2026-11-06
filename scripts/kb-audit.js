/**
 * Knowledge base + performance dataset audit. READ-ONLY: only counts and aggregates, never writes.
 *
 * Run from vireact-backend:
 *   node scripts/kb-audit.js                     # uses the database in your .env.local (dev)
 *   node scripts/kb-audit.js --db prod           # audit production (read-only; asks for --yes)
 *   node scripts/kb-audit.js --db prod --yes
 *
 * Writes kb-audit-YYYY-MM-DD.json next to where you run it and prints a summary with flags.
 */
import '../src/config/load-env.js';
import fs from 'fs';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { KnowledgeBase } from '../src/model/knowledge-base.model.js';
import { VideoPerformanceDataset } from '../src/model/VideoPerformanceDataset.model.js';
import { KB_SPECIFICITY } from '../src/constants.js';

const args = process.argv.slice(2);
const argValue = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
};
const dbName = argValue('--db') || process.env.DB_NAME;
const confirmed = args.includes('--yes');
const url = process.env.MONGODB_URI || process.env.DB_URL;

/** text-embedding-3-large returns 3072 dimensions. */
const EXPECTED_EMBEDDING_DIMS = 3072;
const MIN_LITERAL_PER_TOPIC = 10;

if (!url) {
    console.error('Missing DB_URL (or MONGODB_URI) in .env / .env.local');
    process.exit(1);
}
if (/^prod/i.test(dbName || '') && !confirmed) {
    console.error(`About to read the "${dbName}" database (read-only). Re-run with --yes to confirm.`);
    process.exit(1);
}

const percentiles = (values, ps = [0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) => {
    const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
    return Object.fromEntries(ps.map((p) => [`p${Math.round(p * 100)}`, at(p)]));
};

const countBy = (rows, key) => rows.reduce((acc, row) => {
    const k = key(row) ?? '(none)';
    acc[k] = (acc[k] || 0) + 1;
    return acc;
}, {});

async function run() {
    await mongoose.connect(url, { dbName, readPreference: 'secondaryPreferred', autoIndex: false, autoCreate: false });
    console.log(`Connected read-only audit to database "${mongoose.connection.db.databaseName}"\n`);

    // Embeddings are large; only their length is needed.
    const kb = await KnowledgeBase.aggregate([
        {
            $project: {
                content: 1,
                topic: '$metadata.topic',
                layer: '$metadata.layer',
                specificity: '$metadata.specificity',
                exemplarType: '$metadata.exemplarType',
                score: '$metadata.score',
                source: '$metadata.source',
                actualViews: '$metadata.actualViews',
                creatorSize: '$metadata.creatorSize',
                embeddingDims: { $size: { $ifNull: ['$embedding', []] } },
            },
        },
    ]);

    const hashes = new Map();
    for (const row of kb) {
        const h = crypto.createHash('sha1').update(String(row.content || '').trim().toLowerCase()).digest('hex');
        hashes.set(h, (hashes.get(h) || 0) + 1);
    }
    const duplicateEntries = [...hashes.values()].filter((n) => n > 1).reduce((sum, n) => sum + (n - 1), 0);

    const byTopicLayer = {};
    const literalByTopic = {};
    for (const row of kb) {
        const topic = row.topic || '(none)';
        byTopicLayer[topic] ??= {};
        byTopicLayer[topic][row.layer || '(none)'] = (byTopicLayer[topic][row.layer || '(none)'] || 0) + 1;
        if (row.specificity === KB_SPECIFICITY.LITERAL) literalByTopic[topic] = (literalByTopic[topic] || 0) + 1;
    }

    const kbViews = kb.map((r) => r.actualViews).filter((v) => Number.isFinite(v));
    const lengths = kb.map((r) => String(r.content || '').length);

    const dataset = await VideoPerformanceDataset.find({})
        .select('platform creatorSize actualViews subscriberCount viralityScore status sourceType')
        .lean();
    const usableForPrediction = dataset.filter((r) => r.actualViews >= 0 && r.subscriberCount > 0 && Number.isFinite(r.viralityScore));
    const views = dataset.map((r) => r.actualViews);
    const viralShare = (rows) => (rows.length ? +(rows.filter((v) => v >= 100000).length / rows.length).toFixed(2) : null);

    const report = {
        generatedAt: new Date().toISOString(),
        database: mongoose.connection.db.databaseName,
        knowledgeBase: {
            total: kb.length,
            byTopicAndLayer: byTopicLayer,
            bySpecificity: countBy(kb, (r) => r.specificity || 'unrated'),
            byExemplarType: countBy(kb, (r) => r.exemplarType),
            bySource: countBy(kb, (r) => r.source),
            literalByTopic,
            duplicateEntries,
            wrongEmbeddingSize: kb.filter((r) => r.embeddingDims !== EXPECTED_EMBEDDING_DIMS).length,
            contentLength: percentiles(lengths, [0.1, 0.5, 0.9]),
            entriesWithViews: kbViews.length,
            viewsDistribution: percentiles(kbViews),
            shareAtOrAbove100kViews: viralShare(kbViews),
        },
        performanceDataset: {
            total: dataset.length,
            byPlatform: countBy(dataset, (r) => r.platform),
            byCreatorSize: countBy(dataset, (r) => r.creatorSize),
            byStatus: countBy(dataset, (r) => r.status),
            usableForPrediction: usableForPrediction.length,
            viewsDistribution: percentiles(views),
            shareAtOrAbove100kViews: viralShare(views),
        },
    };

    const flags = [];
    const kbr = report.knowledgeBase;
    if (kbr.bySpecificity.vague) flags.push(`${kbr.bySpecificity.vague} vague entries (already excluded from retrieval; consider deleting)`);
    if (kbr.bySpecificity.unrated) flags.push(`${kbr.bySpecificity.unrated} unrated entries (rate them literal / directional / vague)`);
    if (kbr.duplicateEntries) flags.push(`${kbr.duplicateEntries} exact duplicate entries`);
    if (kbr.wrongEmbeddingSize) flags.push(`${kbr.wrongEmbeddingSize} entries with a missing or wrong-size embedding (not ${EXPECTED_EMBEDDING_DIMS})`);
    for (const topic of ['hook', 'caption', 'pacing', 'audio', 'views_predictor', 'advanced_analytics', 'general']) {
        if ((kbr.literalByTopic[topic] || 0) < MIN_LITERAL_PER_TOPIC) flags.push(`topic "${topic}" has ${kbr.literalByTopic[topic] || 0} literal entries (aim for ${MIN_LITERAL_PER_TOPIC}+)`);
    }
    if (kbr.shareAtOrAbove100kViews != null && kbr.shareAtOrAbove100kViews > 0.3) {
        flags.push(`${Math.round(kbr.shareAtOrAbove100kViews * 100)}% of KB entries with view data are 100K+ views: skewed toward viral outliers; add average and weak performers`);
    }
    const ds = report.performanceDataset;
    if (ds.shareAtOrAbove100kViews != null && ds.shareAtOrAbove100kViews > 0.3) {
        flags.push(`${Math.round(ds.shareAtOrAbove100kViews * 100)}% of performance-dataset videos are 100K+ views: skewed toward viral outliers`);
    }
    if (ds.usableForPrediction < 50) {
        flags.push(`only ${ds.usableForPrediction} dataset rows have views + subscriber count + score; data-based predictions need at least 8 similar ones per score band, so more rows (with subscriber counts) are needed`);
    }
    report.flags = flags;

    const out = `kb-audit-${report.generatedAt.slice(0, 10)}.json`;
    fs.writeFileSync(out, JSON.stringify(report, null, 2));

    console.log(`Knowledge base entries: ${kbr.total}`);
    console.log('By topic and layer:', JSON.stringify(kbr.byTopicAndLayer));
    console.log('By specificity:', JSON.stringify(kbr.bySpecificity));
    console.log(`Entries with view data: ${kbr.entriesWithViews}, views ${JSON.stringify(kbr.viewsDistribution)}`);
    console.log(`\nPerformance dataset rows: ${ds.total} (usable for prediction: ${ds.usableForPrediction})`);
    console.log('By platform:', JSON.stringify(ds.byPlatform), ' By creator size:', JSON.stringify(ds.byCreatorSize));
    console.log('Views:', JSON.stringify(ds.viewsDistribution));
    console.log(`\nFlags (${flags.length}):`);
    for (const flag of flags) console.log(`  - ${flag}`);
    console.log(`\nFull report: ${out}`);
    await mongoose.disconnect();
}

run().catch(async (error) => {
    console.error('Audit failed:', error.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
});
