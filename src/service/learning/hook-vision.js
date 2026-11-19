/**
 * The hook in pictures: one image of three frames (0.5 s, 1.5 s, 2.5 s) described by a small vision model,
 * from closed lists only, so the answers become numbers the model can learn from
 * (docs/learning-engine/PLAN.md, section 15.1 item 5). Never throws: a missing description only loses
 * these features.
 */
import fsp from 'node:fs/promises';

export const HOOK_VISUALS = Object.freeze([
    'face_to_camera', 'person_doing_action', 'product_closeup', 'food_closeup', 'animal', 'text_card', 'before_after',
    'reveal_or_result', 'screen_recording', 'scenery', 'vehicle', 'crowd_or_event', 'other',
]);
const FRAMINGS = ['close_up', 'medium', 'wide', 'none'];
const FACE_SIZES = ['none', 'small', 'medium', 'large'];
const FACE_SHARE = { none: 0, small: 0.1, medium: 0.3, large: 0.6 };

export const hookVisionSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['faceSize', 'people', 'framing', 'textOverlay', 'textWords', 'visual', 'changesAcrossFrames', 'eyeContact'],
    properties: {
        faceSize: { type: 'string', enum: FACE_SIZES, description: 'Largest human face, share of the frame: small <10%, medium 10-30%, large >30%.' },
        people: { type: 'integer', description: 'People visible in the first frame (0-10).' },
        framing: { type: 'string', enum: FRAMINGS },
        textOverlay: { type: 'boolean', description: 'Any added text on screen (captions, titles), not text that is part of the scene.' },
        textWords: { type: 'integer', description: 'Words of added on-screen text in the first frame (0 if none).' },
        visual: { type: 'string', enum: [...HOOK_VISUALS], description: 'What the opening shows.' },
        changesAcrossFrames: { type: 'string', enum: ['same_shot', 'small_change', 'new_scene'], description: 'How much the three frames differ.' },
        eyeContact: { type: 'boolean', description: 'A person looks into the camera.' },
    },
};

/** Model answer -> features (numbers and categories). */
export const hookFeatures = (a) => {
    if (!a || !FACE_SIZES.includes(a.faceSize)) return {};
    const clampInt = (x, max) => (Number.isFinite(Number(x)) ? Math.max(0, Math.min(max, Math.round(Number(x)))) : null);
    return {
        hookFaceShare: FACE_SHARE[a.faceSize],
        hookPeople: clampInt(a.people, 10),
        hookCloseUp: a.framing === 'close_up',
        hookTextOverlay: Boolean(a.textOverlay),
        hookTextWords: clampInt(a.textWords, 60),
        hookEyeContact: Boolean(a.eyeContact),
        hookSceneChange: a.changesAcrossFrames === 'new_scene' ? 2 : a.changesAcrossFrames === 'small_change' ? 1 : 0,
        hookVisual: HOOK_VISUALS.includes(a.visual) ? a.visual : 'other',
    };
};

/** Describes the hook image. Returns { answer, features } or null. */
export const describeHook = async (imagePath, { complete } = {}) => {
    if (!imagePath) return null;
    try {
        const run = complete ?? (await import('../openai-response.service.js')).requestStructuredCompletion;
        const b64 = (await fsp.readFile(imagePath)).toString('base64');
        const answer = await run({
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'These are three frames from the first 3 seconds of a short-form video (left to right: 0.5 s, 1.5 s, 2.5 s). Describe the opening using only the allowed values.' },
                    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}`, detail: 'low' } },
                ],
            }],
            schemaName: 'hook_frames',
            label: 'learning_hook_vision',
            jsonSchema: hookVisionSchema,
            systemPrompt: 'You describe video frames factually from closed lists. Return structured data only.',
            role: 'classifier',
            temperature: 0,
            maxTokens: 400,
        });
        return { answer, features: hookFeatures(answer) };
    } catch {
        return null;
    }
};
