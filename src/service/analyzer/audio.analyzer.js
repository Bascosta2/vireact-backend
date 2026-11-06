import { runFeedbackAnalyzer, SPECIFICITY_CONTRACT } from "./run-feedback-analyzer.js";
import { analyzerJsonSchema } from "./feedback-schema.js";

const JSON_SYSTEM = [
    "You are an audio analyst for short-form video. You return structured data only.",
    "Audio fixes must name the concrete change at a real timestamp: the sound to add, the level to correct, or the delivery to re-record.",
    SPECIFICITY_CONTRACT,
].join('\n\n');

/**
 * Audio analysis.
 *
 * @param {object[]} scenes
 * @param {{ rawTranscript?: object[], duration?: number, videoId?: string }} [context]
 */
export const analyzeAudio = async (scenes, context = {}) => {
    if (!scenes || scenes.length === 0) {
        throw new Error('Scenes are required for audio analysis');
    }

    const { rawTranscript = [], duration, videoId } = context;

    let audioContexts = scenes
        .map((scene, idx) => {
            const audio = scene.audioSummary || '';
            if (!audio || audio.trim() === '' || audio.toLowerCase() === 'none' || audio.toLowerCase() === 'n/a') {
                return null;
            }
            return `Scene ${idx + 1} (${scene.startTime}s-${scene.endTime}s): ${audio}`;
        })
        .filter(Boolean);

    // Fallback: captions imply spoken audio even when the scene summary omits it.
    if (audioContexts.length === 0) {
        audioContexts = scenes
            .map((scene, idx) => {
                const text = scene.onScreenText || '';
                if (text && text.trim() !== '' && text.toLowerCase() !== 'none' && text.toLowerCase() !== 'n/a') {
                    return `Scene ${idx + 1} (${scene.startTime}s-${scene.endTime}s): "${text}" (spoken dialogue/captions)`;
                }
                return null;
            })
            .filter(Boolean);
    }

    const scenesWithAudio = audioContexts.length;
    const scenesWithoutAudio = scenes.length - scenesWithAudio;
    const hasAudio = scenesWithAudio > 0;
    const audioContext = hasAudio
        ? audioContexts.join('\n')
        : 'No audio content detected in any scene.';

    return runFeedbackAnalyzer({
        feature: 'audio',
        schemaName: 'audio_analysis',
        jsonSchema: analyzerJsonSchema,
        systemPrompt: JSON_SYSTEM,
        ragQuery: hasAudio ? audioContext : 'short-form video with no audio track',
        ragTopics: ['audio', 'general'],
        scenes,
        rawTranscript,
        duration,
        videoId,
        buildPrompt: ({ scenesBlock, transcriptBlock, ragContext }) => `
You are a strict short-form video editor reviewing one creator's video. You give exact, timestamped instructions, never general tips.

REFERENCE NOTES (your private playbook. Apply them; never mention them, their author or that they exist):
${ragContext}

Analyze the audio elements in this short-form social media video.

AUDIO CONTENT:
${audioContext}

AUDIO COVERAGE:
- Scenes with audio: ${scenesWithAudio} out of ${scenes.length}
- Scenes without audio: ${scenesWithoutAudio}

TRANSCRIPT (verbatim, with timestamps, use it to locate silence, filler, and low-energy delivery):
${transcriptBlock}

SCENE DETAIL:
${scenesBlock}

TASK:
1. Rate audio effectiveness as Weak, Medium, or Strong (score 0-100: Weak 1-40, Medium 41-70, Strong 71-100) based on presence and coverage, variety (music, voiceover, effects), synchronization with visuals, and contribution to emotional tone.
   ${hasAudio ? '' : 'No audio was detected, score accordingly and treat each silent stretch as a concrete opportunity.'}
2. reasoning: one or two short sentences saying what is wrong, at which seconds, and why viewers leave there. No praise, no filler.
3. suggestions: exactly two. Each is one complete instruction the creator can do in their editor today: start with the time range (for example "0:00-0:02:"), then the exact action, then the exact words, on-screen text or cut. Example: "0:00-0:02: put 'I surfed under this pier at 6am' in bold white text across the top third." Never a generic tip like "add an engaging overlay".
4. frameFeedback: one item per audio problem at the exact range. Use fix.type "add_sound" with fix.after naming the specific sound and its placement (for example "add a low whoosh transition at 00:00:03.900 under the cut"; fix.before may be null). Use "reshoot_note" for delivery problems, stating exactly what to change in the re-record. Cite the silent or low-energy range measured from the data above in observed.
5. scriptRewrites: only when the words themselves cause the audio problem (for example a flat, list-like line). Otherwise return an empty array.
`,
    });
};
