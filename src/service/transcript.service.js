/**
 * Transcript + stream retrieval from Twelve Labs.
 *
 * GRANULARITY: Twelve Labs returns SEGMENT-level transcription
 * (`TranscriptionDataItem = { start, end, value }`), not word-level tokens. That
 * is the confirmed ceiling of the current SDK (twelvelabs-js@1.1.0), so
 * `Video.rawTranscript` stores timestamped segments and every verbatim "before"
 * field quotes a segment. No second transcription dependency (Whisper) is
 * introduced — see CONNECTIONS_CHECKLIST.md for the external-service contract.
 *
 * The same call returns the HLS stream object (available because indexing sets
 * `enableVideoStream: true` in `indexAssetWithRetry`), which is what the report
 * uses for click-to-seek playback.
 */

import TwelveLabsClient from '../lib/twelve-labs.js';
import { formatTimecode } from './analyzer/feedback-schema.js';

const RETRIEVE_TIMEOUT_SECONDS = 60;

const mapTranscription = (transcription) => {
    if (!Array.isArray(transcription)) return [];
    return transcription
        .map((segment) => {
            const text = typeof segment?.value === 'string' ? segment.value.trim() : '';
            const tStart = Number(segment?.start);
            const tEnd = Number(segment?.end);
            if (!text || !Number.isFinite(tStart)) return null;
            return {
                text,
                tStart: Math.max(0, tStart),
                tEnd: Number.isFinite(tEnd) ? Math.max(tStart, tEnd) : tStart,
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.tStart - b.tStart);
};

const mapHls = (hls) => ({
    streamUrl: typeof hls?.videoUrl === 'string' && hls.videoUrl ? hls.videoUrl : null,
    thumbnailUrl: Array.isArray(hls?.thumbnailUrls) && hls.thumbnailUrls[0] ? hls.thumbnailUrls[0] : null,
});

/**
 * Fetch transcript + stream metadata for an indexed video.
 *
 * Never throws: transcript is an enrichment, so a failure degrades the analysis
 * to scene-only grounding rather than failing the job.
 *
 * @param {string} indexId Twelve Labs index the video was indexed into
 * @param {string} indexedVideoId `Video.twelveLabsVideoId`
 * @returns {Promise<{ rawTranscript: Array<{text:string,tStart:number,tEnd:number}>, streamUrl: string|null, thumbnailUrl: string|null }>}
 */
export const fetchIndexedVideoMedia = async (indexId, indexedVideoId) => {
    const empty = { rawTranscript: [], streamUrl: null, thumbnailUrl: null };
    if (!indexId || !indexedVideoId) {
        console.warn('[Transcript] Missing indexId or indexedVideoId; skipping transcript fetch');
        return empty;
    }

    const attempts = [
        {
            label: 'indexedAssets.retrieve',
            run: () => TwelveLabsClient.indexes.indexedAssets.retrieve(
                indexId,
                indexedVideoId,
                { transcription: true },
                { timeoutInSeconds: RETRIEVE_TIMEOUT_SECONDS }
            ),
        },
        {
            label: 'videos.retrieve',
            run: () => TwelveLabsClient.indexes.videos.retrieve(
                indexId,
                indexedVideoId,
                { transcription: true },
                { timeoutInSeconds: RETRIEVE_TIMEOUT_SECONDS }
            ),
        },
    ];

    for (const attempt of attempts) {
        try {
            const result = await attempt.run();
            const rawTranscript = mapTranscription(result?.transcription);
            const { streamUrl, thumbnailUrl } = mapHls(result?.hls);
            if (rawTranscript.length === 0) {
                console.log(`[Transcript] ${attempt.label} returned no spoken segments for ${indexedVideoId}`);
            } else {
                console.log(`[Transcript] ${attempt.label} returned ${rawTranscript.length} segments for ${indexedVideoId}`);
            }
            return { rawTranscript, streamUrl, thumbnailUrl };
        } catch (error) {
            console.warn(`[Transcript] ${attempt.label} failed for ${indexedVideoId}: ${error.message}`);
        }
    }

    return empty;
};

/**
 * Prompt block for analyzers/chat. Timecodes and seconds are both shown so the
 * model can cite a range without converting formats.
 */
export const buildTranscriptBlock = (rawTranscript) => {
    if (!Array.isArray(rawTranscript) || rawTranscript.length === 0) {
        return 'No spoken transcript available for this video (no speech detected). Do not invent spoken lines or script rewrites.';
    }
    return rawTranscript
        .map((segment) => `[${formatTimecode(segment.tStart)} - ${formatTimecode(segment.tEnd)}] (${segment.tStart.toFixed(2)}s-${segment.tEnd.toFixed(2)}s) "${segment.text}"`)
        .join('\n');
};

/** Flattened transcript text used by the validator's verbatim check. */
export const transcriptToPlainText = (rawTranscript) => {
    if (!Array.isArray(rawTranscript)) return '';
    return rawTranscript.map((segment) => segment.text).join(' ');
};

/** Segment covering (or nearest to) a time in seconds — used to ground quotes. */
export const findTranscriptSegmentAt = (rawTranscript, seconds) => {
    if (!Array.isArray(rawTranscript) || rawTranscript.length === 0 || !Number.isFinite(seconds)) return null;
    return (
        rawTranscript.find((segment) => seconds >= segment.tStart && seconds <= segment.tEnd) ||
        rawTranscript.reduce((closest, segment) => {
            if (!closest) return segment;
            return Math.abs(segment.tStart - seconds) < Math.abs(closest.tStart - seconds) ? segment : closest;
        }, null)
    );
};
