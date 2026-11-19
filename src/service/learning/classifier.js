/**
 * Niche / sub-niche / format / hook labels for VideoFeatures (docs/learning-engine/PLAN.md, section 5.3).
 *
 * One batched classifier call per BATCH videos, closed lists only (constants/taxonomy.js), with a
 * confidence. A sub-niche that does not belong to the chosen niche is dropped. Labels below
 * MIN_CONFIDENCE are stored as niche "other" so they never pollute a niche's benchmarks.
 */
import { Video } from '../../model/video.model.js';
import { VideoPerformanceDataset } from '../../model/VideoPerformanceDataset.model.js';
import { SocialVideo, VideoFeatures } from '../../model/learning.model.js';
import {
    TAXONOMY_VERSION, TAXONOMY_NICHES, TAXONOMY_SUB_NICHES, FORMATS, HOOK_PATTERNS, subNicheOf, isNiche,
} from '../../constants/taxonomy.js';
import { requestStructuredCompletion } from '../openai-response.service.js';
import { withAiContext } from '../../lib/ai-tracking.js';

export const BATCH = 25;
export const MIN_CONFIDENCE = 0.45;

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export const labelSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['videos'],
    properties: {
        videos: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['ref', 'niche', 'subNiche', 'format', 'hookPattern', 'confidence'],
                properties: {
                    ref: { type: 'string' },
                    niche: { type: 'string', enum: [...TAXONOMY_NICHES] },
                    subNiche: { type: 'string', enum: [...TAXONOMY_SUB_NICHES] },
                    format: { type: 'string', enum: [...FORMATS] },
                    hookPattern: { type: 'string', enum: [...HOOK_PATTERNS] },
                    confidence: { type: 'number', description: '0 to 1: how sure you are of the niche.' },
                },
            },
        },
    },
};

/** One line of evidence per video, from whatever its source stored. */
export const describeSubject = (type, doc) => {
    if (!doc) return null;
    if (type === 'video') {
        const opening = (doc.rawTranscript ?? []).slice(0, 3).map((s) => s.text ?? s.value).join(' ');
        const visuals = (doc.scenes ?? []).slice(0, 3).map((s) => s.visualDescription).filter(Boolean).join(' / ');
        return `title: "${clip(doc.sourceTitle || doc.filename, 80)}" | caption: "${clip(doc.sourceDescription, 150)}" | opening words: "${clip(opening, 200)}" | visuals: "${clip(visuals, 250)}"`;
    }
    if (type === 'dataset') {
        const p = doc.editProfile ?? {};
        return `creator: ${clip(doc.creatorHandle, 40)} | category: ${doc.viralCategory ?? ''} | hook: "${clip(p.hookFirst2s, 150)}" | summary: "${clip(p.summary, 250)}"`;
    }
    const spoken = (doc.captions ?? []).slice(0, 4).map((s) => s.text).join(' ');
    return `caption: "${clip(doc.caption, 250)}" | hashtags: ${(doc.hashtags ?? []).slice(0, 12).join(' ')} | sound: "${clip(doc.soundTitle, 60)}"${spoken ? ` | opening words: "${clip(spoken, 200)}"` : ''} | found by searching: "${clip(doc.query, 40)}"`;
};

const SOURCES = {
    video: { model: Video, fields: 'filename sourceTitle sourceDescription rawTranscript scenes' },
    dataset: { model: VideoPerformanceDataset, fields: 'creatorHandle viralCategory editProfile niche' },
    social: { model: SocialVideo, fields: 'caption hashtags soundTitle query captions' },
};

/** Applies validated labels from one model reply. Returns the $set for each ref. */
export const toLabels = (items, refs) => {
    const out = new Map();
    for (const item of items ?? []) {
        const ref = String(item?.ref ?? '');
        if (!refs.has(ref) || !isNiche(item.niche)) continue;
        const confidence = Math.max(0, Math.min(1, Number(item.confidence) || 0));
        const sure = confidence >= MIN_CONFIDENCE;
        out.set(ref, {
            niche: sure ? item.niche : 'other',
            subNiche: sure ? subNicheOf(item.niche, item.subNiche) : null,
            format: FORMATS.includes(item.format) ? item.format : 'other',
            hookPattern: HOOK_PATTERNS.includes(item.hookPattern) ? item.hookPattern : 'none',
            labelConfidence: Math.round(confidence * 100) / 100,
            labelSource: 'ai',
            taxonomyVersion: TAXONOMY_VERSION,
        });
    }
    return out;
};

/** Label up to `limit` VideoFeatures that have no current AI label. Never throws for a failed batch. */
export const labelPending = async ({ limit = 300, complete = requestStructuredCompletion, log = () => {} } = {}) => {
    const todo = await VideoFeatures.find({
        $or: [{ labelSource: { $nin: ['ai', 'admin'] } }, { taxonomyVersion: { $ne: TAXONOMY_VERSION } }],
    }).sort({ createdAt: -1 }).limit(limit).select('subjectType subjectId').lean();
    let labelled = 0;
    let failed = 0;
    for (let i = 0; i < todo.length; i += BATCH) {
        const batch = todo.slice(i, i + BATCH);
        const lines = [];
        const refs = new Map();
        for (const [type, { model, fields }] of Object.entries(SOURCES)) {
            const ids = batch.filter((b) => b.subjectType === type).map((b) => b.subjectId);
            if (!ids.length) continue;
            const docs = await model.find({ _id: { $in: ids } }).select(fields).lean();
            for (const doc of docs) {
                const line = describeSubject(type, doc);
                if (!line) continue;
                const ref = `V${refs.size + 1}`;
                refs.set(ref, { type, id: doc._id });
                lines.push(`${ref} | ${line}`);
            }
        }
        if (!lines.length) continue;
        try {
            const result = await withAiContext({ feature: 'learning_labels' }, () => complete({
                messages: [{ role: 'user', content: `Label each short-form video. Use only the evidence given; when unsure, lower the confidence.\n\n${lines.join('\n')}` }],
                schemaName: 'video_labels',
                jsonSchema: labelSchema,
                systemPrompt: 'You classify short-form social videos into a fixed taxonomy. Return structured data only.',
                role: 'classifier',
                temperature: 0,
                maxTokens: 4000,
            }));
            const labels = toLabels(result?.videos, refs);
            const ops = [...labels.entries()].map(([ref, set]) => ({
                updateOne: { filter: { subjectType: refs.get(ref).type, subjectId: refs.get(ref).id }, update: { $set: set } },
            }));
            if (ops.length) await VideoFeatures.bulkWrite(ops, { ordered: false });
            labelled += ops.length;
        } catch (error) {
            failed += batch.length;
            log(`labels batch failed: ${error.message}`);
        }
    }
    return { candidates: todo.length, labelled, failed };
};
