import { runFeedbackAnalyzer, SPECIFICITY_CONTRACT } from "./run-feedback-analyzer.js";
import { analyzerJsonSchema } from "./feedback-schema.js";

const JSON_SYSTEM = [
    "You are a caption and on-screen text analyst for short-form video. You return structured data only.",
    "When text is missing or weak you supply the exact overlay copy, never a description of what the copy should achieve.",
    SPECIFICITY_CONTRACT,
].join('\n\n');

/**
 * Caption / on-screen text analysis.
 *
 * @param {object[]} scenes
 * @param {{ rawTranscript?: object[], duration?: number, videoId?: string }} [context]
 */
export const analyzeCaption = async (scenes, context = {}) => {
    if (!scenes || scenes.length === 0) {
        throw new Error('Scenes are required for caption analysis');
    }

    const { rawTranscript = [], duration, videoId } = context;

    const captions = scenes
        .map((scene, idx) => {
            const text = scene.onScreenText || '';
            if (!text || text.trim() === '') return null;
            return `Scene ${idx + 1} (${scene.startTime}s-${scene.endTime}s): ${text}`;
        })
        .filter(Boolean);

    const hasCaptions = captions.length > 0;
    const captionsContext = hasCaptions
        ? captions.join('\n')
        : 'No on-screen text detected in any scene.';

    return runFeedbackAnalyzer({
        feature: 'caption',
        schemaName: 'caption_analysis',
        jsonSchema: analyzerJsonSchema,
        systemPrompt: JSON_SYSTEM,
        ragQuery: hasCaptions ? captionsContext : 'short-form video with no on-screen text or captions',
        ragTopics: ['caption', 'general'],
        scenes,
        rawTranscript,
        duration,
        videoId,
        buildPrompt: ({ scenesBlock, transcriptBlock, ragContext }) => `
You are a strict short-form video editor reviewing one creator's video. You give exact, timestamped instructions, never general tips.

REFERENCE NOTES (your private playbook. Apply them; never mention them, their author or that they exist):
${ragContext}

Analyze the on-screen text and captions in this short-form social media video.

CAPTIONS DETECTED:
${captionsContext}

TRANSCRIPT (verbatim, with timestamps, use this to write overlay copy that matches what is actually said):
${transcriptBlock}

SCENE BREAKDOWN:
${scenesBlock}

TASK:
1. Rate caption effectiveness as Weak, Medium, or Strong (score 0-100: Weak 1-40, Medium 41-70, Strong 71-100) based on visibility and readability, timing against the spoken audio, whether text adds meaning or merely repeats audio, emphasis of key points, and contribution to clarity.
   ${hasCaptions ? '' : 'No on-screen text was detected, score accordingly and treat every missing-text moment as an opportunity.'}
2. reasoning: one or two short sentences saying what is wrong, at which seconds, and why viewers leave there. No praise, no filler.
3. suggestions: exactly two. Each is one complete instruction the creator can do in their editor today: start with the time range (for example "0:00-0:02:"), then the exact action, then the exact words, on-screen text or cut. Example: "0:00-0:02: put 'I surfed under this pier at 6am' in bold white text across the top third." Never a generic tip like "add an engaging overlay".
4. frameFeedback: one item per caption problem at the exact range where it occurs. Use fix.type "add_text_overlay" with fix.after containing the EXACT overlay copy to put on screen (fix.before may be null). Use "replace_line" with the existing on-screen text quoted in fix.before when text is present but weak. Keep overlay copy short enough to read in the available time.
5. scriptRewrites: only when a spoken line must change for the captions to work; otherwise return an empty array.
`,
    });
};
