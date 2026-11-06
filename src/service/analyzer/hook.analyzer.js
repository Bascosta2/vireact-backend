import { runFeedbackAnalyzer, SPECIFICITY_CONTRACT } from "./run-feedback-analyzer.js";
import { analyzerJsonSchema } from "./feedback-schema.js";

const JSON_SYSTEM = [
    "You are a hook analyst for short-form video. You return structured data only.",
    "Your value is precision: you name the exact moment, quote what was actually said, and hand the creator the exact replacement line.",
    SPECIFICITY_CONTRACT,
].join('\n\n');

/**
 * Hook analysis. Emits frame-level feedback for the opening window plus literal
 * rewrites of the spoken hook lines.
 *
 * @param {string} hook Hook summary derived from the hook scene
 * @param {object[]} scenes
 * @param {{ rawTranscript?: object[], duration?: number, videoId?: string }} [context]
 */
export const analyzeHook = async (hook, scenes, context = {}) => {
    if (!hook) {
        throw new Error('Hook is required for analysis');
    }

    const { rawTranscript = [], duration, videoId } = context;

    return runFeedbackAnalyzer({
        feature: 'hook',
        schemaName: 'hook_analysis',
        jsonSchema: analyzerJsonSchema,
        systemPrompt: JSON_SYSTEM,
        ragQuery: hook,
        ragTopics: ['hook', 'general'],
        scenes,
        rawTranscript,
        duration,
        videoId,
        buildPrompt: ({ scenesBlock, transcriptBlock, ragContext }) => `
You are a strict short-form video editor reviewing one creator's video. You give exact, timestamped instructions, never general tips.

REFERENCE NOTES (your private playbook. Apply them; never mention them, their author or that they exist):
${ragContext}

VIDEO HOOK TO ANALYZE:
"${hook}"

TRANSCRIPT (verbatim, with timestamps, the only source for quoted lines):
${transcriptBlock}

SCENE BREAKDOWN (for context):
${scenesBlock}

TASK:
1. Rate the hook as Weak, Medium, or Strong against the reference notes (map to score 0-100: Weak 1-40, Medium 41-70, Strong 71-100).
2. reasoning: one or two short sentences saying what is wrong, at which seconds, and why viewers leave there. No praise, no filler.
3. suggestions: exactly two. Each is one complete instruction the creator can do in their editor today: start with the time range (for example "0:00-0:02:"), then the exact action, then the exact words, on-screen text or cut. Example: "0:00-0:02: put 'I surfed under this pier at 6am' in bold white text across the top third." Never a generic tip like "add an engaging overlay".
4. frameFeedback: every hook problem inside the opening window, each tied to the exact range where it happens. Prefer fix.type "replace_line" when the problem is what is said, "cut"/"trim" when the problem is dead time before the value prop, "add_text_overlay" when the opening frame needs a claim on screen.
5. scriptRewrites: for each weak spoken line in the hook window, quote it verbatim from the transcript and write the exact line the creator should say instead. Return an empty array if there is no speech.

Base expectedImpact on the reference notes but write it as a plain outcome for this video (for example "viewers see the payoff 2s sooner"). Never mention where it comes from, and never state a number you cannot back up.
`,
    });
};
