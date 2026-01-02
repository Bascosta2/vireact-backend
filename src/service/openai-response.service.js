import openai from "../lib/openai.js";

const DEFAULT_SYSTEM_PROMPT =
    "You are a concise video analytics assistant. Respond in plain text, without markdown, asterisk or emojis. Keep answers focused, neutral, and under 160 words unless otherwise specified.";

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

    const response = await openai.chat.completions.create({
        model,
        messages: finalMessages,
        temperature,
        max_tokens: maxTokens,
    });

    return response?.choices?.[0]?.message?.content || "";
};

