/**
 * Step 4 of the story-first pipeline: multimodal visual QA over rendered frames.
 *
 * After a render finishes, we sample a handful of frames per scene from the MP4 (FFmpeg), send each
 * frame together with the scene's declared `subject` + `action` to a vision model, and ask it to
 * return a strict JSON score. Per-scene scores aggregate into `project.storyboard.visualQa`, which
 * the UI surfaces as advisory ("possible mismatch") with a one-click "Regenerate this scene" option.
 *
 * Shipped dark: EDITOR_VISUAL_QA_ENABLED must be "true" to run. When off (default) this service is
 * a no-op. The vision provider is pluggable (Claude Opus/Haiku by default) and the service never
 * throws into the render pipeline; QA failures surface only on the QA field.
 */

import crypto from 'node:crypto';
import { requestClaudeJson } from '../../lib/anthropic.js';
import { EditProject } from '../../model/edit-project.model.js';

export const visualQaEnabled = () => String(process.env.EDITOR_VISUAL_QA_ENABLED ?? '').toLowerCase() === 'true';

export const FRAMES_PER_SCENE = Number(process.env.EDITOR_VISUAL_QA_FRAMES_PER_SCENE ?? 3) || 3;
export const MAX_SCENES_SAMPLED = Number(process.env.EDITOR_VISUAL_QA_MAX_SCENES ?? 6) || 6;
export const DEFAULT_THRESHOLD = Number(process.env.EDITOR_VISUAL_QA_THRESHOLD ?? 0.5) || 0.5;

const VQA_SCHEMA = {
    type: 'object',
    properties: {
        subjectPresent: { type: 'boolean' },
        actionPresent: { type: 'boolean' },
        confidence: { type: 'number' },
        note: { type: 'string' },
    },
    required: ['subjectPresent', 'actionPresent', 'confidence', 'note'],
    additionalProperties: false,
};

/**
 * Minimal, model-agnostic VQA call: given a PNG buffer and a scene's subject+action, return the
 * strict JSON score. Uses the Claude vision path (requestClaudeJson supports image message parts).
 * Returns null when the call fails (caller treats as inconclusive, no advisory surfaced).
 */
export async function scoreFrame({ pngBuffer, subject, action }, deps = {}) {
    const request = deps.request ?? requestClaudeJson;
    const base64 = pngBuffer.toString('base64');
    try {
        const { data } = await request({
            label: 'editor_visual_qa',
            system: [
                'You judge whether a single video frame shows a declared subject performing a declared action.',
                'Answer ONLY with the JSON schema. Be strict: if the frame is abstract, if the subject is not clearly visible, or if the action is ambiguous, set the booleans to false and explain briefly in `note`.',
                'Set `confidence` between 0 and 1.',
            ].join('\n'),
            messages: [{
                role: 'user',
                content: [
                    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
                    { type: 'text', text: `SUBJECT: ${subject}\nACTION: ${action}\n\nIs the subject visually present AND is the declared action happening in this frame?` },
                ],
            }],
            schema: VQA_SCHEMA,
            effort: 'low',
            maxTokens: 400,
        });
        return data ?? null;
    } catch (_err) {
        return null;
    }
}

/** Aggregate per-frame scores into one scene verdict. A mismatch is "possible" when > threshold of frames failed. */
export function aggregateScene({ sceneIdx, scoredFrames, threshold = DEFAULT_THRESHOLD }) {
    const scores = scoredFrames.filter(Boolean);
    const total = scores.length || 1;
    const subjectHits = scores.filter((s) => s.subjectPresent).length;
    const actionHits = scores.filter((s) => s.actionPresent).length;
    const subjectScore = subjectHits / total;
    const actionScore = actionHits / total;
    const notes = scores.map((s) => s.note).filter(Boolean).slice(0, 3).join(' | ');
    return {
        sceneIdx,
        sampledFrames: scores.length,
        subjectScore,
        actionScore,
        subjectPresent: subjectScore >= threshold,
        actionPresent: actionScore >= threshold,
        possibleMismatch: subjectScore < threshold || actionScore < threshold,
        note: notes.slice(0, 400),
    };
}

/**
 * Entry point: given a project id and a sampled frame extractor (deps.extractFrames -> PNG buffers
 * per scene), score every scene and persist the result. Safe to run outside the render pipeline.
 */
export async function runVisualQa({ projectId, deps = {} } = {}) {
    if (!visualQaEnabled()) return { ran: false, reason: 'disabled' };
    const project = await EditProject.findById(projectId);
    if (!project) return { ran: false, reason: 'no_project' };
    const scenes = project.storyboard?.final?.scenes ?? [];
    if (!scenes.length) return { ran: false, reason: 'no_scenes' };
    const extractFrames = deps.extractFrames;
    if (typeof extractFrames !== 'function') return { ran: false, reason: 'no_extractor' };

    const sampled = scenes.slice(0, MAX_SCENES_SAMPLED);
    const sceneResults = [];
    for (let k = 0; k < sampled.length; k += 1) {
        const sc = sampled[k];
        const subject = String(sc.subject ?? '').trim();
        const action = String(sc.action ?? '').trim();
        if (!subject) continue;
        let frames = [];
        try {
            frames = await extractFrames({ sceneIdx: k, framesPerScene: FRAMES_PER_SCENE });
        } catch (_err) {
            frames = [];
        }
        const scored = [];
        for (const pngBuffer of frames.slice(0, FRAMES_PER_SCENE)) {
            scored.push(await scoreFrame({ pngBuffer, subject, action }, deps));
        }
        sceneResults.push(aggregateScene({ sceneIdx: k, scoredFrames: scored }));
    }

    const overallScore = sceneResults.length
        ? sceneResults.reduce((s, r) => s + (r.subjectScore + r.actionScore) / 2, 0) / sceneResults.length
        : 0;

    project.storyboard = {
        ...(project.storyboard ?? {}),
        visualQa: {
            id: crypto.randomUUID(),
            ranAt: new Date(),
            overallScore,
            scenes: sceneResults,
        },
    };
    project.markModified('storyboard');
    await project.save();
    return { ran: true, overallScore, scenes: sceneResults };
}

/**
 * Schedule visual QA after a render completes. Fire-and-forget; never throws into the render poller.
 * `deps.extractFrames` must be provided by the caller (FFmpeg sampler over the finished MP4).
 */
export function scheduleVisualQa({ projectId, deps = {} } = {}) {
    if (!visualQaEnabled()) return { scheduled: false, reason: 'disabled' };
    setImmediate(() => {
        runVisualQa({ projectId, deps }).catch((err) => {
            console.error(`[Editor] visual QA failed for ${projectId}:`, err?.message ?? err);
        });
    });
    return { scheduled: true, reason: 'queued' };
}

/** Surface VQA on the project detail view. */
export function visualQaForDetail(storyboard) {
    const qa = storyboard?.visualQa;
    if (!qa) return null;
    return {
        ranAt: qa.ranAt ?? null,
        overallScore: qa.overallScore ?? 0,
        scenes: qa.scenes ?? [],
    };
}
