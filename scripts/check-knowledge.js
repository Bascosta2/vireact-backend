/**
 * One-time diagnostic: KnowledgeBase collection.
 * Run from vireact-backend: node scripts/check-knowledge.js
 * Uses MONGODB_URI or DB_URL from .env
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { KnowledgeBase } from '../src/model/knowledge-base.model.js';

const MONGODB_URI = process.env.MONGODB_URI || process.env.DB_URL;
if (!MONGODB_URI) {
    console.error('Missing MONGODB_URI or DB_URL in .env');
    process.exit(1);
}

async function run() {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('Connected to MongoDB\n');

        const total = await KnowledgeBase.countDocuments();
        console.log('--- KnowledgeBase ---');
        console.log('Total documents:', total);

        const byTopic = await KnowledgeBase.aggregate([
            { $group: { _id: '$metadata.topic', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ]);
        console.log('\nBy topic:', JSON.stringify(byTopic, null, 2));

        const byPlatform = await KnowledgeBase.aggregate([
            { $group: { _id: '$metadata.platform', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ]);
        console.log('\nBy platform:', JSON.stringify(byPlatform, null, 2));

        const byContentType = await KnowledgeBase.aggregate([
            { $group: { _id: '$metadata.contentType', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ]);
        console.log('\nBy contentType:', JSON.stringify(byContentType, null, 2));

        const bySource = await KnowledgeBase.aggregate([
            { $group: { _id: '$metadata.source', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ]);
        console.log('\nBy source:', JSON.stringify(bySource, null, 2));

        const recent = await KnowledgeBase.find()
            .sort({ _id: -1 })
            .limit(5)
            .lean();
        console.log('\n--- 5 most recent documents ---');
        for (const doc of recent) {
            const embLen = Array.isArray(doc.embedding) ? doc.embedding.length : 0;
            const contentPreview = (doc.content || '').slice(0, 100);
            console.log({
                _id: doc._id,
                source: doc.metadata?.source,
                topic: doc.metadata?.topic,
                platform: doc.metadata?.platform,
                contentType: doc.metadata?.contentType,
                embeddingLength: embLen,
                contentPreview: contentPreview + (contentPreview.length >= 100 ? '...' : ''),
            });
        }

        const withEmbedding = await KnowledgeBase.countDocuments({
            $expr: { $gt: [{ $size: { $ifNull: ['$embedding', []] } }, 0] },
        });
        const missingEmbedding = total - withEmbedding;
        console.log('\n--- Summary ---');
        console.log(`${total} documents total, ${withEmbedding} have valid embeddings, ${missingEmbedding} are missing embeddings`);
    } finally {
        await mongoose.disconnect();
        console.log('\nDisconnected.');
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
