import { requestChatCompletion } from './openai-response.service.js';

export const TWELVE_LABS_SCENE_PROMPT = `
Analyze this short-form video in complete detail. You are preparing structured 
data for an AI virality analysis engine that will score hook strength, pacing, 
audio quality, caption clarity, view prediction, and advanced engagement signals.

Your response must contain TWO sections exactly as labeled below.

════════════════════════════════════════
SECTION 1 — OVERALL VIDEO SUMMARY
════════════════════════════════════════

Provide a single structured summary block with these exact fields:

TOTAL_DURATION: [total seconds as a number]
PLATFORM_FORMAT: [TikTok | Instagram Reels | YouTube Shorts | Facebook Reels | Unknown]
VIDEO_CATEGORY: [e.g. Motivation, Comedy, Education, Lifestyle, Fitness, Tech, 
                  Finance, Food, Travel, Gaming, Beauty, News, Storytime, Tutorial]
CREATOR_STYLE: [e.g. talking-head, voiceover-broll, vlog, skit, faceless, 
                slideshow, screen-record, interview, reaction]
HOOK_TYPE: [question | bold-statement | shocking-visual | sound-hook | 
            text-hook | pattern-interrupt | cliffhanger | challenge]
HOOK_STRENGTH: [strong | moderate | weak] — based on first 3 seconds only
OVERALL_PACING: [fast | medium | slow] — average across full video
AUDIO_TYPE: [original-voice | voiceover | music-only | mixed | silent]
CAPTION_PRESENT: [yes | no]
CAPTION_STYLE: [auto-generated | styled-manual | none]
TOTAL_SCENE_COUNT: [number]
ESTIMATED_CUT_FREQUENCY: [cuts per second as decimal, e.g. 0.8]
EMOTIONAL_ARC: [e.g. curiosity → tension → payoff, or neutral → humor → call-to-action]
CALL_TO_ACTION_PRESENT: [yes | no]
CALL_TO_ACTION_TYPE: [follow | like | comment | share | link | none]
CALL_TO_ACTION_TIMESTAMP: [seconds from start, or null]
VIRAL_SIGNALS_DETECTED: [comma-separated list of any present, e.g. 
  trending-audio, text-hook, pattern-interrupt, loop-ending, controversy, 
  relatability, shock-value, transformation, storytelling, humor]
WEAK_SIGNALS_DETECTED: [comma-separated list of any present, e.g.
  slow-open, no-hook, talking-without-cuts, low-energy-audio, 
  poor-caption-timing, dead-air, no-cta, long-intro]

════════════════════════════════════════
SECTION 2 — SCENE BY SCENE BREAKDOWN
════════════════════════════════════════

For every distinct scene or cut in the video, output one block using 
EXACTLY this format. Do not skip any scene. Do not merge scenes. 
Output every scene even if they seem similar.

SCENE: [scene number starting at 1]
START_TIME: [seconds as decimal, e.g. 0.00]
END_TIME: [seconds as decimal, e.g. 2.40]
DURATION: [seconds as decimal]
VISUAL_DESCRIPTION: [1-3 sentences describing exactly what appears on screen — 
  subject, background, movement, text overlays, graphics, transitions. 
  Be specific. Include colors, positioning, camera angle, motion speed.]
ON_SCREEN_TEXT: [exact text visible on screen in this scene, or NONE]
AUDIO_SUMMARY: [describe the audio — spoken words verbatim if possible, 
  music genre/tempo/energy if present, sound effects, silence. 
  If spoken, include the exact words said in this scene.]
SPEAKER_ENERGY: [high | medium | low | none] — based on voice tone and pace
BACKGROUND_MUSIC: [yes | no | unknown]
MUSIC_ENERGY: [hype | energetic | neutral | calm | dramatic | none]
PRIMARY_ACTION: [what the creator or subject is physically doing — 
  e.g. speaking to camera, walking, demonstrating product, 
  showing text slide, cutting to broll, reacting]
EMOTIONAL_TONE: [excited | calm | urgent | humorous | serious | 
                  inspirational | shocking | neutral | sad | angry]
SCENE_PURPOSE: [hook | context | story | demonstration | proof | 
                tension | payoff | cta | filler | transition | loop-setup]
PACING_SCORE: [1-10 where 10 = extremely fast cuts and high energy, 
               1 = very slow, static, low energy]
RETENTION_RISK: [high | medium | low] — likelihood viewers drop off during this scene
RETENTION_RISK_REASON: [one sentence explaining why, e.g. 
  "Speaker pauses for 1.2s with no visual change — dropout risk" or
  "Fast cut with new visual stimulus keeps attention"]
CAPTION_TIMING_QUALITY: [good | delayed | missing | not-applicable] — 
  does on-screen text appear in sync with audio in this scene?
HOOK_CONTRIBUTION: [yes | no] — does this scene contribute to the opening hook?
VIRAL_ELEMENT: [describe any specific viral or engagement element in this scene, 
  or NONE — e.g. "Surprising reveal", "Relatable reaction face", 
  "Bold on-screen claim", "Jump cut with trending sound"]
`;

function cleanSceneTextValue(val) {
    const cleaned = (val || '').trim();
    const low = cleaned.toLowerCase();
    if (low === 'none' || low === 'n/a' || low === 'null') return '';
    return cleaned;
}

/**
 * Parses SECTION 2 from TWELVE_LABS_SCENE_PROMPT output (SCENE:/START_TIME:/VISUAL_DESCRIPTION:/…).
 */
function parseScenesFromTwelveLabsV2Format(text) {
    const scenes = [];
    if (!text || !/\bSCENE:\s*\d+/i.test(text)) return scenes;

    const blocks = text
        .split(/\r?\n(?=SCENE:\s*\d+\b)/i)
        .map((b) => b.trim())
        .filter(Boolean);

    const extractLabeledField = (block, label) => {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp(`^${escaped}:\\s*`, 'im');
        const m = re.exec(block);
        if (!m) return '';
        const rest = block.slice(m.index + m[0].length);
        const nextIdx = rest.search(/\r?\n(?=[A-Z][A-Z_0-9]*:\s*)/);
        const raw = (nextIdx === -1 ? rest : rest.slice(0, nextIdx)).trim();
        return cleanSceneTextValue(raw);
    };

    for (const block of blocks) {
        if (!/^SCENE:\s*\d+/im.test(block)) continue;
        const numMatch = block.match(/^SCENE:\s*(\d+)/im);
        if (!numMatch) continue;
        const sceneNumber = parseInt(numMatch[1], 10);
        const startTime = parseFloat(extractLabeledField(block, 'START_TIME') || '0') || 0;
        const endTime = parseFloat(extractLabeledField(block, 'END_TIME') || '0') || 0;
        const visualDescription = extractLabeledField(block, 'VISUAL_DESCRIPTION');
        const onScreenText = extractLabeledField(block, 'ON_SCREEN_TEXT');
        const audioSummary = extractLabeledField(block, 'AUDIO_SUMMARY');
        const primaryAction = extractLabeledField(block, 'PRIMARY_ACTION');
        const emotionalTone = extractLabeledField(block, 'EMOTIONAL_TONE');
        let purpose = extractLabeledField(block, 'SCENE_PURPOSE');
        if (!purpose) purpose = extractLabeledField(block, 'PURPOSE');

        scenes.push({
            sceneNumber,
            startTime,
            endTime,
            visualDescription,
            onScreenText,
            audioSummary,
            primaryAction,
            emotionalTone,
            purpose,
        });
    }

    return scenes;
}

function extractTextFromAnalysisResult(analysisResult) {
    if (typeof analysisResult === 'string') return analysisResult;
    if (analysisResult?.data) {
        if (typeof analysisResult.data === 'string') return analysisResult.data;
        if (typeof analysisResult.data?.data === 'string') return analysisResult.data.data;
        if (typeof analysisResult.data?.response === 'string') return analysisResult.data.response;
        if (typeof analysisResult.data?.message === 'string') return analysisResult.data.message;
        return JSON.stringify(analysisResult.data);
    }
    if (typeof analysisResult?.response === 'string') return analysisResult.response;
    if (typeof analysisResult?.message === 'string') return analysisResult.message;
    if (typeof analysisResult?.text === 'string') return analysisResult.text;
    return JSON.stringify(analysisResult);
}

export function parseScenesFromAnalysis(analysisResult) {
    const text = extractTextFromAnalysisResult(analysisResult);
    if (!text || !text.trim()) return [];

    const v2Scenes = parseScenesFromTwelveLabsV2Format(text);
    if (v2Scenes.length > 0) return v2Scenes;

    const scenes = [];
    const sceneBlocks = text.split(/(?=\d+\.\s*Scene Number:)/gi);
    for (let i = 0; i < sceneBlocks.length; i++) {
        const block = sceneBlocks[i].trim();
        if (!block) continue;
        const sceneNumMatch = block.match(/Scene Number:\s*(\d+)/i);
        if (!sceneNumMatch) continue;
        const sceneNumber = parseInt(sceneNumMatch[1], 10);
        const extractField = (pattern, defaultValue = '') => {
            const match = block.match(new RegExp(pattern, 'i'));
            if (!match) return defaultValue;
            const value = match[1]?.trim() || defaultValue;
            if (value.toLowerCase() === 'none' || value.toLowerCase() === 'n/a') return '';
            return value;
        };
        scenes.push({
            sceneNumber,
            startTime: parseFloat(extractField(/Start Time:\s*(\d+(?:\.\d+)?)s?/i, '0')) || 0,
            endTime: parseFloat(extractField(/End Time:\s*(\d+(?:\.\d+)?)s?/i, '0')) || 0,
            visualDescription: extractField(/What is Visually Happening:\s*([^\n]+)/i, ''),
            onScreenText: extractField(/On-Screen Text\/Captions:\s*([^\n]+)/i, ''),
            audioSummary: extractField(/Audio\/Speech Summary:\s*([^\n]+)/i, ''),
            primaryAction: extractField(/Primary Action or Hook:\s*([^\n]+)/i, ''),
            emotionalTone: extractField(/Emotional Tone:\s*([^\n]+)/i, ''),
            purpose: extractField(/Purpose of the Scene:\s*([^\n]+)/i, ''),
        });
    }

    if (scenes.length === 0) {
        const simpleRegex = /Scene Number:\s*(\d+)[\s\S]*?Start Time:\s*(\d+(?:\.\d+)?)s?[^\n]*?End Time:\s*(\d+(?:\.\d+)?)s?[^\n]*?What is Visually Happening:\s*([^\n]+)[^\n]*?On-Screen Text\/Captions:\s*([^\n]+)[^\n]*?Audio\/Speech Summary:\s*([^\n]+)[^\n]*?Primary Action or Hook:\s*([^\n]+)[^\n]*?Emotional Tone:\s*([^\n]+)[^\n]*?Purpose of the Scene:\s*([^\n]+)/gi;
        let match;
        let lastIndex = -1;
        while ((match = simpleRegex.exec(text)) !== null) {
            if (match.index === lastIndex) break;
            lastIndex = match.index;
            const cleanValue = (val) => {
                const cleaned = val?.trim() || '';
                return (cleaned.toLowerCase() === 'none' || cleaned.toLowerCase() === 'n/a') ? '' : cleaned;
            };
            scenes.push({
                sceneNumber: parseInt(match[1], 10),
                startTime: parseFloat(match[2]) || 0,
                endTime: parseFloat(match[3]) || 0,
                visualDescription: cleanValue(match[4]),
                onScreenText: cleanValue(match[5]),
                audioSummary: cleanValue(match[6]),
                primaryAction: cleanValue(match[7]),
                emotionalTone: cleanValue(match[8]),
                purpose: cleanValue(match[9]),
            });
        }
    }

    if (scenes.length === 0) {
        const numberedSceneRegex = /(\d+)\.?\s*Scene[^\n]*?Start Time[^\n]*?End Time[^\n]*?([\s\S]*?)(?=\d+\.?\s*Scene|$)/gi;
        let altMatch;
        let sceneNum = 1;
        while ((altMatch = numberedSceneRegex.exec(text)) !== null && sceneNum <= 20) {
            const sceneText = altMatch[2] || altMatch[0];
            const startMatch = sceneText.match(/Start Time[:\s]*(\d+(?:\.\d+)?)s?/i);
            const endMatch = sceneText.match(/End Time[:\s]*(\d+(?:\.\d+)?)s?/i);
            const visualMatch = sceneText.match(/What is Visually Happening[:\s]*([^\n]+)/i);
            const textMatch = sceneText.match(/On-Screen Text\/Captions[:\s]*([^\n]+)/i);
            const audioMatch = sceneText.match(/Audio\/Speech Summary[:\s]*([^\n]+)/i);
            const actionMatch = sceneText.match(/Primary Action[^\n]*[:\s]*([^\n]+)/i);
            const toneMatch = sceneText.match(/Emotional Tone[:\s]*([^\n]+)/i);
            const purposeMatch = sceneText.match(/Purpose of the Scene[:\s]*([^\n]+)/i);
            scenes.push({
                sceneNumber: sceneNum++,
                startTime: startMatch ? parseFloat(startMatch[1]) : 0,
                endTime: endMatch ? parseFloat(endMatch[1]) : 0,
                visualDescription: visualMatch ? visualMatch[1].trim() : '',
                onScreenText: textMatch ? textMatch[1].trim() : '',
                audioSummary: audioMatch ? audioMatch[1].trim() : '',
                primaryAction: actionMatch ? actionMatch[1].trim() : '',
                emotionalTone: toneMatch ? toneMatch[1].trim() : '',
                purpose: purposeMatch ? purposeMatch[1].trim() : '',
            });
        }
    }
    return scenes;
}

export async function parseScenesWithOpenAI(analysisResult) {
    const text = extractTextFromAnalysisResult(analysisResult);
    if (!text || text.trim().length === 0) return [];

    const prompt = `Convert the following video scene analysis into a JSON array. Each scene should have these exact fields:
- sceneNumber (number)
- startTime (number, in seconds)
- endTime (number, in seconds)
- visualDescription (string, or empty string if not provided)
- onScreenText (string, or empty string if "None" or "N/A")
- audioSummary (string, or empty string if "None" or "N/A")
- primaryAction (string, or empty string if not provided)
- emotionalTone (string, or empty string if not provided)
- purpose (string, or empty string if not provided)

If the input uses Twelve Labs style labels, map them: SCENE → sceneNumber, START_TIME → startTime, END_TIME → endTime, VISUAL_DESCRIPTION → visualDescription, ON_SCREEN_TEXT → onScreenText, AUDIO_SUMMARY → audioSummary, PRIMARY_ACTION → primaryAction, EMOTIONAL_TONE → emotionalTone, SCENE_PURPOSE (or PURPOSE) → purpose.

IMPORTANT: For audioSummary field:
- Include ALL audio elements: spoken dialogue, voiceover narration, background music, sound effects
- If on-screen text/captions are present, they often represent spoken words - include this in audioSummary when the source text indicates speech
- Only use empty string if there is truly no audio at all in the scene

Input text:
${text}

Return ONLY a valid JSON array of scenes, no other text. Example format:
[
  {
    "sceneNumber": 1,
    "startTime": 0,
    "endTime": 5,
    "visualDescription": "A man in a red hoodie...",
    "onScreenText": "",
    "audioSummary": "Background music with spoken dialogue",
    "primaryAction": "Offers money",
    "emotionalTone": "humor",
    "purpose": "hook"
  }
]`;

    try {
        const response = await requestChatCompletion({
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            maxTokens: 2000,
            systemPrompt: 'You are a JSON formatter. Return only valid JSON arrays, no markdown, no explanations.',
        });
        let jsonText = response.trim();
        const jsonMatch = jsonText.match(/\[[\s\S]*\]/);
        if (jsonMatch) jsonText = jsonMatch[0];
        const scenes = JSON.parse(jsonText);
        if (Array.isArray(scenes) && scenes.length > 0) return scenes;
    } catch {
        // fallback
    }
    return parseScenesFromAnalysis(analysisResult);
}
