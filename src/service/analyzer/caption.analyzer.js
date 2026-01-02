import { requestChatCompletion } from "../openai-response.service.js";
import openai from "../../lib/openai.js";
import { KnowledgeBase } from "../../model/knowledge-base.model.js";
import { KNOWLEDGE_BASE_VECTOR_INDEX } from "../../config/index.js";

export const analyzeCaption = async (scenes) => {
    if (!scenes || scenes.length === 0) {
        throw new Error('Scenes are required for caption analysis');
    }

    // Extract all on-screen text from scenes
    const captions = scenes
        .map((scene, idx) => {
            const text = scene.onScreenText || '';
            if (!text || text.trim() === '') return null;
            return `Scene ${idx + 1} (${scene.startTime}s-${scene.endTime}s): ${text}`;
        })
        .filter(Boolean);

    if (captions.length === 0) {
        return "Rating: Weak\nReasoning: No on-screen text or captions detected in the video. Captions improve accessibility, engagement, and retention for short-form content.\nSuggestions:\n- Add on-screen text to highlight key points\n- Use captions for spoken dialogue to improve accessibility\n- Consider text overlays that sync with visual cues";
    }

    const captionsContext = captions.join('\n');

    const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-large",
        input: captionsContext
    });
    const captionEmbedding = embeddingResponse.data[0].embedding;

    const relevantData = await KnowledgeBase.aggregate([
        {
            $vectorSearch: {
                index: KNOWLEDGE_BASE_VECTOR_INDEX,
                queryVector: captionEmbedding,
                path: "embedding",
                filter: { "metadata.topic": "caption" },
                limit: 10,
                numCandidates: 100
            }
        }
    ]);

    const ragContext = relevantData.length > 0
        ? relevantData
            .map((c, i) => `${i + 1}. [${c.metadata.layer.toUpperCase()}] ${c.content}`)
            .join("\n")
        : 'No specific knowledge base documents found';

    const prompt = `
You are an expert psychological content reviewer trained on Bas's mindset and caption analysis principles. Bas has 1M+ subscribers on YouTube and has a 99.9% engagement rate.

BAS'S CAPTION INSIGHTS AND EXAMPLES:
${ragContext}


Analyze the on-screen text and captions in this short-form social media video.

CAPTIONS DETECTED:
${captionsContext}

TASK:
1. Rate the caption effectiveness as Weak, Medium, or Strong based on:
   - Visibility and readability
   - Timing and synchronization with scenes
   - Engagement value (does text add meaning or just repeat audio?)
   - Use of text to emphasize key points
   - Overall contribution to video clarity

2. Provide concise reasoning (1-2 sentences) explaining the rating.

3. List up to two actionable improvements for better caption usage.

Respond in plain text (no markdown, no emojis). Keep total length under 140 words.
Format:
Rating: <Weak/Medium/Strong>
Reasoning: <one or two sentences>
Suggestions:
- <suggestion 1>
- <suggestion 2>
`;

    const response = await requestChatCompletion({
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        maxTokens: 320,
        systemPrompt: "You are a concise caption analyst. Keep outputs structured, plain text, and under 140 words.",
    });

    return response;
};