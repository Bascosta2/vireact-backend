import { KnowledgeBase } from '../model/knowledge-base.model.js';
import openai from '../lib/openai.js';

const EMBEDDING_MODEL = 'text-embedding-3-large';
const TARGET_CHUNK_TOKENS = 500;
const APPROX_CHARS_PER_TOKEN = 4;
const TARGET_CHUNK_CHARS = TARGET_CHUNK_TOKENS * APPROX_CHARS_PER_TOKEN;

function splitIntoParagraphs(text) {
    const normalized = (text || '').replace(/\r\n/g, '\n').trim();
    if (!normalized) return [];
    return normalized.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
}

function chunkText(text, maxChars = TARGET_CHUNK_CHARS) {
    const paragraphs = splitIntoParagraphs(text);
    const chunks = [];
    let current = '';

    for (const para of paragraphs) {
        if (current.length + para.length + 2 <= maxChars) {
            current = current ? current + '\n\n' + para : para;
        } else {
            if (current) chunks.push(current);
            if (para.length > maxChars) {
                const sentences = para.match(/[^.!?]+[.!?]+/g) || [para];
                let acc = '';
                for (const sent of sentences) {
                    if (acc.length + sent.length + 1 <= maxChars) {
                        acc = acc ? acc + ' ' + sent : sent;
                    } else {
                        if (acc) chunks.push(acc);
                        acc = sent.length > maxChars ? sent.slice(0, maxChars) : sent;
                    }
                }
                if (acc) current = acc;
                else current = '';
                continue;
            }
            current = para;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

export function chunkContentForKnowledge(fullText) {
    return chunkText(fullText, TARGET_CHUNK_CHARS);
}

export async function ingestKnowledgeChunks(chunks, metadata) {
    const { topic, platform, source, contentType } = metadata;
    const totalChunks = chunks.length;
    const created = [];

    for (let i = 0; i < chunks.length; i++) {
        const content = chunks[i].trim();
        if (!content) continue;

        const response = await openai.embeddings.create({
            model: EMBEDDING_MODEL,
            input: content,
            encoding_format: 'float',
        });
        const embedding = response?.data?.[0]?.embedding;
        if (!Array.isArray(embedding) || embedding.length === 0) {
            throw new Error('Empty embedding returned for chunk');
        }

        const doc = await KnowledgeBase.create({
            content,
            embedding,
            metadata: {
                topic,
                layer: 'raw',
                source,
                score: 0.9,
                platform,
                contentType,
                chunkIndex: i,
                totalChunks,
                ingestedAt: new Date(),
            },
        });
        created.push(doc);
    }

    return created.length;
}
