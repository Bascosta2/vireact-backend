/**
 * AI observability: every model call is sent to PostHog LLM analytics ($ai_generation) and stored in
 * Mongo (AiResponse) for the admin "AI responses" page.
 *
 * Who/what a call belongs to (user, video, chat, trace) comes from withAiContext(), set once at each
 * feature's entry point, so the helpers that call the models don't need ids passed through.
 *
 * Env:
 *   POSTHOG_KEY               PostHog project token (already used by lib/analytics.js). Unset: nothing is sent.
 *   POSTHOG_AI_PRIVACY_MODE   "true": prompts and outputs are not sent to PostHog (tokens/cost/latency still are).
 *   AI_RESPONSE_STORE         "false": don't store calls in Mongo.
 *   AI_MODEL_PRICES           Optional JSON, USD per 1M tokens: {"gpt-6-luna":{"input":0.2,"output":1.6,"cachedInput":0.02}}.
 *                             When unset PostHog still computes cost for models it knows.
 *
 * Never throws: tracking must not break the request that made the call.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { captureServerEvent } from './analytics.js';
import { AiResponse } from '../model/ai-response.model.js';

export const SYSTEM_DISTINCT_ID = 'system:vireact';

/** Per message, in what we store and send. Structured prompts are capped at 60k chars upstream anyway. */
const MAX_CONTENT_CHARS = 60000;
const MAX_OUTPUT_CHARS = 60000;
const PREVIEW_CHARS = 280;

const storage = new AsyncLocalStorage();

const compact = (obj) => Object.fromEntries(Object.entries(obj || {}).filter(([, v]) => v !== undefined && v !== null && v !== ''));
const idString = (value) => (value === undefined || value === null || value === '' ? undefined : String(value));

/**
 * Run `fn` with tracking context. Nested calls inherit and override the parent's fields.
 * Fields: distinctId, traceId, sessionId, feature, userId, videoId, chatId, attempt.
 */
export const withAiContext = (context, fn) => {
    const parent = storage.getStore() || {};
    const next = { ...parent, ...compact({
        ...context,
        userId: idString(context?.userId),
        videoId: idString(context?.videoId),
        chatId: idString(context?.chatId),
        distinctId: idString(context?.distinctId),
    }) };
    next.lastGenerationId = null;
    return storage.run(next, fn);
};

export const getAiContext = () => storage.getStore() || {};

/** Id of the last generation recorded in the current context (for marking validation results). */
export const lastGenerationId = () => storage.getStore()?.lastGenerationId || null;

/** A trace id for one unit of work, e.g. `video-<id>-<ts>`. PostHog allows letters, digits, - _ . : etc. */
export const newTraceId = (prefix = 'trace') => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

const isTestRun = () => Boolean(process.env.NODE_TEST_CONTEXT) || process.env.NODE_ENV === 'test';

let captureOverride = null;
/** Tests only: receive PostHog events instead of sending them. Pass null to restore. */
export const setAiCaptureForTests = (fn) => { captureOverride = fn; };

/** Send to PostHog (no-op without POSTHOG_KEY, and never from a test run unless a test listens). */
const sendEvent = (distinctId, event, properties) => {
    if (captureOverride) return captureOverride(distinctId, event, properties);
    if (isTestRun()) return false;
    return captureServerEvent(distinctId, event, properties);
};
const privacyMode = () => String(process.env.POSTHOG_AI_PRIVACY_MODE || '').toLowerCase() === 'true';
const storeEnabled = () => String(process.env.AI_RESPONSE_STORE || '').toLowerCase() !== 'false';

let cachedPrices = { raw: undefined, table: {} };
const priceTable = () => {
    const raw = process.env.AI_MODEL_PRICES;
    if (raw !== cachedPrices.raw) {
        let table = {};
        try { table = raw ? JSON.parse(raw) : {}; } catch { console.warn('[AI tracking] AI_MODEL_PRICES is not valid JSON; ignoring it'); }
        cachedPrices = { raw, table: table && typeof table === 'object' ? table : {} };
    }
    return cachedPrices.table;
};

/** USD cost from AI_MODEL_PRICES (per 1M tokens), or null when the model has no price there. */
export const computeCost = (model, { inputTokens, outputTokens, cachedInputTokens } = {}) => {
    const price = priceTable()[model];
    if (!price || !Number.isFinite(Number(price.input)) || !Number.isFinite(Number(price.output))) return null;
    const cached = Math.max(0, Number(cachedInputTokens) || 0);
    const uncached = Math.max(0, (Number(inputTokens) || 0) - cached);
    const cachedPrice = Number.isFinite(Number(price.cachedInput)) ? Number(price.cachedInput) : Number(price.input);
    const input = (uncached * Number(price.input) + cached * cachedPrice) / 1e6;
    const output = ((Number(outputTokens) || 0) * Number(price.output)) / 1e6;
    return { input, output, total: input + output };
};

const clipText = (value, max) => {
    if (typeof value !== 'string') return value;
    return value.length > max ? `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]` : value;
};

const normalizeMessages = (input) => {
    const list = Array.isArray(input) ? input : input == null ? [] : [{ role: 'user', content: input }];
    return list.map((m) => ({
        role: String(m?.role || 'user'),
        content: typeof m?.content === 'string' ? clipText(m.content, MAX_CONTENT_CHARS) : m?.content ?? '',
    }));
};

const numberOrNull = (value) => (Number.isFinite(Number(value)) && value !== null && value !== undefined ? Number(value) : null);

/** Inserts still in flight, so a validation mark can wait for its row. */
const pendingInserts = new Map();

/**
 * Record one model call. Returns its id right away; PostHog capture and the Mongo insert happen in
 * the background.
 *
 * @param {object} call
 * @param {'openai'|'twelvelabs'} call.provider
 * @param {string} call.model
 * @param {string} call.label what the call does (schema name or a short snake_case label)
 * @param {Array<{role:string, content:any}>|string} call.input
 * @param {string} [call.output]
 * @param {{inputTokens?:number, outputTokens?:number, cachedInputTokens?:number, reasoningTokens?:number}} [call.usage]
 * @param {number} call.latencyMs
 * @param {string} [call.stopReason]
 * @param {Error|string} [call.error]
 * @param {number} [call.httpStatus]
 * @param {{temperature?:number, maxTokens?:number, reasoningEffort?:string}} [call.params]
 * @param {object[]} [call.tools]
 * @param {string} [call.baseUrl]
 * @param {object} [call.properties] extra PostHog properties
 * @returns {string|null}
 */
export const recordGeneration = (call) => {
    try {
        const store = storage.getStore();
        const ctx = store || {};
        const id = new mongoose.Types.ObjectId();
        if (store) store.lastGenerationId = String(id);

        const usage = call.usage || {};
        const inputTokens = numberOrNull(usage.inputTokens);
        const outputTokens = numberOrNull(usage.outputTokens);
        const cachedInputTokens = numberOrNull(usage.cachedInputTokens);
        const reasoningTokens = numberOrNull(usage.reasoningTokens);
        const cost = computeCost(call.model, { inputTokens, outputTokens, cachedInputTokens });
        const errorMessage = call.error ? String(call.error?.message || call.error).slice(0, 2000) : null;
        const httpStatus = numberOrNull(call.httpStatus ?? call.error?.status ?? call.error?.statusCode);
        const input = normalizeMessages(call.input);
        const output = clipText(typeof call.output === 'string' ? call.output : call.output == null ? '' : JSON.stringify(call.output), MAX_OUTPUT_CHARS);
        const traceId = ctx.traceId || newTraceId(ctx.feature || 'ai');
        const distinctId = ctx.distinctId || ctx.userId || SYSTEM_DISTINCT_ID;
        const label = String(call.label || 'generation').trim().replace(/\s+/g, '_');
        const params = call.params || {};

        {
            const hidden = privacyMode();
            sendEvent(distinctId, '$ai_generation', compact({
                $ai_trace_id: traceId,
                $ai_session_id: ctx.sessionId,
                $ai_span_id: String(id),
                $ai_span_name: label,
                $ai_model: call.model,
                $ai_provider: call.provider,
                $ai_input: hidden ? undefined : input,
                $ai_output_choices: hidden ? undefined : [{ role: 'assistant', content: output }],
                $ai_input_tokens: inputTokens,
                $ai_output_tokens: outputTokens,
                $ai_cache_read_input_tokens: cachedInputTokens,
                $ai_latency: Number.isFinite(call.latencyMs) ? call.latencyMs / 1000 : undefined,
                $ai_http_status: httpStatus ?? (errorMessage ? undefined : 200),
                $ai_is_error: Boolean(errorMessage),
                $ai_error: errorMessage,
                $ai_stop_reason: call.stopReason,
                $ai_temperature: params.temperature,
                $ai_max_tokens: params.maxTokens,
                $ai_base_url: call.baseUrl,
                $ai_tools: call.tools,
                $ai_input_cost_usd: cost?.input,
                $ai_output_cost_usd: cost?.output,
                $ai_total_cost_usd: cost?.total,
                // System work (no signed-in user) should not create person profiles.
                $process_person_profile: distinctId.startsWith('system:') ? false : undefined,
                feature: ctx.feature,
                video_id: ctx.videoId,
                chat_id: ctx.chatId,
                attempt: ctx.attempt,
                reasoning_effort: params.reasoningEffort,
                reasoning_tokens: reasoningTokens,
                ai_response_id: String(id),
                ...(call.properties || {}),
            }));
        }

        if (storeEnabled() && mongoose.connection.readyState === 1) {
            const insert = AiResponse.create({
                _id: id,
                provider: call.provider,
                model: call.model || '',
                label,
                feature: ctx.feature || 'other',
                traceId,
                sessionId: ctx.sessionId || null,
                distinctId,
                userId: ctx.userId || null,
                videoId: ctx.videoId || null,
                chatId: ctx.chatId || null,
                attempt: Number(ctx.attempt) || 1,
                input,
                output,
                outputPreview: (errorMessage && !output ? errorMessage : output).replace(/\s+/g, ' ').slice(0, PREVIEW_CHARS),
                inputTokens,
                outputTokens,
                cachedInputTokens,
                reasoningTokens,
                totalTokens: inputTokens !== null || outputTokens !== null ? (inputTokens || 0) + (outputTokens || 0) : null,
                costUsd: cost ? Number(cost.total.toFixed(6)) : null,
                latencyMs: Number.isFinite(call.latencyMs) ? Math.round(call.latencyMs) : null,
                stopReason: call.stopReason || null,
                isError: Boolean(errorMessage),
                error: errorMessage,
                params: {
                    temperature: numberOrNull(params.temperature),
                    maxTokens: numberOrNull(params.maxTokens),
                    reasoningEffort: params.reasoningEffort || null,
                },
            }).catch((error) => {
                console.warn(`[AI tracking] Could not store ${label} response: ${error.message}`);
            }).finally(() => pendingInserts.delete(String(id)));
            pendingInserts.set(String(id), insert);
        }
        return String(id);
    } catch (error) {
        console.warn(`[AI tracking] recordGeneration failed: ${error.message}`);
        return null;
    }
};

/**
 * Attach our quality-gate result to a stored generation, and tell PostHog so quality can be charted.
 * @param {string|null} id from recordGeneration / lastGenerationId()
 * @param {{ passed: boolean, issues?: string[] }} result
 */
export const markGenerationValidation = (id, { passed, issues = [] } = {}) => {
    if (!id) return;
    try {
        const ctx = getAiContext();
        {
            sendEvent(ctx.distinctId || ctx.userId || SYSTEM_DISTINCT_ID, 'ai_output_validated', compact({
                $ai_trace_id: ctx.traceId,
                ai_response_id: id,
                passed,
                issue_count: issues.length,
                feature: ctx.feature,
                attempt: ctx.attempt,
                $process_person_profile: (ctx.distinctId || ctx.userId) ? undefined : false,
            }));
        }
        if (mongoose.connection.readyState !== 1) return;
        Promise.resolve(pendingInserts.get(id))
            .then(() => AiResponse.updateOne(
                { _id: id },
                { $set: { 'validation.status': passed ? 'passed' : 'failed', 'validation.issues': issues.slice(0, 30).map((s) => String(s).slice(0, 300)) } }
            ))
            .catch((error) => console.warn(`[AI tracking] Could not mark validation: ${error.message}`));
    } catch (error) {
        console.warn(`[AI tracking] markGenerationValidation failed: ${error.message}`);
    }
};

/** Tokens only (PostHog $ai_embedding); embeddings are not stored for review. */
export const recordEmbedding = ({ model, inputTokens, latencyMs, label = 'embedding', error } = {}) => {
    try {
        const ctx = getAiContext();
        const distinctId = ctx.distinctId || ctx.userId || SYSTEM_DISTINCT_ID;
        const cost = computeCost(model, { inputTokens, outputTokens: 0 });
        sendEvent(distinctId, '$ai_embedding', compact({
            $ai_trace_id: ctx.traceId,
            $ai_span_name: label,
            $ai_model: model,
            $ai_provider: 'openai',
            $ai_input_tokens: numberOrNull(inputTokens),
            $ai_latency: Number.isFinite(latencyMs) ? latencyMs / 1000 : undefined,
            $ai_is_error: Boolean(error),
            $ai_error: error ? String(error?.message || error) : undefined,
            $ai_total_cost_usd: cost?.total,
            $process_person_profile: distinctId.startsWith('system:') ? false : undefined,
            feature: ctx.feature,
            video_id: ctx.videoId,
        }));
    } catch {
        /* never break the caller */
    }
};

/** Map an Anthropic Messages usage object to our fields (input counts include cache reads/writes). */
export const anthropicUsage = (usage) => ({
    inputTokens: (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0),
    outputTokens: usage?.output_tokens,
    cachedInputTokens: usage?.cache_read_input_tokens ?? 0,
});

/** Map an OpenAI Chat Completions / Responses usage object to our fields. */
export const openAiUsage = (usage) => ({
    inputTokens: usage?.prompt_tokens ?? usage?.input_tokens,
    outputTokens: usage?.completion_tokens ?? usage?.output_tokens,
    cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens,
});
