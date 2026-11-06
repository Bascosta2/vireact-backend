/**
 * Every AI model the backend uses, one setting per role. Change a model with an environment variable
 * (Railway) instead of a code edit. Defaults chosen 2026-11-06 after OpenAI announced the shutdown of
 * gpt-4o / gpt-4o-mini on 2027-01-14 (developers.openai.com/api/docs/deprecations).
 *
 *   role        default          env override                     used for
 *   structured  gpt-6-luna       AI_MODEL_STRUCTURED              analyzers, scene/tag/KB jobs, hook rewriter
 *   writer      gpt-6.1-terra    AI_MODEL_WRITER                  chat replies, Scripts tab
 *   classifier  gpt-6-luna       AI_MODEL_CLASSIFIER              chat intent
 *   embedding   text-embedding-3-large  AI_MODEL_EMBEDDING        knowledge-base search (changing it means re-embedding)
 *   video       pegasus1.6       AI_MODEL_VIDEO                   Twelve Labs scene breakdown + transcript
 *
 * Reasoning effort per role: AI_REASONING_STRUCTURED / AI_REASONING_WRITER / AI_REASONING_CLASSIFIER
 * (none | low | medium | high). Read lazily so values loaded by load-env.js are always seen.
 */

const read = (key, fallback) => {
    const value = process.env[key];
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
};

const ROLE_DEFAULTS = {
    structured: { modelEnv: 'AI_MODEL_STRUCTURED', model: 'gpt-6-luna', effortEnv: 'AI_REASONING_STRUCTURED', effort: 'low' },
    writer: { modelEnv: 'AI_MODEL_WRITER', model: 'gpt-6.1-terra', effortEnv: 'AI_REASONING_WRITER', effort: 'low' },
    classifier: { modelEnv: 'AI_MODEL_CLASSIFIER', model: 'gpt-6-luna', effortEnv: 'AI_REASONING_CLASSIFIER', effort: 'none' },
};

export const AI_ROLES = Object.freeze(Object.keys(ROLE_DEFAULTS));

/** @returns {{ model: string, reasoningEffort: string }} */
export const modelForRole = (role = 'structured') => {
    const preset = ROLE_DEFAULTS[role] ?? ROLE_DEFAULTS.structured;
    return { model: read(preset.modelEnv, preset.model), reasoningEffort: read(preset.effortEnv, preset.effort) };
};

export const embeddingModel = () => read('AI_MODEL_EMBEDDING', 'text-embedding-3-large');
export const videoModel = () => read('AI_MODEL_VIDEO', 'pegasus1.6');

/**
 * GPT-5/GPT-6 and o-series are reasoning models: they reject `max_tokens` (400 "Use max_completion_tokens")
 * and count hidden reasoning tokens inside `max_completion_tokens`. Verified against the live API 2026-11-06.
 */
const REASONING_FAMILY = /^(gpt-5|gpt-6|o\d)/i;
export const isReasoningModel = (model) => REASONING_FAMILY.test(String(model || ''));

/** Extra completion budget so reasoning tokens never truncate the visible answer. */
const REASONING_HEADROOM = { none: 0, minimal: 500, low: 1500, medium: 4000, high: 8000, xhigh: 16000, max: 16000 };

/**
 * Build model-specific parameters for chat.completions.create.
 *
 * @param {object} options
 * @param {string} [options.role] structured | writer | classifier
 * @param {string} [options.model] explicit override (rarely needed)
 * @param {string} [options.reasoningEffort] override the role's effort
 * @param {number} [options.temperature] honoured for classic models, and for reasoning models at effort "none"
 * @param {number} options.maxTokens visible-output budget
 */
export const buildCompletionParams = ({ role = 'structured', model, reasoningEffort, temperature, maxTokens }) => {
    const preset = modelForRole(role);
    const chosen = model || preset.model;

    if (!isReasoningModel(chosen)) {
        const params = { model: chosen, max_tokens: maxTokens };
        if (temperature != null) params.temperature = temperature;
        return params;
    }

    const effort = reasoningEffort || preset.reasoningEffort || 'low';
    const params = {
        model: chosen,
        reasoning_effort: effort,
        max_completion_tokens: maxTokens + (REASONING_HEADROOM[effort] ?? REASONING_HEADROOM.low),
    };
    // Reasoning models only take a custom temperature when they are not reasoning.
    if (effort === 'none' && temperature != null) params.temperature = temperature;
    return params;
};
