/**
 * One-time diagnostic: VideoPerformanceDataset collection.
 * Run from vireact-backend: node scripts/check-videos.js
 * Uses MONGODB_URI or DB_URL from .env
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { VideoPerformanceDataset } from '../src/model/VideoPerformanceDataset.model.js';

const MONGODB_URI = process.env.MONGODB_URI || process.env.DB_URL;
if (!MONGODB_URI) {
    console.error('Missing MONGODB_URI or DB_URL in .env');
    process.exit(1);
}

async function run() {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('Connected to MongoDB\n');

        const total = await VideoPerformanceDataset.countDocuments();
        console.log('--- VideoPerformanceDataset ---');
        console.log('Total videos:', total);

        const byStatus = await VideoPerformanceDataset.aggregate([
            { $group: { _id: '$status', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ]);
        console.log('\nBy status:', JSON.stringify(byStatus, null, 2));

        const byPlatform = await VideoPerformanceDataset.aggregate([
            { $group: { _id: '$platform', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ]);
        console.log('\nBy platform:', JSON.stringify(byPlatform, null, 2));

        const byNiche = await VideoPerformanceDataset.aggregate([
            { $group: { _id: '$niche', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
        ]);
        console.log('\nBy niche:', JSON.stringify(byNiche, null, 2));

        const recent = await VideoPerformanceDataset.find()
            .sort({ _id: -1 })
            .limit(5)
            .lean();
        console.log('\n--- 5 most recent videos ---');
        for (const doc of recent) {
            const scenesLen = Array.isArray(doc.scenes) ? doc.scenes.length : 0;
            const analysisLen = Array.isArray(doc.analysis) ? doc.analysis.length : 0;
            const completeNoScore = doc.status === 'complete' && (doc.viralityScore == null);
            const emptyScenes = doc.status === 'complete' && scenesLen === 0;
            console.log({
                _id: doc._id,
                status: doc.status,
                platform: doc.platform,
                niche: doc.niche,
                viralityScore: doc.viralityScore,
                hookScore: doc.hookScore,
                durationSeconds: doc.durationSeconds,
                scenesLength: scenesLen,
                analysisLength: analysisLen,
                ...(completeNoScore && { FLAG: 'complete but viralityScore null/undefined' }),
                ...(emptyScenes && { FLAG: 'scenes array empty' }),
            });
        }

        const complete = await VideoPerformanceDataset.countDocuments({ status: 'complete' });
        const failed = await VideoPerformanceDataset.countDocuments({ status: 'failed' });
        const processing = await VideoPerformanceDataset.countDocuments({ status: 'processing' });
        const pending = await VideoPerformanceDataset.countDocuments({ status: 'pending' });
        console.log('\n--- Summary ---');
        console.log(`${total} videos total, ${complete} complete, ${failed} failed, ${processing} processing, ${pending} pending`);
    } finally {
        await mongoose.disconnect();
        console.log('\nDisconnected.');
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
