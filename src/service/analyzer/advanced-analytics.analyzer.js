import { runFeedbackAnalyzer, SPECIFICITY_CONTRACT } from "./run-feedback-analyzer.js";
import { advancedAnalyticsJsonSchema } from "./feedback-schema.js";

const JSON_SYSTEM = [
    "You are a video psychology expert analyzing short-form content. You return structured data only.",
    "You explain viewer psychology in terms of specific moments, and every fix you propose is literal content the creator can drop in.",
    SPECIFICITY_CONTRACT,
].join('\n\n');

const RETENTION_CONTEXT = `RETENTION AND DURATION CONTEXT:
- Retention rate CAN exceed 100% on short-form videos (typically under 20 seconds). This happens when viewers replay the video, which is a strong positive engagement signal — not a data error.
- A 13-second video with 180% retention means viewers watched it an average of 1.8 times. This is extremely positive and correlates strongly with viral performance.
- When retention exceeds 100%, weight it heavily as a virality indicator. A video under 15 seconds with retention over 120% should be treated as having near-perfect hook and loop-ability.
- For creator videos where retention data is not available, infer retention likelihood from: scene pacing (fast cuts under 2s correlate with higher retention), hook strength (first scene emotional tone and primary action), video duration (shorter videos statistically retain better), audio continuity (consistent audio across scenes correlates with completion), and visual variety (low scene repetition correlates with higher retention).
- Duration-retention relationship: videos under 15s can achieve 150-300% retention via replays. Videos 15-30s typically see 60-90% retention if well-paced. Videos 30-60s typically see 40-70% retention. Use these benchmarks when retention data is absent.
- When predicting views, always factor in duration-adjusted retention. A 10-second video with 200% retention is performing better in engagement terms than a 45-second video with 75% retention, even if raw retention percentage looks lower on the longer video.`;

/**
 * Advanced analytics (Pro/Enterprise only — gated at upload and dispatch).
 * Feedback authored here is tagged `sourceFeature: 'advanced_analytics'` so the
 * video DTO strips it for Free/Premium exactly like `features.advanced`.
 *
 * @param {object[]} scenes
 * @param {{ rawTranscript?: object[], duration?: number, videoId?: string }} [context]
 */
export const analyzeAdvancedAnalytics = async (scenes, context = {}) => {
    if (!scenes || scenes.length === 0) {
        throw new Error('Scenes are required for advanced analytics');
    }

    const { rawTranscript = [], duration, videoId } = context;

    const totalDuration = scenes[scenes.length - 1]?.endTime || 0;
    const sceneCount = scenes.length;

    const purposeDistribution = {};
    scenes.forEach(scene => {
        const purpose = scene.purpose?.toLowerCase() || 'unknown';
        purposeDistribution[purpose] = (purposeDistribution[purpose] || 0) + 1;
    });

    const emotionalToneDistribution = {};
    scenes.forEach(scene => {
        const tone = scene.emotionalTone?.toLowerCase() || 'unknown';
        if (tone && tone !== 'n/a' && tone !== 'none') {
            emotionalToneDistribution[tone] = (emotionalToneDistribution[tone] || 0) + 1;
        }
    });

    const hasHook = purposeDistribution.hook > 0;
    const hasCTA = purposeDistribution.cta > 0;
    const hasReveal = purposeDistribution.reveal > 0;
    const hasBuildup = purposeDistribution.buildup > 0;

    const scenesWithText = scenes.filter(s => s.onScreenText && s.onScreenText.trim() && s.onScreenText.toLowerCase() !== 'none').length;
    const textCoverage = (scenesWithText / sceneCount) * 100;

    const scenesWithAudio = scenes.filter(s => s.audioSummary && s.audioSummary.trim() && s.audioSummary.toLowerCase() !== 'none' && s.audioSummary.toLowerCase() !== 'n/a').length;
    const audioCoverage = (scenesWithAudio / sceneCount) * 100;

    const scenesSummary = scenes.map((scene, idx) => {
        return `Scene ${idx + 1}: ${(scene.endTime - scene.startTime).toFixed(1)}s | Purpose: ${scene.purpose || 'N/A'} | Tone: ${scene.emotionalTone || 'N/A'}`;
    }).join('\n');

    return runFeedbackAnalyzer({
        feature: 'advanced_analytics',
        schemaName: 'advanced_analytics_analysis',
        jsonSchema: advancedAnalyticsJsonSchema,
        systemPrompt: JSON_SYSTEM,
        ragQuery: scenesSummary,
        ragTopics: ['advanced_analytics', 'general'],
        scenes,
        rawTranscript,
        duration: duration ?? totalDuration,
        videoId,
        maxTokens: 4000,
        buildPrompt: ({ scenesBlock, transcriptBlock, ragContext }) => `
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

SCENE TIMING:
${scenesSummary}

TRANSCRIPT (verbatim, with timestamps):
${transcriptBlock}

SCENE DETAIL:
${scenesBlock}

${RETENTION_CONTEXT}

TASK:
1. Rate overall structure and engagement potential as Weak, Medium, or Strong (score 0-100: Weak 1-40, Medium 41-70, Strong 71-100) based on structural completeness, content diversity, retention signals, and production quality indicators.
2. Provide concise reasoning (1-2 sentences).
3. suggestions: up to two short headlines naming the concrete change.
4. emotionalTriggers: short labels (e.g. "curiosity gap", "social proof", "urgency") grounded in the retrieved insights. Cite the principle when possible.
5. retentionDrivers: concrete drivers tied to real times (e.g. "pattern interrupt at 0:08"), grounded in the same insights and the scene data.
6. psychologicalProfile: 1-2 sentences summarizing the video's psychological strategy.
7. weakestMoment: a single string with timestamp + reason, or null if none stands out.
8. frameFeedback: the structural and psychological failure points, each at its exact range with a literal fix. Use the fix type that matches the actual repair (replace_line for wording, cut/trim for structure, add_text_overlay for on-screen claims, add_sound for audio beats, reshoot_note for delivery).
9. scriptRewrites: verbatim quotes of the weakest spoken lines with the exact replacement lines. Empty array when there is no speech.
`,
    });
};
