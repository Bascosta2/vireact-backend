/**
 * Twelve Labs video understanding (Pegasus).
 *
 * Twelve Labs sunset Pegasus 1.2, which read videos through an index (`videoId`). Pegasus 1.5 reads the
 * uploaded asset directly, so analysis no longer depends on the index at all:
 *   analyze({ modelName: 'pegasus1.5', video: { type: 'asset_id', assetId }, prompt, ... })
 * Requires twelvelabs-js >= 1.3 (pinned in package.json). The asset must be in the `ready` status.
 */
import TwelveLabsClient from './twelve-labs.js';
import { videoModel } from '../config/ai-models.js';
import { recordGeneration, withAiContext } from './ai-tracking.js';

/** Pegasus model id (AI_MODEL_VIDEO, default pegasus1.6). Read per call so env changes apply. */
export const pegasusModel = () => videoModel();

const ANALYZE_TIMEOUT_SECONDS = 300;

/**
 * Pick what Pegasus should read: the uploaded asset when we have one, otherwise the HLS stream of the
 * indexed video (a VOD HLS manifest URL is an accepted input).
 * @returns {{ type: 'asset_id', assetId: string } | { type: 'url', url: string } | null}
 */
export const buildVideoContext = ({ assetId, streamUrl } = {}) => {
    if (assetId) return { type: 'asset_id', assetId };
    if (streamUrl) return { type: 'url', url: streamUrl };
    return null;
};

/** 4xx (except 408/429) will fail the same way again, so only transient errors are retried. */
export const isRetryableTwelveLabsError = (error) => {
    const status = Number(error?.statusCode);
    if (!Number.isFinite(status) || status === 0) return true; // network error / timeout
    return status === 408 || status === 429 || status >= 500;
};

const describeError = (error) => {
    const status = error?.statusCode ? `${error.statusCode} ` : '';
    const body = error?.body?.message ? ` (${error.body.message})` : '';
    return `${status}${error?.message || String(error)}${body}`;
};

/** Record one Pegasus call for AI observability. The prompt is the input; the video is noted beside it. */
const trackPegasus = ({ request, label, attempt, started, response, text, error }) => {
    const video = request?.video || {};
    const videoRef = video.assetId ? `asset:${video.assetId}` : video.url ? 'hls-url' : request?.videoId ? `index-video:${request.videoId}` : 'unknown';
    withAiContext({ attempt }, () => recordGeneration({
        provider: 'twelvelabs',
        model: request?.modelName || pegasusModel(),
        label,
        input: [{ role: 'user', content: `[video: ${videoRef}]
${request?.prompt || ''}` }],
        output: text ?? (typeof response?.data === 'string' ? response.data : ''),
        usage: { inputTokens: response?.usage?.inputTokens, outputTokens: response?.usage?.outputTokens },
        latencyMs: Date.now() - started,
        stopReason: response?.finishReason,
        error,
        params: { temperature: request?.temperature, maxTokens: request?.maxTokens },
        properties: response?.id ? { twelvelabs_response_id: response.id } : undefined,
    }));
};

/**
 * One Pegasus request with up to `attempts` tries on transient errors.
 * @returns {Promise<string>} the generated text
 */
const runAnalyze = async (request, { attempts = 2, label = 'analyze', retryDelayMs = 5000 } = {}) => {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const started = Date.now();
        let response;
        try {
            response = await TwelveLabsClient.analyze(request, { timeoutInSeconds: ANALYZE_TIMEOUT_SECONDS });
            const text = typeof response?.data === 'string' ? response.data : '';
            if (!text.trim()) {
                throw new Error(`Twelve Labs ${label} returned an empty response${response?.finishReason ? ` (finish reason: ${response.finishReason})` : ''}`);
            }
            trackPegasus({ request, label, attempt, started, response, text });
            return text;
        } catch (error) {
            trackPegasus({ request, label, attempt, started, response, error });
            lastError = error;
            console.error(`[TwelveLabs] ${label} failed (attempt ${attempt}/${attempts}): ${describeError(error)}`);
            if (attempt < attempts && isRetryableTwelveLabsError(error)) {
                await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
                continue;
            }
            break;
        }
    }
    throw lastError;
};

/**
 * Scene-by-scene breakdown for the analyzers.
 * @param {{ assetId?: string|null, streamUrl?: string|null }} source
 * @param {string} prompt TWELVE_LABS_SCENE_PROMPT
 * @returns {Promise<string>} raw text in the prompt's SCENE:/START_TIME:/... format
 */
export const analyzeVideoScenes = async (source, prompt, options = {}) => {
    const video = buildVideoContext(source);
    if (!video) throw new Error('No Twelve Labs asset or stream URL to analyze.');
    return runAnalyze(
        { modelName: pegasusModel(), video, prompt, temperature: 0.2, maxTokens: 4096 },
        { label: 'scene analysis', ...options }
    );
};

const TRANSCRIPT_PROMPT = [
    'Transcribe every word spoken in this video, verbatim, in the original language.',
    'Return one segment per sentence or phrase with its start and end time in seconds from the start of the video.',
    'Do not summarize, correct or translate. Do not include song lyrics from background music, only speech.',
    'If nobody speaks, return an empty segments array.',
].join(' ');

const TRANSCRIPT_SCHEMA = {
    type: 'object',
    properties: {
        segments: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    start: { type: 'number' },
                    end: { type: 'number' },
                    text: { type: 'string' },
                },
                required: ['start', 'end', 'text'],
            },
        },
    },
    required: ['segments'],
};

/** Parse Pegasus' JSON transcript into `rawTranscript` segments. Never throws. */
export const parsePegasusTranscript = (text) => {
    let parsed;
    try {
        const raw = String(text ?? '').trim();
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        parsed = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
    } catch {
        return [];
    }
    const segments = Array.isArray(parsed?.segments) ? parsed.segments : [];
    return segments
        .map((segment) => {
            const words = typeof segment?.text === 'string' ? segment.text.trim() : '';
            const tStart = Number(segment?.start);
            const tEnd = Number(segment?.end);
            if (!words || !Number.isFinite(tStart)) return null;
            return {
                text: words,
                tStart: Math.max(0, tStart),
                tEnd: Number.isFinite(tEnd) ? Math.max(tStart, tEnd) : tStart,
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.tStart - b.tStart);
};

/**
 * Timestamped speech transcript from Pegasus. Used when the index returns no transcription.
 * Never throws: a missing transcript degrades the analysis, it does not fail it.
 * @returns {Promise<Array<{ text: string, tStart: number, tEnd: number }>>}
 */
export const transcribeVideoWithPegasus = async (source, options = {}) => {
    const video = buildVideoContext(source);
    if (!video) return [];
    try {
        const text = await runAnalyze(
            {
                modelName: pegasusModel(),
                video,
                prompt: TRANSCRIPT_PROMPT,
                temperature: 0,
                maxTokens: 4096,
                responseFormat: { type: 'json_schema', jsonSchema: TRANSCRIPT_SCHEMA },
            },
            { label: 'transcription', ...options }
        );
        return parsePegasusTranscript(text);
    } catch (error) {
        console.warn(`[TwelveLabs] Pegasus transcription unavailable: ${describeError(error)}`);
        return [];
    }
};

const SCENES_PROMPT = [
    'Break this short-form video into every distinct scene or cut, in order, covering the whole video.',
    'For each scene give: start and end time in seconds; what is visibly on screen (subject, background, motion, camera, text overlays) in 1-3 specific sentences;',
    'the exact on-screen text or an empty string; the audio (spoken words verbatim if any, music, sound effects, silence);',
    'the primary action; the emotional tone; and the purpose, one of: hook, context, story, demonstration, proof, tension, payoff, cta, filler, transition, loop-setup.',
    'The first scene starts at 0. Do not merge scenes and do not invent anything that is not in the video.',
].join(' ');

const SCENES_SCHEMA = {
    type: 'object',
    properties: {
        scenes: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    startTime: { type: 'number' },
                    endTime: { type: 'number' },
                    visualDescription: { type: 'string' },
                    onScreenText: { type: 'string' },
                    audioSummary: { type: 'string' },
                    primaryAction: { type: 'string' },
                    emotionalTone: { type: 'string' },
                    purpose: { type: 'string' },
                },
                required: ['startTime', 'endTime', 'visualDescription', 'onScreenText', 'audioSummary', 'primaryAction', 'emotionalTone', 'purpose'],
            },
        },
    },
    required: ['scenes'],
};

const NONE_TEXT = /^(none|n\/a|null|no text|no on-screen text)$/i;
const cleanText = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    return NONE_TEXT.test(text) ? '' : text;
};

/** Parse Pegasus' JSON scene list into the Video.scenes shape. Never throws; returns [] when unusable. */
export const parsePegasusScenes = (text) => {
    let parsed;
    try {
        const raw = String(text ?? '').trim();
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        parsed = JSON.parse(start >= 0 && end > start ? raw.slice(start, end + 1) : raw);
    } catch {
        return [];
    }
    const scenes = (Array.isArray(parsed?.scenes) ? parsed.scenes : [])
        .map((scene) => {
            const startTime = Number(scene?.startTime);
            const endTime = Number(scene?.endTime);
            if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null;
            return {
                startTime: Math.max(0, startTime),
                endTime: Math.max(Math.max(0, startTime), endTime),
                visualDescription: cleanText(scene.visualDescription),
                onScreenText: cleanText(scene.onScreenText),
                audioSummary: cleanText(scene.audioSummary),
                primaryAction: cleanText(scene.primaryAction),
                emotionalTone: cleanText(scene.emotionalTone),
                purpose: cleanText(scene.purpose).toLowerCase(),
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.startTime - b.startTime);
    return scenes.map((scene, index) => ({ sceneNumber: index + 1, ...scene }));
};

/**
 * Scene list as structured JSON straight from Pegasus (no separate text-to-JSON model call).
 * @returns {Promise<object[]>} scenes ([] when Pegasus returned nothing usable)
 */
export const analyzeVideoScenesStructured = async (source, options = {}) => {
    const video = buildVideoContext(source);
    if (!video) throw new Error('No Twelve Labs asset or stream URL to analyze.');
    const text = await runAnalyze(
        {
            modelName: pegasusModel(),
            video,
            prompt: SCENES_PROMPT,
            temperature: 0.2,
            maxTokens: 4096,
            responseFormat: { type: 'json_schema', jsonSchema: SCENES_SCHEMA },
        },
        { label: 'structured scene analysis', ...options }
    );
    return parsePegasusScenes(text);
};
