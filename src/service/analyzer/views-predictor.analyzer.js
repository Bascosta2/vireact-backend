import { requestChatCompletion } from "../openai-response.service.js";
import openai from "../../lib/openai.js";
import { KnowledgeBase } from "../../model/knowledge-base.model.js";
import { KNOWLEDGE_BASE_VECTOR_INDEX } from "../../config/index.js";
import { parseViewsPredictorJson } from "./parse-analyzer-json.js";

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

RETENTION AND DURATION CONTEXT:
- Retention rate CAN exceed 100% on short-form videos (typically under 20 seconds). This happens when viewers replay the video, which is a strong positive engagement signal — not a data error.
- A 13-second video with 180% retention means viewers watched it an average of 1.8 times. This is extremely positive and correlates strongly with viral performance.
- When retention exceeds 100%, weight it heavily as a virality indicator. A video under 15 seconds with retention over 120% should be treated as having near-perfect hook and loop-ability.
- For creator videos where retention data is not available, infer retention likelihood from: scene pacing (fast cuts under 2s correlate with higher retention), hook strength (first scene emotional tone and primary action), video duration (shorter videos statistically retain better), audio continuity (consistent audio across scenes correlates with completion), and visual variety (low scene repetition correlates with higher retention).
- Duration-retention relationship: videos under 15s can achieve 150-300% retention via replays. Videos 15-30s typically see 60-90% retention if well-paced. Videos 30-60s typically see 40-70% retention. Use these benchmarks when retention data is absent.
- When predicting views, always factor in duration-adjusted retention. A 10-second video with 200% retention is performing better in engagement terms than a 45-second video with 75% retention, even if raw retention percentage looks lower on the longer video.

TASK:
1. Rate view potential as Low, Medium, or High (tier).
2. Estimate view bands in whole numbers (e.g. 50000 for 50K):
   - conservative: low end of realistic range
   - expected: most likely range
   - optimistic: high end if everything goes well
3. Set confidence 0-1 for the prediction.
4. Provide reasoning and up to two improvements (for context; bands are required).

Return ONLY a valid JSON object with this exact shape, no other text:
{"tier": "<low|medium|high>", "conservativeLow": <number>, "conservativeHigh": <number>, "expectedLow": <number>, "expectedHigh": <number>, "optimisticLow": <number>, "optimisticHigh": <number>, "confidence": <0-1>, "reasoning": "<one or two sentences>", "suggestions": ["<suggestion 1>", "<suggestion 2>"]}
`;

    const response = await requestChatCompletion({
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        maxTokens: 400,
        systemPrompt: "You are a video performance predictor. Return only valid JSON with tier, view band numbers (conservativeLow/High, expectedLow/High, optimisticLow/High), confidence, reasoning, suggestions. No markdown.",
    });

    const parsed = parseViewsPredictorJson(response);
    if (parsed) return parsed;
    const fallback = {
        tier: 'medium',
        conservativeLow: 5000,
        conservativeHigh: 15000,
        expectedLow: 10000,
        expectedHigh: 50000,
        optimisticLow: 25000,
        optimisticHigh: 100000,
        confidence: 0.5,
        reasoning: response || 'Unable to parse view prediction.',
        suggestions: []
    };
    return fallback;
};