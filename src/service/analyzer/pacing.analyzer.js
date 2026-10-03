import { runFeedbackAnalyzer, SPECIFICITY_CONTRACT } from "./run-feedback-analyzer.js";
import { analyzerJsonSchema } from "./feedback-schema.js";

const JSON_SYSTEM = [
    "You are a pacing and rhythm analyst for short-form video. You return structured data only.",
    "Pacing fixes are edit instructions: always state the exact range to cut or trim and the resulting duration.",
    SPECIFICITY_CONTRACT,
].join('\n\n');

/**
 * Pacing / rhythm analysis.
 *
 * @param {object[]} scenes
 * @param {{ rawTranscript?: object[], duration?: number, videoId?: string }} [context]
 */
export const analyzePacing = async (scenes, context = {}) => {
    if (!scenes || scenes.length === 0) {
        throw new Error('Scenes are required for pacing analysis');
    }

    const { rawTranscript = [], duration, videoId } = context;

    const totalDuration = scenes[scenes.length - 1]?.endTime || 0;
    const sceneDurations = scenes.map(scene => scene.endTime - scene.startTime);
    const avgSceneLength = sceneDurations.reduce((sum, d) => sum + d, 0) / scenes.length;
    const shortestScene = Math.min(...sceneDurations);
    const longestScene = Math.max(...sceneDurations);
    const cutFrequency = scenes.length / (totalDuration || 1);

    const purposeCounts = {};
    scenes.forEach(scene => {
        const purpose = scene.purpose?.toLowerCase() || 'unknown';
        purposeCounts[purpose] = (purposeCounts[purpose] || 0) + 1;
    });

    const sceneTimingContext = scenes.map((scene, idx) => {
        const sceneDuration = scene.endTime - scene.startTime;
        return `Scene ${idx + 1}: ${sceneDuration.toFixed(1)}s (${scene.startTime}s-${scene.endTime}s) - Purpose: ${scene.purpose || 'N/A'}`;
    }).join('\n');

    // Gaps between consecutive scenes, so the model cites measured dead air
    // instead of estimating it.
    const gaps = scenes
        .map((scene, idx) => {
            const next = scenes[idx + 1];
            if (!next) return null;
            const gap = next.startTime - scene.endTime;
            if (gap <= 0.5) return null;
            return `- ${gap.toFixed(2)}s gap between scene ${idx + 1} (ends ${scene.endTime}s) and scene ${idx + 2} (starts ${next.startTime}s)`;
        })
        .filter(Boolean);

    return runFeedbackAnalyzer({
        feature: 'pacing',
        schemaName: 'pacing_analysis',
        jsonSchema: analyzerJsonSchema,
        systemPrompt: JSON_SYSTEM,
        ragQuery: sceneTimingContext,
        ragTopics: ['pacing', 'general'],
        scenes,
        rawTranscript,
        duration: duration ?? totalDuration,
        videoId,
        buildPrompt: ({ scenesBlock, transcriptBlock, ragContext }) => `
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

MEASURED GAPS BETWEEN SCENES:
${gaps.length > 0 ? gaps.join('\n') : '- No gaps over 0.5s between scenes'}

SCENE TIMING:
${sceneTimingContext}

PURPOSE DISTRIBUTION:
${Object.entries(purposeCounts).map(([purpose, count]) => `- ${purpose}: ${count} scene(s)`).join('\n')}

TRANSCRIPT (verbatim, with timestamps — use it to locate filler words and dead air):
${transcriptBlock}

SCENE DETAIL:
${scenesBlock}

TASK:
1. Rate pacing as Weak, Medium, or Strong (score 0-100: Weak 1-40, Medium 41-70, Strong 71-100) based on transition speed and rhythm, variety in scene lengths, whether pacing matches content type, and retention potential.
2. Provide concise reasoning (1-2 sentences).
3. suggestions: up to two short headlines naming the concrete change.
4. frameFeedback: one item per pacing problem. Use fix.type "cut" or "trim" and put the explicit instruction in fix.after with real times, for example "cut 00:00:04.200-00:00:06.300 (2.1s) so the value prop lands at 00:00:04.200". Quote the filler speech in fix.before when the problem is spoken filler. Cite measured durations from the metrics above in observed — never estimate.
5. scriptRewrites: when a line is slow because of how it is worded, quote it verbatim and supply the tighter line. Otherwise return an empty array.
`,
    });
};
