import openai from "../../lib/openai.js";
import { KnowledgeBase } from "../../model/knowledge-base.model.js";
import { KNOWLEDGE_BASE_VECTOR_INDEX } from "../../config/index.js";
import { requestChatCompletion } from "../openai-response.service.js";

export const analyzeHook = async (hook, scenes) => {
    if (!hook) {
        throw new Error('Hook is required for analysis');
    }

    // Generate embedding for the hook text
    const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-large",
        input: hook
    });

    const hookEmbedding = embeddingResponse.data[0].embedding;

    // Perform vector search to find relevant knowledge base documents
    const relevantData = await KnowledgeBase.aggregate([
        {
            $vectorSearch: {
                index: KNOWLEDGE_BASE_VECTOR_INDEX,
                queryVector: hookEmbedding,
                path: "embedding",
                filter: { "metadata.topic": "hook" },
                limit: 10,
                numCandidates: 100
            }
        }
    ]);

    // Format scenes for context
    const scenesContext = scenes && scenes.length > 0
        ? scenes.map((scene, idx) => 
            `Scene ${idx + 1} (${scene.startTime}s - ${scene.endTime}s):
- Visual: ${scene.visualDescription || 'N/A'}
- Text/Captions: ${scene.onScreenText || 'None'}
- Audio: ${scene.audioSummary || 'N/A'}
- Primary Action: ${scene.primaryAction || 'N/A'}
- Emotional Tone: ${scene.emotionalTone || 'N/A'}
- Purpose: ${scene.purpose || 'N/A'}`
        ).join('\n\n')
        : 'No scene breakdown available';

    // Format relevant knowledge base context
    const ragContext = relevantData.length > 0
        ? relevantData
            .map(
                (c, i) =>
                    `${i + 1}. [${c.metadata.layer.toUpperCase()}] ${c.content}`
            )
            .join("\n")
        : 'No relevant knowledge base documents found';

    const prompt = `
You are an expert psychological content reviewer trained on Bas's mindset and hook analysis principles. Bas has 1M+ subscribers on YouTube and has a 99.9% engagement rate.

BAS'S HOOK INSIGHTS AND EXAMPLES:
${ragContext}

VIDEO HOOK TO ANALYZE:
"${hook}"

SCENE BREAKDOWN (for context):
${scenesContext}

TASK:
1. Rate the hook as Weak, Medium, or Strong based on Bas's principles.
2. Provide a concise reasoning (1-2 sentences) that cites the most relevant insight.
3. List up to two actionable improvements.

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
        systemPrompt:
            "You are a concise hook analyst. Keep outputs structured, plain text, and under 140 words.",
    });

    return response;
};