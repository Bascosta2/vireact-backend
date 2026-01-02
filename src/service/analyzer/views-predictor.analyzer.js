import { requestChatCompletion } from "../openai-response.service.js";
import openai from "../../lib/openai.js";
import { KnowledgeBase } from "../../model/knowledge-base.model.js";
import { KNOWLEDGE_BASE_VECTOR_INDEX } from "../../config/index.js";

export const analyzeViewsPredictor = async (scenes) => {
    if (!scenes || scenes.length === 0) {
        throw new Error('Scenes are required for views prediction');
    }

    // Calculate key metrics that influence views
    const totalDuration = scenes[scenes.length - 1]?.endTime || 0;
    const sceneCount = scenes.length;
    const avgSceneLength = totalDuration / sceneCount;

    // Structure analysis
    const purposeDistribution = {};
    scenes.forEach(scene => {
        const purpose = scene.purpose?.toLowerCase() || 'unknown';
        purposeDistribution[purpose] = (purposeDistribution[purpose] || 0) + 1;
    });

    const hasHook = purposeDistribution.hook > 0;
    const hasCTA = purposeDistribution.cta > 0;
    const hasReveal = purposeDistribution.reveal > 0;

    // Engagement signals
    const scenesWithText = scenes.filter(s => s.onScreenText && s.onScreenText.trim() && s.onScreenText.toLowerCase() !== 'none').length;
    const scenesWithAudio = scenes.filter(s => s.audioSummary && s.audioSummary.trim() && s.audioSummary.toLowerCase() !== 'none' && s.audioSummary.toLowerCase() !== 'n/a').length;

    // Emotional engagement
    const emotionalTones = scenes
        .map(s => s.emotionalTone?.toLowerCase())
        .filter(t => t && t !== 'none' && t !== 'n/a');
    const uniqueTones = new Set(emotionalTones).size;
    const hasEmotionalVariety = uniqueTones > 1;

    // Pacing score (faster = better for short-form)
    const cutFrequency = sceneCount / (totalDuration || 1);
    const isFastPaced = cutFrequency > 0.5; // more than 0.5 cuts per second

    // Build comprehensive summary
    const videoSummary = {
        duration: totalDuration.toFixed(1),
        sceneCount,
        avgSceneLength: avgSceneLength.toFixed(1),
        structureScore: (hasHook ? 1 : 0) + (hasReveal ? 1 : 0) + (hasCTA ? 1 : 0),
        engagementScore: (scenesWithText / sceneCount) + (scenesWithAudio / sceneCount),
        pacingScore: isFastPaced ? 1 : 0.5,
        emotionalVariety: hasEmotionalVariety ? 1 : 0
    };

    const scenesSummary = scenes.map((scene, idx) => {
        return `Scene ${idx + 1}: ${(scene.endTime - scene.startTime).toFixed(1)}s | ${scene.purpose || 'N/A'} | ${scene.emotionalTone || 'N/A'}`;
    }).join('\n');

    // Generate embedding for views prediction
    const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-large",
        input: scenesSummary
    });
    const predictorEmbedding = embeddingResponse.data[0].embedding;

    // Perform vector search to find relevant knowledge base documents
    const relevantData = await KnowledgeBase.aggregate([
        {
            $vectorSearch: {
                index: KNOWLEDGE_BASE_VECTOR_INDEX,
                queryVector: predictorEmbedding,
                path: "embedding",
                filter: { "metadata.topic": "views_predictor" },
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

    const prompt = `You are an expert psychological content reviewer trained on Bas's mindset and views prediction analysis principles. Bas has 1M+ subscribers on YouTube and has a 99.9% engagement rate.

BAS'S VIEWS PREDICTION INSIGHTS AND EXAMPLES:
${ragContext}

Predict the view potential of this short-form social media video based on key performance indicators.

VIDEO CHARACTERISTICS:
- Duration: ${videoSummary.duration}s
- Scenes: ${videoSummary.sceneCount}
- Average scene length: ${videoSummary.avgSceneLength}s

STRUCTURE SCORE (0-3):
- Has hook: ${hasHook ? 'Yes' : 'No'}
- Has reveal: ${hasReveal ? 'Yes' : 'No'}
- Has CTA: ${hasCTA ? 'Yes' : 'No'}
Score: ${videoSummary.structureScore}/3

ENGAGEMENT SIGNALS:
- Text coverage: ${scenesWithText}/${sceneCount} scenes (${((scenesWithText/sceneCount)*100).toFixed(0)}%)
- Audio coverage: ${scenesWithAudio}/${sceneCount} scenes (${((scenesWithAudio/sceneCount)*100).toFixed(0)}%)
- Emotional variety: ${hasEmotionalVariety ? 'Yes' : 'No'}
- Pacing: ${isFastPaced ? 'Fast' : 'Moderate'} (${cutFrequency.toFixed(2)} cuts/sec)

SCENE BREAKDOWN:
${scenesSummary}

TASK:
1. Rate view potential as Low, Medium, or High based on:
   - Hook strength and early engagement
   - Structural completeness (hook, reveal, CTA)
   - Engagement elements (text, audio, emotional variety)
   - Pacing and rhythm
   - Overall production quality indicators

2. Provide concise reasoning (1-2 sentences) explaining the prediction.

3. List up to two key improvements that would most likely increase view potential.

Respond in plain text (no markdown, no emojis). Keep total length under 140 words.
Format:
Rating: <Low/Medium/High>
Reasoning: <one or two sentences>
Suggestions:
- <suggestion 1>
- <suggestion 2>
`;

    const response = await requestChatCompletion({
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        maxTokens: 320,
        systemPrompt: "You are a concise video performance predictor. Keep outputs structured, plain text, and under 140 words.",
    });

    return response;
};