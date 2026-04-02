import openai from "../../lib/openai.js";
import { KnowledgeBase } from "../../model/knowledge-base.model.js";
import { KNOWLEDGE_BASE_VECTOR_INDEX } from "../../config/index.js";
import { requestChatCompletion } from "../openai-response.service.js";
import { parseAnalyzerJson, ratingToScore } from "./parse-analyzer-json.js";

const JSON_SYSTEM = "You are a concise hook analyst. Return only valid JSON with keys: score (0-100), rating, reasoning, suggestions (array of strings). No markdown, no code fence.";

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
1. Rate the hook as Weak, Medium, or Strong based on Bas's principles (map to score 0-100: Weak 1-40, Medium 41-70, Strong 71-100).
2. Provide concise reasoning (1-2 sentences) that cites the most relevant insight.
3. List up to two actionable improvements.

Return ONLY a valid JSON object with this exact shape, no other text:
{"score": <number 0-100>, "rating": "<Weak|Medium|Strong>", "reasoning": "<one or two sentences>", "suggestions": ["<suggestion 1>", "<suggestion 2>"]}
`;

    const response = await requestChatCompletion({
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        maxTokens: 320,
        systemPrompt: JSON_SYSTEM,
    });

    const parsed = parseAnalyzerJson(response);
    if (parsed) return parsed;
    const fallbackScore = ratingToScore((response || '').match(/rating[:\-\s]*([^\n]+)/i)?.[1]);
    return {
        score: fallbackScore,
        rating: 'Unknown',
        reasoning: response || '',
        suggestions: []
    };
};