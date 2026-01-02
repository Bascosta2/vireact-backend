import { requestChatCompletion } from "../openai-response.service.js";
import openai from "../../lib/openai.js";
import { KnowledgeBase } from "../../model/knowledge-base.model.js";
import { KNOWLEDGE_BASE_VECTOR_INDEX } from "../../config/index.js";

export const analyzePacing = async (scenes) => {
    if (!scenes || scenes.length === 0) {
        throw new Error('Scenes are required for pacing analysis');
    }

    // Calculate pacing metrics
    const totalDuration = scenes[scenes.length - 1]?.endTime || 0;
    const sceneDurations = scenes.map(scene => scene.endTime - scene.startTime);
    const avgSceneLength = sceneDurations.reduce((sum, d) => sum + d, 0) / scenes.length;
    const shortestScene = Math.min(...sceneDurations);
    const longestScene = Math.max(...sceneDurations);
    const cutFrequency = scenes.length / (totalDuration || 1); // cuts per second

    // Analyze scene purpose distribution
    const purposeCounts = {};
    scenes.forEach(scene => {
        const purpose = scene.purpose?.toLowerCase() || 'unknown';
        purposeCounts[purpose] = (purposeCounts[purpose] || 0) + 1;
    });

    // Build scene breakdown with timing
    const scenesContext = scenes.map((scene, idx) => {
        const duration = scene.endTime - scene.startTime;
        return `Scene ${idx + 1}: ${duration.toFixed(1)}s (${scene.startTime}s-${scene.endTime}s) - Purpose: ${scene.purpose || 'N/A'}`;
    }).join('\n');

    // TODO: Uncomment when knowledge base is seeded with pacing data
    // Generate embedding for pacing analysis
    const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-large",
        input: scenesContext
    });
    const pacingEmbedding = embeddingResponse.data[0].embedding;

    // Perform vector search to find relevant knowledge base documents
    const relevantData = await KnowledgeBase.aggregate([
        {
            $vectorSearch: {
                index: KNOWLEDGE_BASE_VECTOR_INDEX,
                queryVector: pacingEmbedding,
                path: "embedding",
                filter: { "metadata.topic": "pacing" },
                limit: 10,
                numCandidates: 100
            }
        }
    ]);

    // Format relevant knowledge base context
    const ragContext = relevantData.length > 0
        ? relevantData
            .map((c, i) => `${i + 1}. [${c.metadata.layer.toUpperCase()}] ${c.content}`)
            .join("\n")
        : 'No specific knowledge base documents found';

    const prompt = `
You are an expert psychological content reviewer trained on Bas's mindset and pacing analysis principles. Bas has 1M+ subscribers on YouTube and has a 99.9% engagement rate.

BAS'S PACING INSIGHTS AND EXAMPLES:
${ragContext}

Analyze the pacing and rhythm of this short-form social media video.

PACING METRICS:
- Total scenes: ${scenes.length}
- Total duration: ${totalDuration.toFixed(1)}s
- Average scene length: ${avgSceneLength.toFixed(1)}s
- Shortest scene: ${shortestScene.toFixed(1)}s
- Longest scene: ${longestScene.toFixed(1)}s
- Cut frequency: ${cutFrequency.toFixed(2)} cuts/second

SCENE BREAKDOWN:
${scenesContext}

PURPOSE DISTRIBUTION:
${Object.entries(purposeCounts).map(([purpose, count]) => `- ${purpose}: ${count} scene(s)`).join('\n')}

TASK:
1. Rate the pacing as Weak, Medium, or Strong based on:
   - Scene transition speed and rhythm
   - Variety in scene lengths (too uniform can be boring)
   - Whether pacing matches the content type (fast for hooks, varied for buildup)
   - Overall engagement and retention potential

2. Provide concise reasoning (1-2 sentences) explaining the rating.

3. List up to two actionable improvements for better pacing.

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
        systemPrompt: "You are a concise pacing analyst. Keep outputs structured, plain text, and under 140 words.",
    });

    return response;
};