/**
 * RAG test: run vector search on KnowledgeBase with a sample query.
 * Run from vireact-backend: node scripts/test-rag.js
 * Uses MONGODB_URI/DB_URL, OPENAI_API_KEY, and optionally KNOWLEDGE_BASE_VECTOR_INDEX from .env
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { KnowledgeBase } from '../src/model/knowledge-base.model.js';
import { KNOWLEDGE_BASE_VECTOR_INDEX } from '../src/config/index.js';
import openai from '../src/lib/openai.js';

const MONGODB_URI = process.env.MONGODB_URI || process.env.DB_URL;
const SAMPLE_QUERY = 'how to make a strong hook for TikTok';

if (!MONGODB_URI) {
    console.error('Missing MONGODB_URI or DB_URL in .env');
    process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY in .env');
    process.exit(1);
}

async function run() {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('Connected to MongoDB\n');
        console.log('Sample query:', SAMPLE_QUERY);

        const embeddingResponse = await openai.embeddings.create({
            model: 'text-embedding-3-large',
            input: SAMPLE_QUERY,
            encoding_format: 'float',
        });
        const queryVector = embeddingResponse?.data?.[0]?.embedding;
        if (!Array.isArray(queryVector) || queryVector.length === 0) {
            console.error('Empty embedding returned from OpenAI');
            process.exit(1);
        }
        console.log('Query embedding length:', queryVector.length);

        const indexName = KNOWLEDGE_BASE_VECTOR_INDEX || 'knowledge_vector_index';
        let results = [];
        try {
            results = await KnowledgeBase.aggregate([
                {
                    $vectorSearch: {
                        index: indexName,
                        queryVector,
                        path: 'embedding',
                        limit: 3,
                        numCandidates: 100,
                    },
                },
                {
                    $project: {
                        content: 1,
                        'metadata.source': 1,
                        'metadata.topic': 1,
                        'metadata.platform': 1,
                        score: { $meta: 'vectorSearchScore' },
                    },
                },
            ]);
        } catch (aggErr) {
            console.error('Vector search failed (check KNOWLEDGE_BASE_VECTOR_INDEX and Atlas vector index):', aggErr.message);
            process.exit(1);
        }

        console.log('\n--- Top 3 RAG results ---');
        if (results.length === 0) {
            console.log('No results (empty knowledge base or index not ready).');
        } else {
            results.forEach((r, i) => {
                const contentPreview = (r.content || '').slice(0, 150);
                console.log({
                    rank: i + 1,
                    source: r.metadata?.source,
                    topic: r.metadata?.topic,
                    platform: r.metadata?.platform,
                    score: r.score,
                    contentPreview: contentPreview + (contentPreview.length >= 150 ? '...' : ''),
                });
            });
        }
        console.log('\nRAG vector search is working.');
    } finally {
        await mongoose.disconnect();
        console.log('\nDisconnected.');
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
