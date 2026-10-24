import crypto from 'node:crypto';

/**
 * Read-only helpers over `knowledgebases`. Nothing in this module writes to the
 * KB; callers get documents through find/countDocuments only.
 */

/** The owner's hooks PDF as ingested on 2026-03-11 (KNOWLEDGE_BASE_AUDIT.md §3.2). */
export const HOOKS_PDF_FILTER = Object.freeze({
    'metadata.source': 'Viral Creator',
    'metadata.totalChunks': 8,
    'metadata.contentType': 'algorithm_breakdown',
});
const HOOKS_PDF_INGEST_DAY = '2026-03-11';

const kbCollection = (db) => db.collection('knowledgebases');

/** Returns the 8 PDF chunks (without embeddings), sorted by chunkIndex. Throws if the set is not exactly 8 chunks from that ingest. */
export async function findHookPdfChunks(db) {
    const docs = await kbCollection(db)
        .find(HOOKS_PDF_FILTER, { projection: { embedding: 0 } })
        .sort({ 'metadata.chunkIndex': 1 })
        .toArray();
    const sameIngest = docs.filter((d) => d.metadata?.ingestedAt?.toISOString?.().startsWith(HOOKS_PDF_INGEST_DAY));
    const indexes = new Set(sameIngest.map((d) => d.metadata?.chunkIndex));
    if (sameIngest.length !== 8 || indexes.size !== 8) {
        throw new Error(`Expected the 8 hooks-PDF chunks from ${HOOKS_PDF_INGEST_DAY}; found ${sameIngest.length} (${indexes.size} distinct chunk indexes).`);
    }
    return sameIngest;
}

/**
 * Fingerprint used to prove no KB writes: total document count plus a SHA-256
 * over the full PDF chunk documents (content, metadata and embeddings).
 */
export async function kbSnapshot(db) {
    const count = await kbCollection(db).countDocuments({});
    const chunks = await kbCollection(db).find(HOOKS_PDF_FILTER).sort({ _id: 1 }).toArray();
    const hash = crypto.createHash('sha256');
    for (const doc of chunks) hash.update(JSON.stringify(doc));
    return { count, pdfChunks: chunks.length, pdfChunksSha256: hash.digest('hex') };
}

export const sameSnapshot = (a, b) =>
    a.count === b.count && a.pdfChunks === b.pdfChunks && a.pdfChunksSha256 === b.pdfChunksSha256;

/**
 * Provenance heuristics from the audit (§3.2 "Provenance"). There is no reliable
 * field, so anything not positively identified as owner content is treated as
 * third-party and needs an explicit override before it can be public.
 */
export function classifyKbProvenance(doc) {
    const m = doc?.metadata || {};
    const isPdf = m.source === HOOKS_PDF_FILTER['metadata.source']
        && m.totalChunks === HOOKS_PDF_FILTER['metadata.totalChunks']
        && m.contentType === HOOKS_PDF_FILTER['metadata.contentType'];
    if (isPdf) return 'owner';
    if (m.sourceType === 'own_video') return 'owner';
    if (m.source === 'admin_creator_ingest' || m.sourceType === 'creator_video') return 'third_party_derived';
    if (m.totalChunks != null) return 'third_party';
    if (m.source === 'manual_note' && !m.sourceType) return 'owner';
    return 'unknown';
}

export const isThirdPartyProvenance = (provenance) => provenance !== 'owner';

/** Read-only text search for "Promote from KB" (regex; the KB has no text index and we must not add one). */
export async function searchKb(db, q, { limit = 20 } = {}) {
    const query = String(q || '').trim().slice(0, 100);
    if (query.length < 2) return [];
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const docs = await kbCollection(db)
        .find({ content: { $regex: escaped, $options: 'i' } }, { projection: { embedding: 0 } })
        .limit(Math.min(Math.max(limit, 1), 50))
        .toArray();
    return docs.map((doc) => {
        const provenance = classifyKbProvenance(doc);
        return {
            _id: String(doc._id),
            excerpt: String(doc.content || '').slice(0, 400),
            source: doc.metadata?.source || null,
            topic: doc.metadata?.topic || null,
            contentType: doc.metadata?.contentType || null,
            chunkIndex: doc.metadata?.chunkIndex ?? null,
            totalChunks: doc.metadata?.totalChunks ?? null,
            provenance,
            thirdParty: isThirdPartyProvenance(provenance),
        };
    });
}

export async function findKbDocById(db, id) {
    return kbCollection(db).findOne({ _id: id }, { projection: { embedding: 0 } });
}
