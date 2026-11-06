/**
 * Twelve Labs video understanding (Pegasus).
 *
 * Twelve Labs sunset Pegasus 1.2, which read videos through an index (`videoId`). Pegasus 1.5 reads the
 * uploaded asset directly, so analysis no longer depends on the index at all:
 *   analyze({ modelName: 'pegasus1.5', video: { type: 'asset_id', assetId }, prompt, ... })
 * Requires twelvelabs-js >= 1.3 (pinned in package.json). The asset must be in the `ready` status.
 */
import TwelveLabsClient from './twelve-labs.js';

export const PEGASUS_MODEL = 'pegasus1.5';

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

/**
 * One Pegasus request with up to `attempts` tries on transient errors.
 * @returns {Promise<string>} the generated text
 */
const runAnalyze = async (request, { attempts = 2, label = 'analyze', retryDelayMs = 5000 } = {}) => {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const response = await TwelveLabsClient.analyze(request, { timeoutInSeconds: ANALYZE_TIMEOUT_SECONDS });
            const text = typeof response?.data === 'string' ? response.data : '';
            if (!text.trim()) {
                throw new Error(`Twelve Labs ${label} returned an empty response${response?.finishReason ? ` (finish reason: ${response.finishReason})` : ''}`);
            }
            return text;
        } catch (error) {
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
        { modelName: PEGASUS_MODEL, video, prompt, temperature: 0.2, maxTokens: 4096 },
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
                modelName: PEGASUS_MODEL,
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
