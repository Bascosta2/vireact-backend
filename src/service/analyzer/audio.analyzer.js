import { requestChatCompletion } from "../openai-response.service.js";
import openai from "../../lib/openai.js";
import { KnowledgeBase } from "../../model/knowledge-base.model.js";
import { KNOWLEDGE_BASE_VECTOR_INDEX } from "../../config/index.js";
import { parseAnalyzerJson, ratingToScore } from "./parse-analyzer-json.js";

const JSON_SYSTEM = "You are a concise audio analyst. Return only valid JSON with keys: score (0-100), rating, reasoning, suggestions (array of strings). No markdown, no code fence.";

export const analyzeAudio = async (scenes) => {
    if (!scenes || scenes.length === 0) {
        throw new Error('Scenes are required for audio analysis');
    }

    // Extract all audio information from scenes
    let audioContexts = scenes
        .map((scene, idx) => {
            const audio = scene.audioSummary || '';
            if (!audio || audio.trim() === '' || audio.toLowerCase() === 'none' || audio.toLowerCase() === 'n/a') {
                return null;
            }
            return `Scene ${idx + 1} (${scene.startTime}s-${scene.endTime}s): ${audio}`;
        })
        .filter(Boolean);

    // Fallback: If no audio summaries found, check onScreenText (captions indicate spoken audio)
    if (audioContexts.length === 0) {
        const captionContexts = scenes
            .map((scene, idx) => {
                const text = scene.onScreenText || '';
                if (text && text.trim() !== '' && text.toLowerCase() !== 'none' && text.toLowerCase() !== 'n/a') {
                    return `Scene ${idx + 1} (${scene.startTime}s-${scene.endTime}s): "${text}" (spoken dialogue/captions)`;
                }
                return null;
            })
            .filter(Boolean);

        if (captionContexts.length > 0) {
            // Captions exist, infer speech audio is present
            audioContexts = captionContexts;
        }
    }

    // Count scenes with and without audio
    const scenesWithAudio = audioContexts.length;
    const scenesWithoutAudio = scenes.length - scenesWithAudio;

    if (audioContexts.length === 0) {
        return { score: 15, rating: "Weak", reasoning: "No audio content detected in the video. Audio is crucial for engagement in short-form content.", suggestions: ["Add background music to create mood and maintain viewer interest", "Include voiceover or narration to guide the viewer"] };
    }

    const audioContext = audioContexts.join('\n');

    // TODO: Uncomment when knowledge base is seeded with audio data
    // Generate embedding for audio analysis
    const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-large",
        input: audioContext
    });
    const audioEmbedding = embeddingResponse.data[0].embedding;

    // Perform vector search to find relevant knowledge base documents
    const relevantData = await KnowledgeBase.aggregate([
        {
            $vectorSearch: {
                index: KNOWLEDGE_BASE_VECTOR_INDEX,
                queryVector: audioEmbedding,
                path: "embedding",
                filter: { "metadata.topic": { $in: ["audio", "general"] } },
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

    const prompt = `You are an expert content reviewer trained on Bas's mindset and audio analysis principles. Bas has 1M+ subscribers on YouTube and has a 99.9% engagement rate.

BAS'S AUDIO INSIGHTS AND EXAMPLES:
${ragContext}

Analyze the audio elements in this short-form social media video.

AUDIO CONTENT:
${audioContext}

AUDIO COVERAGE:
- Scenes with audio: ${scenesWithAudio} out of ${scenes.length}
- Scenes without audio: ${scenesWithoutAudio}

TASK:
1. Rate the audio effectiveness as Weak, Medium, or Strong based on:
   - Presence and coverage across scenes
   - Variety (music, voiceover, sound effects)
   - Synchronization with visual content
   - Contribution to engagement and emotional tone
   - Overall audio-visual harmony

2. Provide concise reasoning (1-2 sentences) explaining the rating.

3. List up to two actionable improvements for better audio usage.

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
    return { score: fallbackScore, rating: "Unknown", reasoning: response || "", suggestions: [] };
}