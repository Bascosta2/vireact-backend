import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VideoPerformanceDataset } from '../../model/VideoPerformanceDataset.model.js';
import { KnowledgeBase } from '../../model/knowledge-base.model.js';
import { KB_SPECIFICITY } from '../../constants.js';
import { requestClaudeJson } from '../../lib/anthropic.js';
import { withAiContext, newTraceId } from '../../lib/ai-tracking.js';
import { prepareMedia } from './media-prep.js';
import { transcribeWords } from './transcribe.js';
import { embedText } from './exemplars.js';

/**
 * Edit profile for one viral example (admin upload): measured numbers (shot length, cut rate,
 * speaking pace, pauses) plus Claude's read of the editing style from the frames, then an embedding
 * and an `editing` knowledge-base entry so both the editor and the analyzers can learn from it.
 */

const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const s = { type: 'string' };

export const PROFILE_SCHEMA = obj({
    captionStyle: s,
    captionDensity: { type: 'string', enum: ['none', 'sparse', 'every_line', 'word_by_word'] },
    zoomsPerMin: { type: 'number' },
    textOverlayUse: s,
    hookPattern: s,
    hookFirst2s: s,
    musicPresence: { type: 'string', enum: ['none', 'background', 'prominent', 'unknown'] },
    sfxUse: s,
    pacingNotes: s,
    summary: s,
});

const PROFILE_SYSTEM = [
    'You study short-form videos that performed well and describe how they are edited, so an AI editor can apply the same techniques to other creators\' footage.',
    'Describe only what you can see in the frames and read in the transcript and measurements. Be concrete and short (one sentence per field).',
    'captionStyle: font look, size, position, color, animation. hookPattern: the technique (e.g. "result first, then how", "question to camera", "mid-action cold open"). hookFirst2s: what literally happens in the first 2 seconds.',
    'zoomsPerMin: your estimate of punch-ins or zoom moves per minute from the frames (0 if none).',
    'summary: 2 or 3 sentences on what another creator should copy from this edit, written as instructions. No hype words, no em dashes.',
    'Return only the JSON object.',
].join('\n');

const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);

/** Measured editing numbers. Pure. */
export function measureEdit({ info, sceneCuts, silences, words }) {
    const dur = info.durationSec || 0;
    const minutes = dur / 60;
    const speechSec = words.length ? Math.max(0.1, words[words.length - 1].end - words[0].start) : 0;
    const pauseSec = silences.reduce((n, x) => n + (x.end - x.start), 0);
    const ratio = info.width && info.height ? info.width / info.height : null;
    return {
        durationSec: round1(dur),
        avgShotSec: round1(dur / (sceneCuts.length + 1)),
        cutsPerMin: round1(minutes > 0 ? sceneCuts.length / minutes : 0),
        speechWpm: words.length ? Math.round(words.length / (speechSec / 60)) : 0,
        pauseRatio: round1(dur > 0 ? (pauseSec / dur) * 100 : 0),
        aspect: ratio == null ? 'unknown' : ratio < 0.7 ? '9:16' : ratio < 0.9 ? '4:5' : ratio < 1.2 ? '1:1' : '16:9',
    };
}

/** Text that is embedded and stored in the knowledge base. */
export function profileText(doc, profile) {
    const views = (doc.actualViews ?? 0).toLocaleString('en-US');
    return [
        `Editing pattern from a ${doc.platform} video${doc.niche ? ` in ${doc.niche}` : ''} with ${views} views${doc.followers ? ` (creator had ${doc.followers.toLocaleString('en-US')} followers)` : ''}.`,
        `${profile.durationSec}s long, ${profile.aspect}, average shot ${profile.avgShotSec}s, ${profile.cutsPerMin} cuts per minute, about ${profile.zoomsPerMin} zooms per minute, speech ${profile.speechWpm} words per minute.`,
        `Hook: ${profile.hookPattern}. First 2 seconds: ${profile.hookFirst2s}.`,
        `Captions: ${profile.captionStyle} (${profile.captionDensity}). Text overlays: ${profile.textOverlayUse}. Music: ${profile.musicPresence}. Sound effects: ${profile.sfxUse}.`,
        `Pacing: ${profile.pacingNotes}`,
        `What to copy: ${profile.summary}`,
    ].join('\n');
}

/**
 * Profile one example from a local file. Never throws: failures are stored on the document so the
 * admin page can show them and retry.
 */
export async function profileExample(datasetId, filePath, deps = {}) {
    const prepare = deps.prepare ?? prepareMedia;
    const transcribe = deps.transcribe ?? transcribeWords;
    const request = deps.request ?? requestClaudeJson;
    const embed = deps.embed ?? embedText;
    const workDir = path.join(os.tmpdir(), 'vireact-examples', String(datasetId));
    await VideoPerformanceDataset.updateOne({ _id: datasetId }, { $set: { editProfileStatus: 'pending', editProfileError: null } });
    try {
        const doc = await VideoPerformanceDataset.findById(datasetId).lean();
        if (!doc) throw new Error('Example not found');
        const prepared = await prepare(filePath, workDir);
        const { words } = prepared.audioPath ? await transcribe(prepared.audioPath) : { words: [] };
        const measured = measureEdit({ info: prepared.info, sceneCuts: prepared.sceneCuts, silences: prepared.silences, words });

        const content = [{
            type: 'text',
            text: [
                `Platform: ${doc.platform}. Niche: ${doc.niche || 'unknown'}. Views: ${doc.actualViews}.`,
                `Measured: ${JSON.stringify(measured)}`,
                `Transcript: ${words.map((w) => w.w).join(' ').slice(0, 6000) || '(no speech)'}`,
                `Frames: ${prepared.sheets.length} contact sheet(s), 3x3 grids, left to right, top to bottom, one frame every ${prepared.sheets[0]?.intervalSec ?? 1}s.`,
            ].join('\n'),
        }];
        for (const sheet of prepared.sheets) {
            content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: (await fs.promises.readFile(sheet.path)).toString('base64') } });
        }
        const { data } = await withAiContext(
            { feature: 'editor_exemplar_profile', distinctId: 'system:admin', traceId: newTraceId(`example-${datasetId}`) },
            () => request({ label: 'editor_exemplar_profile', system: PROFILE_SYSTEM, messages: [{ role: 'user', content }], schema: PROFILE_SCHEMA, effort: 'medium', maxTokens: 8000 })
        );

        const profile = { ...measured, ...data, zoomsPerMin: round1(Math.max(0, Number(data.zoomsPerMin) || 0)), profiledAt: new Date() };
        const text = profileText(doc, profile);
        const embedding = await embed(text);
        await VideoPerformanceDataset.updateOne(
            { _id: datasetId },
            { $set: { editProfile: profile, editEmbedding: embedding, editProfileStatus: 'ready', editProfileError: null, durationSeconds: measured.durationSec } }
        );
        await KnowledgeBase.deleteMany({ 'metadata.source': `editor_example:${datasetId}` });
        await KnowledgeBase.create({
            content: text,
            embedding,
            metadata: {
                topic: 'editing',
                layer: 'example',
                source: `editor_example:${datasetId}`,
                score: Math.min(1, Math.max(0.5, Math.log10((doc.actualViews ?? 0) + 10) / 7)),
                specificity: KB_SPECIFICITY.DIRECTIONAL,
                platform: doc.platform,
                niche: doc.niche ?? undefined,
                actualViews: doc.actualViews,
                sourceType: 'editor_example',
            },
        });
        return { ok: true, profile };
    } catch (err) {
        console.error(`[Editor] Profiling example ${datasetId} failed:`, err.message);
        await VideoPerformanceDataset.updateOne({ _id: datasetId }, { $set: { editProfileStatus: 'failed', editProfileError: String(err.message).slice(0, 300) } });
        return { ok: false, error: err.message };
    } finally {
        await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
}
