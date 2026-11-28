/**
 * Replicate / Flux image provider for story-first subject imagery. Uses Replicate's prediction API
 * polling flow (create → poll until succeeded → download image bytes).
 *
 * Requires REPLICATE_API_TOKEN to be set. If it is missing, this module returns null from the
 * factory and the caller (image-provider.js getImageProvider) silently falls back to no generation.
 *
 * Tiers:
 *   dev  — `black-forest-labs/flux-dev`   (~$0.003/image, 6–20s latency)
 *   pro  — `black-forest-labs/flux-pro`   (~$0.055/image, 15–45s latency)
 */

import { DEFAULT_SIZE, DEFAULT_TIMEOUT_MS, NEGATIVE_PROMPT } from './image-provider.js';

const MODELS = Object.freeze({
    dev: 'black-forest-labs/flux-dev',
    pro: 'black-forest-labs/flux-pro',
});

/** Build the provider, or return null when its config is incomplete (never throws). */
export function replicateFluxProvider({ tier = 'dev' } = {}) {
    const token = process.env.REPLICATE_API_TOKEN;
    if (!token) return null;
    const model = MODELS[tier] ?? MODELS.dev;
    return {
        id: `replicate-flux-${tier}@${model}`,
        async generate({ prompt, negativePrompt = NEGATIVE_PROMPT, seed, width = DEFAULT_SIZE, height = DEFAULT_SIZE, timeoutMs = DEFAULT_TIMEOUT_MS }) {
            const input = {
                prompt,
                negative_prompt: negativePrompt,
                width,
                height,
                num_outputs: 1,
                guidance: 3.5,
                num_inference_steps: tier === 'pro' ? 40 : 28,
                output_format: 'png',
                output_quality: 95,
                ...(seed != null ? { seed } : {}),
            };
            const createRes = await fetch('https://api.replicate.com/v1/predictions', {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json',
                    prefer: 'wait=15',
                },
                body: JSON.stringify({
                    // Flux models on Replicate accept `model` (owner/name) for the latest version.
                    model,
                    input,
                }),
            });
            if (!createRes.ok) throw new Error(`Replicate create HTTP ${createRes.status}`);
            let prediction = await createRes.json();

            const started = Date.now();
            while (prediction.status === 'starting' || prediction.status === 'processing') {
                if (Date.now() - started > timeoutMs) throw new Error('Replicate generation timed out');
                await new Promise((resolve) => setTimeout(resolve, 1500));
                const url = prediction?.urls?.get;
                if (!url) break;
                const poll = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
                if (!poll.ok) throw new Error(`Replicate poll HTTP ${poll.status}`);
                prediction = await poll.json();
            }
            if (prediction.status !== 'succeeded') {
                throw new Error(`Replicate prediction failed: ${prediction.status} ${prediction.error ?? ''}`);
            }
            const outputs = Array.isArray(prediction.output) ? prediction.output : prediction.output ? [prediction.output] : [];
            const imageUrl = outputs[0];
            if (!imageUrl) throw new Error('Replicate prediction returned no output image');
            const imgRes = await fetch(imageUrl);
            if (!imgRes.ok) throw new Error(`Replicate image download HTTP ${imgRes.status}`);
            const arr = await imgRes.arrayBuffer();
            return Buffer.from(arr);
        },
    };
}
