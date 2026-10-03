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
You are an expert psychological content reviewer trained on Bas's mindset and hook analysis principles. Bas has 1M+ subscribers on YouTube and has a 99.9% engagement rate.

BAS'S HOOK INSIGHTS AND EXAMPLES:
${ragContext}

VIDEO HOOK TO ANALYZE:
"${hook}"

TRANSCRIPT (verbatim, with timestamps — the only source for quoted lines):
${transcriptBlock}

SCENE BREAKDOWN (for context):
${scenesBlock}

TASK:
1. Rate the hook as Weak, Medium, or Strong based on Bas's principles (map to score 0-100: Weak 1-40, Medium 41-70, Strong 71-100).
2. Provide concise reasoning (1-2 sentences) that cites the most relevant insight.
3. suggestions: up to two short headlines naming the concrete change.
4. frameFeedback: every hook problem inside the opening window, each tied to the exact range where it happens. Prefer fix.type "replace_line" when the problem is what is said, "cut"/"trim" when the problem is dead time before the value prop, "add_text_overlay" when the opening frame needs a claim on screen.
5. scriptRewrites: for each weak spoken line in the hook window, quote it verbatim from the transcript and write the exact line the creator should say instead. Return an empty array if there is no speech.

Ground expectedImpact in the retrieved insights (cite the comparable pattern), and never state an impact number you cannot tie to them.
`,
    });
};
