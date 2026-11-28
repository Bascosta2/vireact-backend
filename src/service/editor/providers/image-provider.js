/**
 * Image provider abstraction for story-first subject imagery (Step 3 of the story-first pipeline).
 *
 * Providers are selected at request time from EDITOR_GENIMG_PROVIDER so a swap is one env change.
 * None of the providers below are required to be present; if the selected provider cannot be
 * constructed (no API token, unknown name), getImageProvider() returns null and the orchestrator
 * (generative-images.service.js) silently skips generation and leaves the storyboard to fall back
 * to the Remotion SubjectDraw/Mascot path.
 *
 * Every provider exposes the same shape:
 *   {
 *     id: string,            // stable identifier baked into the cache hash so an upgrade invalidates
 *     generate({ prompt, negativePrompt, seed, width, height, timeoutMs }) → Promise<Buffer>
 *   }
 *
 * Buffers returned here are PNG/WebP bytes; the caller writes them to the storage layer (S3 via
 * editorKey) and persists only the key.
 */

import { replicateFluxProvider } from './replicate-flux.provider.js';

export const DEFAULT_SIZE = 1024;
export const DEFAULT_TIMEOUT_MS = 120_000;

/** Global on/off for generative subject imagery. Off by default. */
export const imageGenEnabled = () => String(process.env.EDITOR_GENIMG_ENABLED ?? '').toLowerCase() === 'true';

/** Reads the selected provider from the environment and returns an instance, or null. */
export function getImageProvider() {
    if (!imageGenEnabled()) return null;
    const name = String(process.env.EDITOR_GENIMG_PROVIDER ?? 'replicate-flux-dev').toLowerCase().trim();
    if (!name || name === 'none') return null;
    if (name.startsWith('replicate-flux')) {
        const tier = name === 'replicate-flux-pro' ? 'pro' : 'dev';
        return replicateFluxProvider({ tier });
    }
    return null;
}

/** Hard cap on daily provider spend (USD). The service refuses new jobs when this is hit. */
export const dailyBudgetUsd = () => {
    const raw = Number(process.env.EDITOR_GENIMG_BUDGET_USD_PER_DAY);
    return Number.isFinite(raw) && raw > 0 ? raw : 25;
};

/** Rough per-image cost used for the daily budget estimate (USD). */
export const ESTIMATED_COST_PER_IMAGE = Object.freeze({
    'replicate-flux-dev': 0.003,
    'replicate-flux-pro': 0.055,
});

export const estimatedCostForProvider = (providerId) => {
    const id = String(providerId ?? '');
    if (id.includes('flux-pro')) return ESTIMATED_COST_PER_IMAGE['replicate-flux-pro'];
    return ESTIMATED_COST_PER_IMAGE['replicate-flux-dev'];
};

/** Per-plan monthly quotas for generative subject images. */
export const PLAN_QUOTAS = Object.freeze({
    free: 0,
    premium: 0,
    pro: Number(process.env.EDITOR_GENIMG_QUOTA_PRO ?? 30) || 30,
    enterprise: Number(process.env.EDITOR_GENIMG_QUOTA_ENTERPRISE ?? 150) || 150,
});

/** Content moderation deny-list applied to the subject name + description before enqueueing. */
const DENY = /\b(nud(e|ity)|porn|sexual|gore|blood(y)?|weapon|gun|knife|kill|suicide|nazi|hate|slur|child abuse)\b/i;

/** True when the subject text is safe to send to the provider. */
export const subjectIsSafe = (subject) => {
    const txt = `${subject?.name ?? ''} ${subject?.description ?? ''}`;
    return !DENY.test(txt);
};

/**
 * Style-aware prompt. Each image describes ONE subject with the style's aesthetic language so the
 * generated image lives in the same look as the composition's atmosphere. The negative prompt stays
 * uniform across providers.
 */
export function buildImagePrompt(subject, style) {
    const styleName = style?.name ?? 'cinematic painted illustration';
    const styleLook = style?.look ?? '';
    return [
        `${subject.name}, ${subject.description}`,
        styleName ? `in the artistic style of ${styleName}${styleLook ? `: ${styleLook}` : ''}` : '',
        'centered subject, single character or object, no text, no captions, no watermarks',
        'transparent or neutral background',
        'vertical 9:16 crop friendly, subject fills about 60% of the frame',
    ].filter(Boolean).join('. ');
}

export const NEGATIVE_PROMPT = 'low quality, blurry, text, watermark, extra limbs, deformed, cropped, split frame, collage, photo of a screen, logo, signature';
