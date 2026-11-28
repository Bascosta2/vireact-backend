/**
 * Scoped storyboard scene regenerate (Step 4 companion): rewrite ONE scene of a confirmed
 * storyboard from a creator note, then rebuild the whole edit plan so captions/graphics stay in sync.
 * Never touches other scenes' narration. Shipped behind the same auth as other editor routes.
 */

import { requestClaudeJson } from '../../lib/anthropic.js';
import { VISUAL_NAMES, VISUALS } from './edl.js';
import { buildStoryboardEdit, normalizeOption } from './storyboard.service.js';
import { skillFor } from './skills.js';

const SCENE_SCHEMA = {
    type: 'object',
    properties: {
        narration: { type: 'string' },
        subject: { type: 'string' },
        action: { type: 'string' },
        backdrop: { type: 'string' },
        emphasis: { type: 'string' },
        graphicType: { type: 'string' },
        graphicText: { type: 'string' },
        graphicSubtext: { type: 'string' },
        graphicItems: { type: 'string' },
    },
    required: ['narration', 'subject', 'action', 'backdrop', 'emphasis', 'graphicType', 'graphicText', 'graphicSubtext', 'graphicItems'],
    additionalProperties: false,
};

/**
 * Ask Claude to rewrite one scene. Returns the raw scene object (not yet normalized).
 */
export async function rewriteScene({ option, sceneIdx, note, styleId }, deps = {}) {
    const request = deps.request ?? requestClaudeJson;
    const style = skillFor(styleId);
    const scene = option.scenes[sceneIdx];
    if (!scene) throw new Error(`Scene ${sceneIdx} does not exist`);
    const subjects = (option.subjects ?? []).map((s) => `- ${s.name} (${s.role}): ${s.description}`).join('\n');
    const { data } = await request({
        label: 'storyboard_scene_rewrite',
        system: [
            'You rewrite ONE scene of an animated storyboard. Keep the story coherent with the surrounding scenes.',
            `Style: ${style?.name ?? styleId}.`,
            'Return ONLY the JSON schema for the rewritten scene.',
            'Pick graphicType from: none, headline, list, counter, chart, visual, slam, pill, cta.',
            'When graphicType is visual, graphicItems must be ONE of these illustration names:',
            ...VISUAL_NAMES.slice(0, 80).map((n) => `- ${n}: ${VISUALS[n].about}`),
            'Keep narration under 220 characters. subject must match a name from the registry when possible.',
        ].join('\n'),
        messages: [{
            role: 'user',
            content: [
                `CREATOR NOTE: ${note}`,
                `SUBJECTS REGISTRY:\n${subjects || '(none)'}`,
                `SCENE INDEX: ${sceneIdx}`,
                `CURRENT SCENE:\n${JSON.stringify(scene, null, 2)}`,
                `PREVIOUS SCENE:\n${JSON.stringify(option.scenes[sceneIdx - 1] ?? null)}`,
                `NEXT SCENE:\n${JSON.stringify(option.scenes[sceneIdx + 1] ?? null)}`,
                'Rewrite ONLY this scene so it follows the note.',
            ].join('\n\n'),
        }],
        schema: SCENE_SCHEMA,
        effort: 'medium',
        maxTokens: 2000,
    });
    return data;
}

/**
 * Apply a rewritten scene onto the project's storyboard option, rebuild the plan, and return the
 * patches the controller should persist. Pure except for the Claude call.
 */
export async function regenerateStoryboardScene({ project, sceneIdx, note }, deps = {}) {
    const final = project.storyboard?.final;
    if (!final?.scenes?.length) throw new Error('No confirmed storyboard');
    if (!Number.isInteger(sceneIdx) || sceneIdx < 0 || sceneIdx >= final.scenes.length) {
        throw new Error('Scene index out of range');
    }
    const raw = await rewriteScene({
        option: final,
        sceneIdx,
        note,
        styleId: project.skill,
    }, deps);

    // Rebuild a full option through normalizeOption so graphic/visual/subject rules stay consistent.
    const patchedScenes = final.scenes.map((sc, k) => (k === sceneIdx
        ? {
            narration: raw.narration,
            subject: raw.subject,
            action: raw.action,
            backdrop: raw.backdrop,
            emphasis: raw.emphasis,
            graphicType: raw.graphicType,
            graphicText: raw.graphicText,
            graphicSubtext: raw.graphicSubtext,
            graphicItems: raw.graphicItems,
        }
        : {
            narration: sc.narration,
            subject: sc.subject,
            action: sc.action,
            backdrop: sc.backdrop,
            emphasis: (sc.emphasis ?? []).join(' | '),
            graphicType: sc.graphic?.type ?? 'none',
            graphicText: sc.graphic?.text ?? '',
            graphicSubtext: sc.graphic?.subtext ?? '',
            graphicItems: sc.graphic?.type === 'visual' ? (sc.graphic.visual ?? '') : (sc.graphic?.items ?? []).join(' | '),
        }));

    const option = normalizeOption({
        title: final.title,
        logline: final.logline,
        angle: final.angle,
        mood: final.mood,
        musicTrackId: final.musicTrackId,
        subjects: final.subjects ?? project.storyboard?.subjects ?? [],
        scenes: patchedScenes,
    }, project.skill);

    const trackIds = new Set([final.musicTrackId].filter(Boolean));
    const built = buildStoryboardEdit(option, { trackIds });
    return { option, built };
}
