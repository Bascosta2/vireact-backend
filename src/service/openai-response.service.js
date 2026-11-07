import openai from "../lib/openai.js";
import { buildCompletionParams } from "../config/ai-models.js";
import { recordGeneration, openAiUsage } from "../lib/ai-tracking.js";

const DEFAULT_SYSTEM_PROMPT =
    "You are a concise video analytics assistant. Respond in plain text, without markdown, asterisk or emojis. Keep answers focused, neutral, and under 160 words unless otherwise specified.";
const MAX_MESSAGE_CONTENT_CHARS = 12000;

/** Structured-output prompts carry transcript + scenes + RAG, so they need more room. */
const MAX_STRUCTURED_CONTENT_CHARS = 60000;

/**
 * One Chat Completions call, recorded for AI observability (PostHog + admin "AI responses").
 * `check(response)` returns an error message when the response is unusable (refusal, truncation, ...);
 * that is recorded as an error but not thrown here, so callers keep their own error handling.
 */
const createTrackedCompletion = async ({ label, body, reasoningEffort, check }) => {
    const started = Date.now();
    const params = { temperature: body.temperature, maxTokens: body.max_completion_tokens ?? body.max_tokens, reasoningEffort };
    let response;
    try {
        response = await openai.chat.completions.create(body);
    } catch (error) {
        recordGeneration({ provider: "openai", model: body.model, label, input: body.messages, latencyMs: Date.now() - started, error, params });
        throw error;
    }
    const choice = response?.choices?.[0];
    const problem = check ? check(response) : null;
    recordGeneration({
        provider: "openai",
        model: response?.model || body.model,
        label,
        input: body.messages,
        output: choice?.message?.content ?? choice?.message?.refusal ?? "",
        usage: openAiUsage(response?.usage),
        latencyMs: Date.now() - started,
        stopReason: choice?.finish_reason,
        error: problem || undefined,
        params,
        properties: response?.id ? { openai_response_id: response.id } : undefined,
    });
    return response;
};

const structuredProblem = (schemaName) => (response) => {
    const choice = response?.choices?.[0];
    if (choice?.message?.refusal) return `Model refused structured request (${schemaName}): ${choice.message.refusal}`;
    if (choice?.finish_reason === "length") return `Structured response for ${schemaName} was truncated; raise maxTokens.`;
    if (!choice?.message?.content) return `Empty structured response for ${schemaName}`;
    try { JSON.parse(choice.message.content); } catch (error) { return `Unparseable structured response for ${schemaName}: ${error.message}`; }
    return null;
};

/**
 * Models come from src/config/ai-models.js by role ("structured", "writer", "classifier").
 * Pass `model` only to override a role for one call. `label` names the call in AI analytics.
 */
export const requestChatCompletion = async ({
    messages,
    label = "chat_completion",
    role = "structured",
    model,
    reasoningEffort,
    temperature = 0.3,
    maxTokens = 500,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
} = {}) => {
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error("messages are required to request a chat completion");
    }

    const finalMessages = systemPrompt
        ? [{ role: "system", content: systemPrompt }, ...messages]
        : messages;
    const safeMessages = finalMessages.map((message) => ({
        ...message,
        content:
            typeof message.content === "string" && message.content.length > MAX_MESSAGE_CONTENT_CHARS
                ? message.content.slice(0, MAX_MESSAGE_CONTENT_CHARS)
                : message.content
    }));

    const params = buildCompletionParams({ role, model, reasoningEffort, temperature, maxTokens });
    const response = await createTrackedCompletion({
        label,
        reasoningEffort: params.reasoning_effort,
        body: { ...params, messages: safeMessages },
        check: (res) => (res?.choices?.[0]?.message?.content ? null : "Empty response"),
    });

    return response?.choices?.[0]?.message?.content || "";
};

/**
 * Structured-output completion. Constrains the model to `jsonSchema` via strict
 * `json_schema` mode so malformed or shapeless output fails at the API boundary
 * instead of being regex-scraped afterwards.
 *
 * Strict mode requires every property to be listed in `required` and
 * `additionalProperties: false` on every object — see `analyzer/feedback-schema.js`.
 *
 * @throws {Error} when the model refuses, returns empty content, or emits unparseable JSON.
 * @returns {Promise<object>} parsed object matching `jsonSchema`
 */
export const requestStructuredCompletion = async ({
    messages,
    schemaName,
    label,
    jsonSchema,
    role = "structured",
    model,
    reasoningEffort,
    temperature = 0.2,
    maxTokens = 3000,
    systemPrompt = DEFAULT_SYSTEM_PROMPT,
} = {}) => {
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error("messages are required to request a structured completion");
    }
    if (!schemaName || !jsonSchema) {
        throw new Error("schemaName and jsonSchema are required for structured output");
    }

    const finalMessages = systemPrompt
        ? [{ role: "system", content: systemPrompt }, ...messages]
        : messages;
    const safeMessages = finalMessages.map((message) => ({
        ...message,
        content:
            typeof message.content === "string" && message.content.length > MAX_STRUCTURED_CONTENT_CHARS
                ? message.content.slice(0, MAX_STRUCTURED_CONTENT_CHARS)
                : message.content
    }));

    const params = buildCompletionParams({ role, model, reasoningEffort, temperature, maxTokens });
    const response = await createTrackedCompletion({
        label: label || schemaName,
        reasoningEffort: params.reasoning_effort,
        check: structuredProblem(schemaName),
        body: {
            ...params,
            messages: safeMessages,
            response_format: {
                type: "json_schema",
                json_schema: { name: schemaName, schema: jsonSchema, strict: true },
            },
        },
    });

    const choice = response?.choices?.[0];
    if (choice?.message?.refusal) {
        throw new Error(`Model refused structured request (${schemaName}): ${choice.message.refusal}`);
    }
    if (choice?.finish_reason === "length") {
        throw new Error(`Structured response for ${schemaName} was truncated; raise maxTokens.`);
    }

    const content = choice?.message?.content;
    if (!content) {
        throw new Error(`Empty structured response for ${schemaName}`);
    }

    try {
        return JSON.parse(content);
    } catch (error) {
        throw new Error(`Unparseable structured response for ${schemaName}: ${error.message}`);
    }
};

