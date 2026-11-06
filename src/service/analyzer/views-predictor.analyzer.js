import { runFeedbackAnalyzer, SPECIFICITY_CONTRACT } from "./run-feedback-analyzer.js";
import { viewsPredictorJsonSchema } from "./feedback-schema.js";

const JSON_SYSTEM = [
    "You are a video performance predictor for short-form content. You return structured data only.",
    "Predictions are approximate bands, never guarantees. Any moment you blame for capping the band must come with the literal fix that would lift it.",
    SPECIFICITY_CONTRACT,
].join('\n\n');

const RETENTION_CONTEXT = `RETENTION AND DURATION CONTEXT:
- Retention rate CAN exceed 100% on short-form videos (typically under 20 seconds). This happens when viewers replay the video, which is a strong positive engagement signal, not a data error.
- A 13-second video with 180% retention means viewers watched it an average of 1.8 times. This is extremely positive and correlates strongly with viral performance.
- When retention exceeds 100%, weight it heavily as a virality indicator. A video under 15 seconds with retention over 120% should be treated as having near-perfect hook and loop-ability.
- For creator videos where retention data is not available, infer retention likelihood from: scene pacing (fast cuts under 2s correlate with higher retention), hook strength (first scene emotional tone and primary action), video duration (shorter videos statistically retain better), audio continuity (consistent audio across scenes correlates with completion), and visual variety (low scene repetition correlates with higher retention).
- Duration-retention relationship: videos under 15s can achieve 150-300% retention via replays. Videos 15-30s typically see 60-90% retention if well-paced. Videos 30-60s typically see 40-70% retention. Use these benchmarks when retention data is absent.
- When predicting views, always factor in duration-adjusted retention. A 10-second video with 200% retention is performing better in engagement terms than a 45-second video with 75% retention, even if raw retention percentage looks lower on the longer video.`;

/**
 * Views prediction. Returns view bands plus the specific moments that cap them.
 * Emits `frameFeedback` only, script rewrites belong to the hook/pacing analyzers.
 *
 * @param {object[]} scenes
 * @param {{ rawTranscript?: object[], duration?: number, videoId?: string }} [context]
 */
export const analyzeViewsPredictor = async (scenes, context = {}) => {
    if (!scenes || scenes.length === 0) {
        throw new Error('Scenes are required for views prediction');
    }

    const { rawTranscript = [], duration, videoId } = context;

    const totalDuration = scenes[scenes.length - 1]?.endTime || 0;
    const sceneCount = scenes.length;
    const avgSceneLength = totalDuration / sceneCount;

    const purposeDistribution = {};
    scenes.forEach(scene => {
        const purpose = scene.purpose?.toLowerCase() || 'unknown';
        purposeDistribution[purpose] = (purposeDistribution[purpose] || 0) + 1;
    });

    const hasHook = purposeDistribution.hook > 0;
    const hasCTA = purposeDistribution.cta > 0;
    const hasReveal = purposeDistribution.reveal > 0;

    const scenesWithText = scenes.filter(s => s.onScreenText && s.onScreenText.trim() && s.onScreenText.toLowerCase() !== 'none').length;
    const scenesWithAudio = scenes.filter(s => s.audioSummary && s.audioSummary.trim() && s.audioSummary.toLowerCase() !== 'none' && s.audioSummary.toLowerCase() !== 'n/a').length;

    const emotionalTones = scenes
        .map(s => s.emotionalTone?.toLowerCase())
        .filter(t => t && t !== 'none' && t !== 'n/a');
    const hasEmotionalVariety = new Set(emotionalTones).size > 1;

    const cutFrequency = sceneCount / (totalDuration || 1);
    const isFastPaced = cutFrequency > 0.5;
    const structureScore = (hasHook ? 1 : 0) + (hasReveal ? 1 : 0) + (hasCTA ? 1 : 0);

    const scenesSummary = scenes.map((scene, idx) => {
        return `Scene ${idx + 1}: ${(scene.endTime - scene.startTime).toFixed(1)}s | ${scene.purpose || 'N/A'} | ${scene.emotionalTone || 'N/A'}`;
    }).join('\n');

    return runFeedbackAnalyzer({
        feature: 'views_predictor',
        schemaName: 'views_predictor_analysis',
        jsonSchema: viewsPredictorJsonSchema,
        systemPrompt: JSON_SYSTEM,
        ragQuery: scenesSummary,
        ragTopics: ['views_predictor', 'general'],
        scenes,
        rawTranscript,
        duration: duration ?? totalDuration,
        videoId,
        maxTokens: 3000,
        buildPrompt: ({ scenesBlock, transcriptBlock, ragContext }) => `
You are a strict short-form video editor reviewing one creator's video. You give exact, timestamped instructions, never general tips.

REFERENCE NOTES (your private playbook. Apply them; never mention them, their author or that they exist):
${ragContext}

Predict the view potential of this short-form social media video based on key performance indicators.

VIDEO CHARACTERISTICS:
- Duration: ${totalDuration.toFixed(1)}s
- Scenes: ${sceneCount}
- Average scene length: ${avgSceneLength.toFixed(1)}s

STRUCTURE SCORE (0-3):
- Has hook: ${hasHook ? 'Yes' : 'No'}
- Has reveal: ${hasReveal ? 'Yes' : 'No'}
- Has CTA: ${hasCTA ? 'Yes' : 'No'}
Score: ${structureScore}/3

ENGAGEMENT SIGNALS:
- Text coverage: ${scenesWithText}/${sceneCount} scenes (${((scenesWithText / sceneCount) * 100).toFixed(0)}%)
- Audio coverage: ${scenesWithAudio}/${sceneCount} scenes (${((scenesWithAudio / sceneCount) * 100).toFixed(0)}%)
- Emotional variety: ${hasEmotionalVariety ? 'Yes' : 'No'}
- Pacing: ${isFastPaced ? 'Fast' : 'Moderate'} (${cutFrequency.toFixed(2)} cuts/sec)

SCENE TIMING:
${scenesSummary}

TRANSCRIPT (verbatim, with timestamps):
${transcriptBlock}

SCENE DETAIL:
${scenesBlock}

${RETENTION_CONTEXT}

VIEW BASE RATES (use these, not the reference notes, to size the numbers):
- Most short-form posts from typical creators get under 1,000 views. A median post sits in the low hundreds.
- 10,000+ views is uncommon (roughly the top 10% of posts). 100,000+ is rare (well under 1%).
- The reference notes come mostly from videos that already went viral. They show what works, not what is typical. Never size a band from them.
- Only predict above 10,000 expected views when the hook, pacing and payoff are all clearly strong. When in doubt, go lower.

TASK:
1. Rate view potential as low, medium, or high (tier). Most videos are low. Use high only for a clearly exceptional video.
2. Estimate view bands in whole numbers (e.g. 800, not "800 views"): conservative (low end of a realistic range), expected (most likely), optimistic (high end if everything goes well). Size them from the base rates above.
3. Set confidence 0-1 for the prediction.
4. reasoning: one or two short sentences naming the seconds that cap the views and why. suggestions: exactly two complete instructions, each starting with the time range and stating the exact change (words, on-screen text or cut). No generic tips.
5. frameFeedback: the specific moments that most constrain the predicted band, each at its exact range with a literal fix and an expectedImpact written as a plain outcome (e.g. "more viewers reach the reveal at 0:06"). Return an empty array only when no single moment is limiting the band.
`,
    });
};
