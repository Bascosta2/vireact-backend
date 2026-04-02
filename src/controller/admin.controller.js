import { TwelvelabsApiError } from 'twelvelabs-js';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { VideoPerformanceDataset } from '../model/VideoPerformanceDataset.model.js';
import {
    ingestPairedVideo,
    ingestCreatorVideo,
    savePerformanceKnowledgeBase,
} from '../service/admin-ingest.service.js';
import { chunkContentForKnowledge, ingestKnowledgeChunks } from '../service/admin-knowledge.service.js';

const ALLOWED_VIDEO_MIMES = [
    'video/mp4',
    'video/mpeg',
    'video/quicktime',
    'video/x-msvideo',
    'video/webm',
    'video/x-matroska',
];

function parseNumber(val) {
    if (val === undefined || val === null || val === '') return undefined;
    const n = Number(val);
    return Number.isFinite(n) ? n : undefined;
}

function parseOptionalDate(val) {
    if (val === undefined || val === null || val === '') return undefined;
    const d = new Date(val);
    return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Map ingest pipeline failures to HTTP status + client-safe message. */
function adminIngestPipelineApiError(pipelineError) {
    if (pipelineError instanceof TwelvelabsApiError) {
        const body = pipelineError.body;
        const apiCode = body && typeof body === 'object' && !Array.isArray(body) ? body.code : undefined;
        const apiMsg = body && typeof body === 'object' && typeof body.message === 'string' ? body.message : undefined;
        if (pipelineError.statusCode === 401 || apiCode === 'api_key_invalid') {
            return new ApiError(
                502,
                'Twelve Labs API key is invalid or expired. Update TWELVE_LABS_API_KEY in vireact-backend/.env and restart the server.',
            );
        }
        const short =
            apiMsg ||
            (typeof pipelineError.message === 'string' ? pipelineError.message.split('\n')[0] : null) ||
            'Twelve Labs request failed';
        return new ApiError(502, short);
    }
    return new ApiError(500, pipelineError?.message || 'Ingest pipeline failed');
}

export async function postPairedVideo(req, res, next) {
    try {
        const file = req.file;
        const body = req.body || {};
        const actualViews = parseNumber(body.actualViews);
        const platform = (body.platform || '').trim().toLowerCase();
        const niche = (body.niche || '').trim();
        const creatorSize = (body.creatorSize || '').trim().toLowerCase();

        if (!file) {
            throw new ApiError(400, 'Video file is required');
        }
        if (actualViews == null || actualViews < 0) {
            throw new ApiError(400, 'actualViews is required and must be a non-negative number');
        }
        if (!['tiktok', 'instagram', 'youtube', 'facebook'].includes(platform)) {
            throw new ApiError(400, 'platform is required and must be one of: tiktok, instagram, youtube, facebook');
        }
        if (!niche) {
            throw new ApiError(400, 'niche is required');
        }
        if (!['micro', 'small', 'medium', 'large', 'mega'].includes(creatorSize)) {
            throw new ApiError(400, 'creatorSize is required and must be one of: micro, small, medium, large, mega');
        }
        if (!ALLOWED_VIDEO_MIMES.includes(file.mimetype)) {
            throw new ApiError(400, 'Invalid file type. Only video files (MP4, MOV, WEBM, AVI, MKV) are allowed.');
        }

        const filename = file.originalname || file.name || 'video';
        const doc = new VideoPerformanceDataset({
            sourceType: 'own_video',
            filename,
            platform,
            niche,
            creatorSize,
            actualViews,
            status: 'processing',
            postedAt: parseOptionalDate(body.postedAt),
            retentionRate: parseNumber(body.retentionRate),
            likeRate: parseNumber(body.likeRate),
            shareRate: parseNumber(body.shareRate),
            commentRate: parseNumber(body.commentRate),
            followRate: parseNumber(body.followRate),
            swipeRate: parseNumber(body.swipeRate),
        });
        await doc.save();
        const datasetId = doc._id.toString();

        try {
            const result = await ingestPairedVideo(file, body, datasetId);

            doc.twelveLabsAssetId = result.twelveLabsAssetId;
            doc.twelveLabsVideoId = result.twelveLabsVideoId;
            doc.scenes = result.scenes;
            doc.durationSeconds = result.durationSeconds ?? undefined;
            doc.analysis = result.analysis;
            doc.viralityScore = result.viralityScore ?? undefined;
            doc.hookScore = result.scores.hook ?? undefined;
            doc.pacingScore = result.scores.pacing ?? undefined;
            doc.audioScore = result.scores.audio ?? undefined;
            doc.captionScore = result.scores.caption ?? undefined;
            doc.viewsPredictorScore = result.scores.views_predictor ?? undefined;
            doc.status = 'complete';
            doc.analyzedAt = new Date();
            doc.errorMessage = undefined;
            await doc.save();

            await savePerformanceKnowledgeBase(doc, 'own_video');

            return res.status(201).json(doc);
        } catch (pipelineError) {
            doc.status = 'failed';
            doc.errorMessage = pipelineError?.message || String(pipelineError);
            await doc.save();
            throw adminIngestPipelineApiError(pipelineError);
        }
    } catch (err) {
        if (err instanceof ApiError) throw err;
        next(err);
    }
}

export async function postCreatorVideo(req, res, next) {
    try {
        const body = req.body || {};
        const videoUrl = (body.videoUrl || '').trim();
        const actualViews = parseNumber(body.actualViews);
        const platform = (body.platform || '').trim().toLowerCase();
        const niche = (body.niche || '').trim();
        const creatorHandle = (body.creatorHandle || '').trim();
        const subscriberCount = parseNumber(body.subscriberCount);
        const creatorSize = (body.creatorSize || '').trim().toLowerCase();
        const viralCategory = (body.viralCategory || '').trim();

        if (!videoUrl) {
            throw new ApiError(400, 'videoUrl is required');
        }
        try {
            new URL(videoUrl);
        } catch {
            throw new ApiError(400, 'videoUrl must be a valid URL');
        }
        if (actualViews == null || actualViews < 0) {
            throw new ApiError(400, 'actualViews is required and must be a non-negative number');
        }
        if (!['tiktok', 'instagram', 'youtube', 'facebook'].includes(platform)) {
            throw new ApiError(400, 'platform is required and must be one of: tiktok, instagram, youtube, facebook');
        }
        if (!niche) {
            throw new ApiError(400, 'niche is required');
        }
        if (!creatorHandle) {
            throw new ApiError(400, 'creatorHandle is required');
        }
        if (subscriberCount == null || subscriberCount < 0) {
            throw new ApiError(400, 'subscriberCount is required and must be a non-negative number');
        }
        if (!['micro', 'small', 'medium', 'large', 'mega'].includes(creatorSize)) {
            throw new ApiError(400, 'creatorSize is required and must be one of: micro, small, medium, large, mega');
        }
        const allowedCategories = ['hook_driven', 'trend_based', 'educational', 'emotional', 'comedic', 'informational'];
        if (!viralCategory || !allowedCategories.includes(viralCategory)) {
            throw new ApiError(400, `viralCategory is required and must be one of: ${allowedCategories.join(', ')}`);
        }

        const doc = new VideoPerformanceDataset({
            sourceType: 'creator_video',
            videoUrl,
            platform,
            niche,
            creatorHandle,
            subscriberCount,
            creatorSize,
            viralCategory,
            actualViews,
            status: 'processing',
            postedAt: parseOptionalDate(body.postedAt),
            retentionRate: parseNumber(body.retentionRate),
            likeRate: parseNumber(body.likeRate),
            shareRate: parseNumber(body.shareRate),
            commentRate: parseNumber(body.commentRate),
            followRate: parseNumber(body.followRate),
            swipeRate: parseNumber(body.swipeRate),
        });
        await doc.save();
        const datasetId = doc._id.toString();

        try {
            const result = await ingestCreatorVideo(videoUrl, datasetId);

            doc.twelveLabsAssetId = result.twelveLabsAssetId;
            doc.twelveLabsVideoId = result.twelveLabsVideoId;
            doc.scenes = result.scenes;
            doc.durationSeconds = result.durationSeconds ?? undefined;
            doc.analysis = result.analysis;
            doc.viralityScore = result.viralityScore ?? undefined;
            doc.hookScore = result.scores.hook ?? undefined;
            doc.pacingScore = result.scores.pacing ?? undefined;
            doc.audioScore = result.scores.audio ?? undefined;
            doc.captionScore = result.scores.caption ?? undefined;
            doc.viewsPredictorScore = result.scores.views_predictor ?? undefined;
            doc.status = 'complete';
            doc.analyzedAt = new Date();
            doc.errorMessage = undefined;
            await doc.save();

            await savePerformanceKnowledgeBase(doc, 'creator_video');

            return res.status(201).json(doc);
        } catch (pipelineError) {
            doc.status = 'failed';
            doc.errorMessage = pipelineError?.message || String(pipelineError);
            await doc.save();
            throw adminIngestPipelineApiError(pipelineError);
        }
    } catch (err) {
        if (err instanceof ApiError) throw err;
        next(err);
    }
}

const KNOWLEDGE_TOPICS = ['hook', 'pacing', 'audio', 'caption', 'views_predictor', 'advanced_analytics', 'general'];
const KNOWLEDGE_PLATFORMS = ['tiktok', 'instagram', 'youtube', 'facebook', 'all'];
const CONTENT_TYPES = ['research', 'platform_docs', 'creator_study', 'case_study', 'algorithm_breakdown'];

export async function postKnowledge(req, res, next) {
    try {
        const body = req.body || {};
        const file = req.file;
        const content = (body.content || '').trim();
        const source = (body.source || '').trim();
        const topic = (body.topic || '').trim().toLowerCase();
        const platform = (body.platform || '').trim().toLowerCase();
        const contentType = (body.contentType || '').trim();

        if (!content && !file) {
            throw new ApiError(400, 'Either content (text) or file (PDF) is required');
        }
        if (content && file) {
            throw new ApiError(400, 'Provide either content or file, not both');
        }
        if (!source) {
            throw new ApiError(400, 'source is required');
        }
        if (!KNOWLEDGE_TOPICS.includes(topic)) {
            throw new ApiError(400, `topic is required and must be one of: ${KNOWLEDGE_TOPICS.join(', ')}`);
        }
        if (!KNOWLEDGE_PLATFORMS.includes(platform)) {
            throw new ApiError(400, `platform is required and must be one of: ${KNOWLEDGE_PLATFORMS.join(', ')}`);
        }
        if (!CONTENT_TYPES.includes(contentType)) {
            throw new ApiError(400, `contentType is required and must be one of: ${CONTENT_TYPES.join(', ')}`);
        }

        let fullText = content;
        if (file) {
            const isPdfMime = file.mimetype === 'application/pdf' ||
                (file.mimetype === 'application/octet-stream' && file.originalname && /\.pdf$/i.test(file.originalname));
            if (!isPdfMime) {
                throw new ApiError(400, 'Invalid file type. Only PDF is allowed.');
            }
            try {
                const { PDFParse } = await import('pdf-parse');
                const buffer = file.buffer || file;
                const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
                const parser = new PDFParse({ data });
                const textResult = await parser.getText();
                fullText = (textResult && textResult.text) ? String(textResult.text) : '';
                await parser.destroy();
            } catch (pdfErr) {
                console.error('[postKnowledge] PDF parse error:', pdfErr);
                throw new ApiError(400, pdfErr?.message || 'Failed to parse PDF');
            }
        }

        if (!fullText || !fullText.trim()) {
            throw new ApiError(400, 'No text content to ingest (empty content or PDF with no text)');
        }

        const chunks = chunkContentForKnowledge(fullText);
        if (chunks.length === 0) {
            throw new ApiError(400, 'No chunks produced from content');
        }

        const chunksCreated = await ingestKnowledgeChunks(chunks, {
            topic,
            platform,
            source,
            contentType,
        });

        return res.status(201).json({
            success: true,
            chunksCreated,
            source,
            topic,
        });
    } catch (err) {
        console.error('[postKnowledge] Error:', err);
        if (err instanceof ApiError) throw err;
        next(err);
    }
}
