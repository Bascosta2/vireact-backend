import { Readable } from 'stream';
import TwelveLabsClient from '../lib/twelve-labs.js';
import { twelveLabsCreateDirectAsset } from '../lib/twelve-labs-ingest.helper.js';
import { TWELVELABS_DATASET_INDEX } from '../config/index.js';
import { waitForAssetReady, indexAssetWithRetry } from './video.service.js';
import { TWELVE_LABS_SCENE_PROMPT, parseScenesWithOpenAI } from './scene-parser.service.js';
import { analyzeHook } from './analyzer/hook.analyzer.js';
import { analyzeCaption } from './analyzer/caption.analyzer.js';
import { analyzePacing } from './analyzer/pacing.analyzer.js';
import { analyzeAudio } from './analyzer/audio.analyzer.js';
import { analyzeAdvancedAnalytics } from './analyzer/advanced-analytics.analyzer.js';
import { analyzeViewsPredictor } from './analyzer/views-predictor.analyzer.js';
import { KnowledgeBase } from '../model/knowledge-base.model.js';
import openai from '../lib/openai.js';

const EMBEDDING_MODEL = 'text-embedding-3-large';
const CREATOR_PSYCH_MODEL = 'gpt-4o-mini';
const FEATURES = ['hook', 'caption', 'pacing', 'audio', 'advanced_analytics', 'views_predictor'];
const WEIGHTS = { hook: 0.35, pacing: 0.25, audio: 0.20, caption: 0.10, views_predictor: 0.10 };

function tierToScore(tier) {
    const t = (tier || '').toLowerCase();
    if (t === 'high') return 80;
    if (t === 'medium') return 55;
    if (t === 'low') return 30;
    return 55;
}

function extractScore(result, feature) {
    if (result == null) return null;
    if (feature === 'views_predictor' && typeof result === 'object' && result.tier != null) {
        return tierToScore(result.tier);
    }
    if (typeof result === 'object' && typeof result.score === 'number') {
        return Math.min(100, Math.max(0, result.score));
    }
    return null;
}

async function runAnalyzers(scenes, hookText, datasetId) {
    const analysis = [];
    const scores = {};
    for (const feature of FEATURES) {
        try {
            let result = null;
            switch (feature) {
                case 'hook':
                    result = hookText ? await analyzeHook(hookText, scenes) : null;
                    break;
                case 'caption':
                    result = await analyzeCaption(scenes);
                    break;
                case 'pacing':
                    result = await analyzePacing(scenes);
                    break;
                case 'audio':
                    result = await analyzeAudio(scenes);
                    break;
                case 'advanced_analytics':
                    result = await analyzeAdvancedAnalytics(scenes);
                    break;
                case 'views_predictor':
                    result = await analyzeViewsPredictor(scenes);
                    break;
                default:
                    break;
            }
            if (result != null) {
                const score = extractScore(result, feature);
                if (score != null) scores[feature] = score;
                analysis.push({
                    feature,
                    score: score ?? undefined,
                    rating: result.rating ?? result.tier ?? null,
                    reasoning: result.reasoning ?? null,
                    suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
                });
            }
        } catch (err) {
            if (datasetId) {
                console.error(`[Admin ingest] Analyzer ${feature} failed for dataset ${datasetId}:`, err?.message || err);
            }
        }
    }
    return { analysis, scores };
}

function computeViralityScore(scores) {
    let sum = 0;
    let weightSum = 0;
    for (const [feature, weight] of Object.entries(WEIGHTS)) {
        const s = scores[feature];
        if (s != null && typeof s === 'number') {
            sum += weight * s;
            weightSum += weight;
        }
    }
    if (weightSum <= 0) return null;
    return Math.round(Math.min(100, Math.max(0, sum / weightSum)));
}

async function createKnowledgeBaseEntry(content, metadata) {
    const response = await openai.embeddings.create({
        model: EMBEDDING_MODEL,
        input: content,
        encoding_format: 'float',
    });
    const embedding = response?.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error('Empty embedding returned');
    }
    const doc = await KnowledgeBase.create({
        content,
        embedding,
        metadata: {
            ...metadata,
            layer: metadata.layer ?? 'raw',
            score: metadata.score ?? 0.9,
            date: metadata.date ?? new Date(),
        },
    });
    return doc;
}

function fileToReadable(file) {
    if (Buffer.isBuffer(file)) {
        return Readable.from(file);
    }
    if (file.buffer) {
        return Readable.from(file.buffer);
    }
    if (file instanceof Readable) {
        return file;
    }
    return Readable.from(Buffer.from(file));
}

/**
 * Upload file to Twelve Labs dataset index, analyze, parse scenes, run analyzers.
 * Used for both paired (own_video) and creator file ingest. Never uses TWELVELABS_USER_INDEX.
 */
async function ingestFileToDatasetIndex(file, datasetId) {
    const assetResponse = await twelveLabsCreateDirectAsset(fileToReadable(file));

    const twelveLabsAssetId = assetResponse?.id || assetResponse?._id;
    if (!twelveLabsAssetId) {
        throw new Error('Failed to get asset ID from TwelveLabs response');
    }

    await waitForAssetReady(twelveLabsAssetId, assetResponse?.status);
    if (!TWELVELABS_DATASET_INDEX) {
        throw new Error('TWELVELABS_DATASET_INDEX is not configured. Please set it in your environment variables.');
    }
    const { indexedAssetId } = await indexAssetWithRetry(twelveLabsAssetId, TWELVELABS_DATASET_INDEX);
    const twelveLabsVideoId = indexedAssetId;

    const videoAnalysisResult = await TwelveLabsClient.analyze({
        videoId: twelveLabsVideoId,
        prompt: TWELVE_LABS_SCENE_PROMPT,
        temperature: 0.2,
    });

    const scenes = await parseScenesWithOpenAI(videoAnalysisResult);
    const hookScene = scenes.find(s => s.purpose?.toLowerCase() === 'hook') || scenes[0];
    const hookText = hookScene?.primaryAction || hookScene?.visualDescription || '';

    const durationSeconds = scenes.length > 0
        ? Math.max(...scenes.map(s => s.endTime || 0))
        : null;

    const { analysis, scores } = await runAnalyzers(scenes, hookText, datasetId);
    const viralityScore = computeViralityScore(scores);

    return {
        twelveLabsAssetId,
        twelveLabsVideoId,
        scenes,
        durationSeconds,
        analysis,
        scores,
        viralityScore,
    };
}

export async function ingestPairedVideo(file, fields, datasetId) {
    return ingestFileToDatasetIndex(file, datasetId);
}

export async function ingestCreatorVideoFromFile(file, datasetId) {
    return ingestFileToDatasetIndex(file, datasetId);
}

export function buildPerformanceSummaryPayload(doc, sourceType) {
    const firstScene = Array.isArray(doc.scenes) && doc.scenes[0]
        ? (doc.scenes[0].primaryAction || doc.scenes[0].visualDescription || doc.scenes[0].purpose || '')
        : '';
    const parts = [
        '[PERFORMANCE DATA]',
        `Platform: ${doc.platform}`,
        `Creator Size: ${doc.creatorSize || 'N/A'}`,
        `Actual Views: ${doc.actualViews}`,
        `Virality Score: ${doc.viralityScore ?? 'N/A'}`,
        `Hook: ${doc.hookScore ?? 'N/A'}`,
        `Pacing: ${doc.pacingScore ?? 'N/A'}`,
        `Audio: ${doc.audioScore ?? 'N/A'}`,
        `Caption: ${doc.captionScore ?? 'N/A'}`,
        `Duration: ${doc.durationSeconds != null ? doc.durationSeconds + 's' : 'unknown'}, Retention: ${doc.retentionRate != null ? doc.retentionRate + '%' + (doc.retentionRate > 100 ? ' (replay loop — strong signal)' : '') : 'not provided (inferred from scene analysis)'}`,
        `Swipe rate (1-3s, stayed past hook): ${doc.swipeRate != null ? doc.swipeRate + '%' : 'N/A'}`,
        `Hook scene: ${firstScene}`,
    ];
    if (sourceType === 'creator_video' && doc.viralCategory) {
        parts.splice(2, 0, `Viral category: ${doc.viralCategory}`);
    }
    if (sourceType === 'creator_video' && (doc.creatorHandle || doc.subscriberCount != null)) {
        parts.push(`Creator: ${doc.creatorHandle || 'N/A'}`);
        parts.push(`Subscribers: ${doc.subscriberCount != null ? doc.subscriberCount : 'N/A'}`);
    }
    return parts.join(', ');
}

/**
 * OpenAI-generated psychological / structural profile for RAG (topic: general).
 * Emphasizes hook mechanics, pacing, audio, captions, emotion, and performance vs creator size — not topic niche.
 */
export async function generateCreatorPsychologicalSummary(doc) {
    const sceneBrief = Array.isArray(doc.scenes) ? doc.scenes.slice(0, 12).map((s, i) => ({
        i: i + 1,
        start: s.startTime,
        end: s.endTime,
        visual: s.visualDescription,
        text: s.onScreenText,
        audio: s.audioSummary,
        action: s.primaryAction,
        tone: s.emotionalTone,
        purpose: s.purpose,
    })) : [];

    const analysisBrief = Array.isArray(doc.analysis)
        ? doc.analysis.map(a => ({ feature: a.feature, score: a.score, rating: a.rating, reasoning: a.reasoning }))
        : [];

    const userPayload = {
        platform: doc.platform,
        viralCategory: doc.viralCategory,
        creatorSize: doc.creatorSize,
        subscriberCount: doc.subscriberCount,
        creatorHandle: doc.creatorHandle,
        actualViews: doc.actualViews,
        viralityScore: doc.viralityScore,
        durationSeconds: doc.durationSeconds,
        scenes: sceneBrief,
        featureAnalysis: analysisBrief,
    };

    const completion = await openai.chat.completions.create({
        model: CREATOR_PSYCH_MODEL,
        temperature: 0.3,
        messages: [
            {
                role: 'system',
                content: `You write dense, retrieval-friendly summaries for a video performance knowledge base.
Focus on PSYCHOLOGICAL and STRUCTURAL signals, not topic/niche (ignore whether content is cooking, finance, etc.).

Cover when evident from the data:
- Hook: pattern interrupt, curiosity gap, shock, relatability, controversy, transformation, or other technique
- Pacing: implied cut rhythm, energy, silence vs density
- Audio: trending sound vs original, voiceover, music energy
- Caption/on-screen text: question, bold claim, incomplete sentence, CTA patterns
- Emotional triggers: fear, desire, humor, inspiration, FOMO, etc.
- Performance outcome: relate actual views to creator size (e.g. micro account vs viral outcome)

Output 4-8 short paragraphs OR bullet sections as plain text only (no JSON, no markdown code fences). Start with a line: [CREATOR_PERFORMANCE_PROFILE]`,
            },
            {
                role: 'user',
                content: JSON.stringify(userPayload),
            },
        ],
    });

    const text = completion?.choices?.[0]?.message?.content?.trim();
    if (!text) {
        throw new Error('Empty psychological summary from model');
    }
    return text;
}

export async function saveCreatorIngestKnowledge(doc) {
    const psychSummary = await generateCreatorPsychologicalSummary(doc);
    const kbDoc = await createKnowledgeBaseEntry(psychSummary, {
        topic: 'general',
        platform: doc.platform,
        viralCategory: doc.viralCategory,
        creatorSize: doc.creatorSize,
        actualViews: doc.actualViews,
        creatorHandle: doc.creatorHandle,
        sourceType: 'creator_video',
        source: 'admin_creator_ingest',
        contentType: 'case_study',
        ingestedAt: new Date(),
        layer: 'example',
        score: 0.9,
    });
    return {
        knowledgeBaseEntryId: kbDoc._id.toString(),
        psychologicalSignalsSummary: psychSummary,
    };
}

export async function savePerformanceKnowledgeBase(doc, sourceType) {
    const content = buildPerformanceSummaryPayload(doc, sourceType);
    const metadata = {
        topic: 'views_predictor',
        platform: doc.platform,
        sourceType,
        source: 'admin_ingest',
        score: 0.9,
    };
    if (sourceType === 'creator_video') {
        metadata.creatorHandle = doc.creatorHandle;
        metadata.subscriberCount = doc.subscriberCount;
        metadata.viralCategory = doc.viralCategory;
        metadata.creatorSize = doc.creatorSize;
        metadata.actualViews = doc.actualViews;
    }
    await createKnowledgeBaseEntry(content, metadata);

    const durationSeconds = doc.durationSeconds;
    const retentionRate = doc.retentionRate;
    if (durationSeconds != null && retentionRate != null) {
        const platform = doc.platform;
        const actualViews = doc.actualViews;
        const viralityScore = doc.viralityScore ?? 'N/A';
        const retentionInsight = retentionRate > 100
            ? `SHORT VIDEO RETENTION INSIGHT: A ${durationSeconds}s short-form video on ${platform} achieved ${retentionRate}% retention (replay rate: ${(retentionRate / 100).toFixed(1)}x) and got ${actualViews} actual views. High retention on short videos indicates strong loop-ability and hook quality. Virality score was ${viralityScore}.`
            : `VIDEO RETENTION DATA: A ${durationSeconds}s short-form video on ${platform} achieved ${retentionRate}% retention and got ${actualViews} actual views. Virality score was ${viralityScore}.`;
        await createKnowledgeBaseEntry(retentionInsight, {
            topic: 'views_predictor',
            platform,
            sourceType: doc.sourceType,
            contentType: 'case_study',
            ingestedAt: new Date(),
            layer: 'example',
            score: 0.9,
        });
    }
}
