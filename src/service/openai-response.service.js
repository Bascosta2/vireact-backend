import openai from "../lib/openai.js";

const DEFAULT_SYSTEM_PROMPT =
    "You are a concise video analytics assistant. Respond in plain text, without markdown, asterisk or emojis. Keep answers focused, neutral, and under 160 words unless otherwise specified.";
const MAX_MESSAGE_CONTENT_CHARS = 12000;

/** Structured-output prompts carry transcript + scenes + RAG, so they need more room. */
const MAX_STRUCTURED_CONTENT_CHARS = 60000;

/** Strict `json_schema` requires a structured-outputs capable model. */
const STRUCTURED_OUTPUT_MODEL = "gpt-4o-mini";

export const requestChatCompletion = async ({
    messages,
    model = "gpt-4o-mini",
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

    const response = await openai.chat.completions.create({
        model,
        messages: safeMessages,
        temperature,
        max_tokens: maxTokens,
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
    jsonSchema,
    model = STRUCTURED_OUTPUT_MODEL,
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

    const response = await openai.chat.completions.create({
        model,
        messages: safeMessages,
        temperature,
        max_tokens: maxTokens,
        response_format: {
            type: "json_schema",
            json_schema: { name: schemaName, schema: jsonSchema, strict: true },
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

