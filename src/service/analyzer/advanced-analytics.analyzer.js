import { requestChatCompletion } from "../openai-response.service.js";
import openai from "../../lib/openai.js";
import { KnowledgeBase } from "../../model/knowledge-base.model.js";
import { KNOWLEDGE_BASE_VECTOR_INDEX } from "../../config/index.js";

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
                filter: { "metadata.topic": "advanced_analytics" },
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

BAS'S ADVANCED ANALYTICS INSIGHTS AND EXAMPLES:
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

TASK:
1. Rate the overall video structure and engagement potential as Weak, Medium, or Strong based on:
   - Structural completeness (hook, buildup, reveal, CTA)
   - Content diversity (text, audio, emotional variation)
   - Retention signals and viewer journey
   - Overall production quality indicators

2. Provide concise reasoning (1-2 sentences) explaining the rating.

3. List up to two actionable improvements for better video performance.

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
        systemPrompt: "You are a concise video analytics expert. Keep outputs structured, plain text, and under 140 words.",
    });

    return response;
};