import openai from "../lib/openai.js";

const DEFAULT_SYSTEM_PROMPT =
    "You are a concise video analytics assistant. Respond in plain text, without markdown, asterisk or emojis. Keep answers focused, neutral, and under 160 words unless otherwise specified.";
const MAX_MESSAGE_CONTENT_CHARS = 12000;

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

