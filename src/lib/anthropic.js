import Anthropic from '@anthropic-ai/sdk';
import { anthropicUsage, recordGeneration } from './ai-tracking.js';

/**
 * Claude client for the Editor tab (the rest of the app uses OpenAI). One helper: a streamed,
 * schema-constrained JSON request with adaptive thinking, server-side refusal fallback, tracking on
 * /admin/ai and PostHog, and clear errors for refusals and truncation.
 */

export const EDITOR_MODEL = process.env.EDITOR_MODEL || 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export const isClaudeConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client = null;
const getClient = () => {
    if (!client) client = new Anthropic({ maxRetries: 2, timeout: 10 * 60 * 1000 });
    return client;
};

export class ClaudeError extends Error {
    constructor(message, { kind, stopReason, category } = {}) {
        super(message);
        this.name = 'ClaudeError';
        this.kind = kind;
        this.stopReason = stopReason;
        this.category = category ?? null;
    }
}

/** Images are replaced by a marker so base64 never lands in the AI review log. */
const loggableMessages = (system, messages) => [
    { role: 'system', content: Array.isArray(system) ? system.map((b) => b.text ?? '').join('\n\n') : String(system ?? '') },
    ...messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string'
            ? m.content
            : m.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n'),
    })),
];

let override = null;
/** Tests: replace the network call with `fn(params) => message`. Pass null to restore. */
export const setClaudeForTests = (fn) => {
    override = fn;
};

/**
 * @param {object} args
 * @param {string} args.label tracking label (snake_case)
 * @param {Array|string} args.system system prompt (blocks may carry cache_control)
 * @param {Array} args.messages Anthropic MessageParam[]
 * @param {object} args.schema JSON schema for the reply (strict)
 * @param {'low'|'medium'|'high'|'xhigh'|'max'} [args.effort]
 * @param {number} [args.maxTokens]
 * @returns {Promise<{data:object, message:object, generationId:string|null, model:string}>}
 */
export async function requestClaudeJson({ label, system, messages, schema, effort = 'high', maxTokens = 32000, model = EDITOR_MODEL }) {
    const params = {
        model,
        max_tokens: maxTokens,
        thinking: { type: 'adaptive' },
        output_config: { effort, format: { type: 'json_schema', schema } },
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
        system,
        messages,
    };
    const started = Date.now();
    const logInput = loggableMessages(system, messages);
    let message;
    try {
        message = override ? await override(params) : await getClient().beta.messages.stream(params).finalMessage();
    } catch (error) {
        recordGeneration({ provider: 'anthropic', model, label, input: logInput, latencyMs: Date.now() - started, error, httpStatus: error?.status, params: { maxTokens, reasoningEffort: effort } });
        throw error;
    }

    const text = (message.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const servedBy = message.model || model;
    const fellBack = (message.usage?.iterations ?? []).some((it) => it.type === 'fallback_message');
    let problem = null;
    if (message.stop_reason === 'refusal') problem = new ClaudeError('Claude declined this request', { kind: 'refusal', stopReason: 'refusal', category: message.stop_details?.category });
    else if (message.stop_reason === 'max_tokens') problem = new ClaudeError('The edit plan was cut off before it finished', { kind: 'truncated', stopReason: 'max_tokens' });

    const generationId = recordGeneration({
        provider: 'anthropic',
        model: servedBy,
        label,
        input: logInput,
        output: text,
        usage: anthropicUsage(message.usage),
        latencyMs: Date.now() - started,
        stopReason: message.stop_reason,
        error: problem || undefined,
        params: { maxTokens, reasoningEffort: effort },
        properties: { anthropic_message_id: message.id ?? null, fallback_used: fellBack },
    });
    if (problem) throw problem;

    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new ClaudeError('Claude returned text that is not valid JSON', { kind: 'invalid_json', stopReason: message.stop_reason });
    }
    return { data, message, generationId, model: servedBy };
}
