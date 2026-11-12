import fs from 'node:fs';
import openai from '../../lib/openai.js';
import { recordGeneration } from '../../lib/ai-tracking.js';

/**
 * Word-level transcript for the editor (Twelve Labs only returns sentence-level segments, which is
 * too coarse for jump cuts and word captions). Uses OpenAI transcription with word timestamps.
 */
export const TRANSCRIBE_MODEL = process.env.EDITOR_TRANSCRIBE_MODEL || 'whisper-1';

export async function transcribeWords(audioPath, { client = openai } = {}) {
    const started = Date.now();
    try {
        const res = await client.audio.transcriptions.create({
            file: fs.createReadStream(audioPath),
            model: TRANSCRIBE_MODEL,
            response_format: 'verbose_json',
            timestamp_granularities: ['word'],
        });
        const words = (res.words ?? [])
            .map((w) => ({ w: String(w.word ?? '').trim(), start: Number(w.start), end: Number(w.end) }))
            .filter((w) => w.w && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start);
        recordGeneration({
            provider: 'openai',
            model: TRANSCRIBE_MODEL,
            label: 'editor_transcription',
            input: '[audio]',
            output: res.text ?? '',
            latencyMs: Date.now() - started,
            properties: { words: words.length, language: res.language ?? null, audio_seconds: res.duration ?? null },
        });
        return { words, language: res.language ?? null, text: res.text ?? '' };
    } catch (error) {
        recordGeneration({ provider: 'openai', model: TRANSCRIBE_MODEL, label: 'editor_transcription', input: '[audio]', latencyMs: Date.now() - started, error });
        throw error;
    }
}
