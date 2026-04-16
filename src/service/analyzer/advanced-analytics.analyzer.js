import { requestChatCompletion } from "../openai-response.service.js";
import openai from "../../lib/openai.js";
import { KnowledgeBase } from "../../model/knowledge-base.model.js";
import { KNOWLEDGE_BASE_VECTOR_INDEX } from "../../config/index.js";
import { parseAdvancedAnalyticsJson, ratingToScore } from "./parse-analyzer-json.js";

const JSON_SYSTEM =
    "You are a video psychology expert analyzing short-form content. Return only valid JSON with keys: score (0-100), rating, reasoning, suggestions (string[]), emotionalTriggers (string[]), retentionDrivers (string[]), psychologicalProfile (string), weakestMoment (string or null). No markdown, no code fence.";

export const analyzeAdvancedAnalytics = async (scenes) => {
    if (!scenes || scenes.length === 0) {
        throw new Error('Scenes are required for advanced analytics');
    }

    // Aggregate metrics
    const totalDuration = scenes[scenes.length - 1]?.endTime || 0;
    const sceneCount = scenes.length;

    // Scene purpose distribution
    const purposeDistribution = {};
    scenes.forEach(scene => {
        const purpose = scene.purpose?.toLowerCase() || 'unknown';
        purposeDistribution[purpose] = (purposeDistribution[purpose] || 0) + 1;
    });

    // Emotional tone distribution
    const emotionalToneDistribution = {};
    scenes.forEach(scene => {
        const tone = scene.emotionalTone?.toLowerCase() || 'unknown';
        if (tone && tone !== 'n/a' && tone !== 'none') {
            emotionalToneDistribution[tone] = (emotionalToneDistribution[tone] || 0) + 1;
        }
    });

    // Calculate retention signals
    const hasHook = purposeDistribution.hook > 0;
    const hasCTA = purposeDistribution.cta > 0;
    const hasReveal = purposeDistribution.reveal > 0;
    const hasBuildup = purposeDistribution.buildup > 0;

    // Text coverage
    const scenesWithText = scenes.filter(s => s.onScreenText && s.onScreenText.trim() && s.onScreenText.toLowerCase() !== 'none').length;
    const textCoverage = (scenesWithText / sceneCount) * 100;

    // Audio coverage
    const scenesWithAudio = scenes.filter(s => s.audioSummary && s.audioSummary.trim() && s.audioSummary.toLowerCase() !== 'none' && s.audioSummary.toLowerCase() !== 'n/a').length;
    const audioCoverage = (scenesWithAudio / sceneCount) * 100;

    // Build scene breakdown summary
    const scenesSummary = scenes.map((scene, idx) => {
        return `Scene ${idx + 1}: ${(scene.endTime - scene.startTime).toFixed(1)}s | Purpose: ${scene.purpose || 'N/A'} | Tone: ${scene.emotionalTone || 'N/A'}`;
    }).join('\n');

    // Generate embedding for advanced analytics
    const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-large",
        input: scenesSummary
    });
    const analyticsEmbedding = embeddingResponse.data[0].embedding;

    // Perform vector search to find relevant knowledge base documents
    const relevantData = await KnowledgeBase.aggregate([
        {
            $vectorSearch: {
                index: KNOWLEDGE_BASE_VECTOR_INDEX,
                queryVector: analyticsEmbedding,
                path: "embedding",
                filter: { "metadata.topic": { $in: ["advanced_analytics", "general"] } },
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
You are an expert psychological content reviewer trained on Bas's mindset and advanced analytics principles. Bas has 1M+ subscribers on YouTube and has a 99.9% engagement rate.

BAS'S INSIGHTS (RETRIEVED RAG CHUNKS):
${ragContext}

Analyze this short-form social media video using advanced analytics metrics.

VIDEO METRICS:
- Total duration: ${totalDuration.toFixed(1)}s
- Total scenes: ${sceneCount}
- Average scene length: ${(totalDuration / sceneCount).toFixed(1)}s

STRUCTURE ANALYSIS:
- Has hook: ${hasHook ? 'Yes' : 'No'}
- Has buildup: ${hasBuildup ? 'Yes' : 'No'}
- Has reveal: ${hasReveal ? 'Yes' : 'No'}
- Has CTA: ${hasCTA ? 'Yes' : 'No'}

CONTENT COVERAGE:
- Text coverage: ${textCoverage.toFixed(0)}% of scenes
- Audio coverage: ${audioCoverage.toFixed(0)}% of scenes

PURPOSE DISTRIBUTION:
${Object.entries(purposeDistribution).map(([purpose, count]) => `- ${purpose}: ${count} scene(s)`).join('\n')}

EMOTIONAL TONE DISTRIBUTION:
${Object.keys(emotionalToneDistribution).length > 0 
    ? Object.entries(emotionalToneDistribution).map(([tone, count]) => `- ${tone}: ${count} scene(s)`).join('\n')
    : '- No emotional tone data'}

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
1. Rate the overall video structure and engagement potential as Weak, Medium, or Strong based on:
   - Structural completeness (hook, buildup, reveal, CTA)
   - Content diversity (text, audio, emotional variation)
   - Retention signals and viewer journey
   - Overall production quality indicators

2. Provide concise reasoning (1-2 sentences) explaining the rating.

3. List up to two actionable improvements for better video performance.

4. emotionalTriggers: short labels (e.g. "curiosity gap", "social proof", "urgency") grounded in psychological principles that appear or are implied in BAS'S INSIGHTS (RETRIEVED RAG CHUNKS). Cite the principle(s) from those chunks when possible.

5. retentionDrivers: concrete drivers (e.g. "pattern interrupt at 0:08", "strong hook payoff") grounded in the same retrieved insights and the scene data below. Cite the principle(s) from BAS'S INSIGHTS when possible.

6. psychologicalProfile: 1-2 sentences summarizing the video's overall psychological strategy.

7. weakestMoment: a single string with timestamp + reason (e.g. "0:14 — pacing drops, viewer likely swipes"), or null if none stands out.

Return ONLY a valid JSON object with this exact shape, no other text:
{"score": <number 0-100>, "rating": "<Weak|Medium|Strong>", "reasoning": "<one or two sentences>", "suggestions": ["<suggestion 1>", "<suggestion 2>"], "emotionalTriggers": ["<trigger 1>", "..."], "retentionDrivers": ["<driver 1>", "..."], "psychologicalProfile": "<1-2 sentences>", "weakestMoment": "<timestamp — reason>" | null}
`;

    const response = await requestChatCompletion({
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        maxTokens: 560,
        systemPrompt: JSON_SYSTEM,
    });

    const parsed = parseAdvancedAnalyticsJson(response);
    if (parsed) return parsed;
    const fallbackScore = ratingToScore((response || '').match(/rating[:\-\s]*([^\n]+)/i)?.[1]);
    return {
        score: fallbackScore,
        rating: "Unknown",
        reasoning: response || "",
        suggestions: [],
        emotionalTriggers: [],
        retentionDrivers: [],
        psychologicalProfile: null,
        weakestMoment: null,
    };
}