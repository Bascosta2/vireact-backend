import { Readable } from 'stream';
import TwelveLabsClient from '../lib/twelve-labs.js';
import { TWELVE_LABS_INDEX_ID } from '../config/index.js';
import { waitForAssetReady, indexAssetWithRetry } from './video.service.js';
import { TWELVE_LABS_SCENE_PROMPT, parseScenesWithOpenAI } from './scene-parser.service.js';
import { analyzeHook } from './analyzer/hook.analyzer.js';
import { analyzeCaption } from './analyzer/caption.analyzer.js';
import { analyzePacing } from './analyzer/pacing.analyzer.js';
import { analyzeAudio } from './analyzer/audio.analyzer.js';
import { analyzeAdvancedAnalytics } from './analyzer/advanced-analytics.analyzer.js';
import { analyzeViewsPredictor } from './analyzer/views-predictor.analyzer.js';
import { VideoPerformanceDataset } from '../model/VideoPerformanceDataset.model.js';
import { KnowledgeBase } from '../model/knowledge-base.model.js';
import openai from '../lib/openai.js';

const EMBEDDING_MODEL = 'text-embedding-3-large';
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
    await KnowledgeBase.create({
        content,
        embedding,
        metadata: {
            ...metadata,
            layer: metadata.layer ?? 'raw',
            score: metadata.score ?? 0.9,
            date: metadata.date ?? new Date(),
        },
    });
}

export async function ingestPairedVideo(file, fields, datasetId) {
    const filename = file.originalname || file.name || 'video';
    let fileToUpload;
    if (Buffer.isBuffer(file)) {
        fileToUpload = Readable.from(file);
    } else if (file.buffer) {
        fileToUpload = Readable.from(file.buffer);
    } else if (file instanceof Readable) {
        fileToUpload = file;
    } else {
        fileToUpload = Readable.from(Buffer.from(file));
    }

    const assetResponse = await TwelveLabsClient.assets.create({
        method: 'direct',
        file: fileToUpload,
    });

    if (assetResponse?.status === 'failed') {
        throw new Error(`TwelveLabs upload failed: ${assetResponse.error || 'Unknown error'}`);
    }

    const twelveLabsAssetId = assetResponse?.id || assetResponse?._id;
    if (!twelveLabsAssetId) {
        throw new Error('Failed to get asset ID from TwelveLabs response');
    }

    await waitForAssetReady(twelveLabsAssetId, assetResponse?.status);
    const { indexedAssetId } = await indexAssetWithRetry(twelveLabsAssetId);
    const twelveLabsVideoId = indexedAssetId;

    const videoAnalysisResult = await TwelveLabsClient.analyze({
        videoId: twelveLabsVideoId,
        prompt: TWELVE_LABS_SCENE_PROMPT,
        temperature: 0.2,
    });

    const scenes = await parseScenesWithOpenAI(videoAnalysisResult);
    const hookScene = scenes.find(s => s.purpose?.toLowerCase() === 'hook') || scenes[0];
    const hookText = hookScene?.primaryAction || hookScene?.visualDescription || '';

    // Auto-extract duration from parsed scenes
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

export async function ingestCreatorVideo(videoUrl, datasetId) {
    const assetResponse = await TwelveLabsClient.assets.create({
        method: 'url',
        url: videoUrl,
    });

    if (assetResponse?.status === 'failed') {
        throw new Error(`TwelveLabs URL upload failed: ${assetResponse.error || 'Unknown error'}`);
    }

    const twelveLabsAssetId = assetResponse?.id || assetResponse?._id;
    if (!twelveLabsAssetId) {
        throw new Error('Failed to get asset ID from TwelveLabs response');
    }

    await waitForAssetReady(twelveLabsAssetId, assetResponse?.status);
    const { indexedAssetId } = await indexAssetWithRetry(twelveLabsAssetId);
    const twelveLabsVideoId = indexedAssetId;

    const videoAnalysisResult = await TwelveLabsClient.analyze({
        videoId: twelveLabsVideoId,
        prompt: TWELVE_LABS_SCENE_PROMPT,
        temperature: 0.2,
    });

    const scenes = await parseScenesWithOpenAI(videoAnalysisResult);
    const hookScene = scenes.find(s => s.purpose?.toLowerCase() === 'hook') || scenes[0];
    const hookText = hookScene?.primaryAction || hookScene?.visualDescription || '';

    // Auto-extract duration from parsed scenes
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

export function buildPerformanceSummaryPayload(doc, sourceType) {
    const firstScene = Array.isArray(doc.scenes) && doc.scenes[0]
        ? (doc.scenes[0].primaryAction || doc.scenes[0].visualDescription || doc.scenes[0].purpose || '')
        : '';
    const parts = [
        '[PERFORMANCE DATA]',
        `Platform: ${doc.platform}`,
        `Niche: ${doc.niche}`,
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
    if (sourceType === 'creator_video' && (doc.creatorHandle || doc.subscriberCount != null)) {
        parts.push(`Creator: ${doc.creatorHandle || 'N/A'}`);
        parts.push(`Subscribers: ${doc.subscriberCount != null ? doc.subscriberCount : 'N/A'}`);
    }
    return parts.join(', ');
}

export async function savePerformanceKnowledgeBase(doc, sourceType) {
    const content = buildPerformanceSummaryPayload(doc, sourceType);
    const metadata = {
        topic: 'views_predictor',
        platform: doc.platform,
        niche: doc.niche,
        sourceType,
        source: 'admin_ingest',
        score: 0.9,
    };
    if (sourceType === 'creator_video') {
        metadata.creatorHandle = doc.creatorHandle;
        metadata.subscriberCount = doc.subscriberCount;
    }
    await createKnowledgeBaseEntry(content, metadata);

    const durationSeconds = doc.durationSeconds;
    const retentionRate = doc.retentionRate;
    if (durationSeconds != null && retentionRate != null) {
        const platform = doc.platform;
        const niche = doc.niche;
        const actualViews = doc.actualViews;
        const viralityScore = doc.viralityScore ?? 'N/A';
        const retentionInsight = retentionRate > 100
            ? `SHORT VIDEO RETENTION INSIGHT: A ${durationSeconds}s video in the ${niche} niche on ${platform} achieved ${retentionRate}% retention (replay rate: ${(retentionRate / 100).toFixed(1)}x) and got ${actualViews} actual views. High retention on short videos indicates strong loop-ability and hook quality. Virality score was ${viralityScore}.`
            : `VIDEO RETENTION DATA: A ${durationSeconds}s video in the ${niche} niche on ${platform} achieved ${retentionRate}% retention and got ${actualViews} actual views. Virality score was ${viralityScore}.`;
        await createKnowledgeBaseEntry(retentionInsight, {
            topic: 'views_predictor',
            platform,
            niche,
            sourceType: doc.sourceType,
            contentType: 'case_study',
            ingestedAt: new Date(),
            layer: 'example',
            score: 0.9,
        });
    }
}
