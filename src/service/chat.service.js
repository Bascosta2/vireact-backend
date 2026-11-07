import { Chat } from '../model/chat.model.js';
import { Video } from '../model/video.model.js';
import { ApiError } from '../utils/ApiError.js';
import { ANALYSIS_STATUS, SUBSCRIPTION_PLANS, allowedFeaturesForPlan } from '../constants.js';
import { requestChatCompletion } from './openai-response.service.js';
import {
    claimChatMessageSlot,
    releaseChatMessageSlot,
    getOrCreateSubscription,
} from './subscription.service.js';
import { buildTranscriptBlock, transcriptToPlainText } from './transcript.service.js';
import { retrieveKnowledge, formatKnowledgeContext } from './analyzer/retrieve-knowledge.js';
import { SPECIFICITY_CONTRACT } from './analyzer/run-feedback-analyzer.js';
import { cleanUserFacing, cleanUserText, retimeForDuration } from './analyzer/voice.js';
import { displayViewBand } from './view-prediction.service.js';
import { runValidatedStructuredCompletion } from './analyzer/validated-completion.js';
import {
    chatResponseJsonSchema,
    normalizeFrameFeedback,
    normalizeScriptRewrite,
    buildChatFixId,
    formatTimecode,
    severityToLegacy,
} from './analyzer/feedback-schema.js';

export const getChatMessagesService = async (videoId, userId) => {
    if (!videoId || !userId) {
        throw new ApiError(400, 'Video ID and User ID are required');
    }

    // Verify video belongs to user
    const video = await Video.findOne({ _id: videoId, uploader_id: userId });
    if (!video) {
        throw new ApiError(404, 'Video not found');
    }

    // Find or create chat
    let chat = await Chat.findOne({ videoId, userId });
    const isNewChat = !chat;

    if (!chat) {
        chat = new Chat({
            videoId,
            userId,
            messages: []
        });
    }

    // If this is a new chat and video analysis is completed, add initial scenes summary
    if (isNewChat && video.analysisStatus === ANALYSIS_STATUS.COMPLETED && video.scenes && video.scenes.length > 0) {
        const initialMessage = buildInitialAnalysisMessage(video);
        chat.messages.push({
            text: initialMessage,
            isUser: false
        });
        await chat.save();
    }

    return chat.messages || [];
};

// Helper to build initial analysis message from video.analysis array
function buildInitialAnalysisMessage(video) {
    const parts = [];
    const sceneCount = video.scenes ? video.scenes.length : 0;
    const analysisArray = video.analysis || [];

    parts.push("Video analysis complete.");
    parts.push("");
    parts.push("Summary:");

    // Check what features were analyzed
    const analyzedFeatures = analysisArray.map(a => a.feature);
    const hasHook = analyzedFeatures.includes('hook');

    parts.push(
        hasHook
            ? "- Hook analysis completed."
            : "- Hook analysis not available."
    );
    parts.push(
        sceneCount > 0
            ? `- Structure review: ${sceneCount} scene${sceneCount === 1 ? "" : "s"} detected.`
            : "- Structure review: no scenes detected."
    );

    const feedbackCount = (video.timestampFeedback || []).length;
    const rewriteCount = (video.scriptRewrites || []).length;
    if (feedbackCount > 0) {
        parts.push(`- Frame-level fixes: ${feedbackCount} timestamped issue${feedbackCount === 1 ? "" : "s"} with drop-in fixes.`);
    }
    if (rewriteCount > 0) {
        parts.push(`- Script rewrites: ${rewriteCount} line${rewriteCount === 1 ? "" : "s"} rewritten verbatim.`);
    }

    if (sceneCount > 0) {
        parts.push("");
        parts.push("Scene overview:");
        video.scenes.slice(0, 5).forEach((scene) => {
            parts.push(
                `- Scene ${scene.sceneNumber}: ${scene.visualDescription || 'No description'}`
            );
        });
        if (sceneCount > 5) {
            parts.push(`- ...${sceneCount - 5} additional scene${sceneCount - 5 === 1 ? "" : "s"}.`);
        }
    }

    // Add analysis details if available
    if (analysisArray.length > 0) {
        parts.push("");
        parts.push("Analysis details:");
        analysisArray.forEach((analysis) => {
            const featureLabels = {
                hook: 'Hook',
                caption: 'Caption',
                pacing: 'Pacing',
                audio: 'Audio',
                advanced_analytics: 'Advanced analytics',
                views_predictor: 'Views predictor'
            };
            const label = featureLabels[analysis.feature] || analysis.feature;
            const partsSummary = [];

            if (analysis.rating) {
                partsSummary.push(`Rating: ${analysis.rating}`);
            }
            if (partsSummary.length > 0) {
                parts.push(`- ${label}: ${partsSummary.join(' — ')}`);
            }
        });
    }

    parts.push("");
    parts.push("Detailed insights follow below.");
    return parts.join('\n');
}

export const sendChatMessageService = async (videoId, userId, messageText) => {
    if (!videoId || !userId || !messageText) {
        throw new ApiError(400, 'Video ID, User ID, and message text are required');
    }

    // Verify video belongs to user
    const video = await Video.findOne({ _id: videoId, uploader_id: userId });
    if (!video) {
        throw new ApiError(404, 'Video not found');
    }

    await claimChatMessageSlot(userId);

    try {
        // CHANGED: 2026-09 — chat no longer lazily generates feedback. The analyzers
        // author `timestampFeedback` during the analysis job; generating a second
        // heuristic set here would compete with them and reintroduce vague prose.
        // Videos analyzed before that change ground on `timestampFeedbackLegacy`.

        // Plan gating: Advanced Analytics feedback must not reach Free/Premium
        // through the chatbot, matching the video DTO. A subscription read failure
        // falls back to the Free allowed set (least privilege).
        let userPlan = SUBSCRIPTION_PLANS.FREE;
        try {
            const subscription = await getOrCreateSubscription(userId);
            if (subscription?.plan) userPlan = subscription.plan;
        } catch {
            /* least-privilege default */
        }
        const canSeeAdvanced = allowedFeaturesForPlan(userPlan).includes('advanced_analytics');

        let chat = await Chat.findOne({ videoId, userId });

        if (!chat) {
            chat = new Chat({
                videoId,
                userId,
                messages: []
            });
        }

        const userMessage = {
            text: messageText,
            isUser: true
        };

        chat.messages.push(userMessage);

        const intent = await classifyUserIntent(messageText);

        const priorMessages = (chat.messages || []).slice(0, -1);
        const aiMessage = await generateAIResponse(messageText, video, intent, priorMessages, { canSeeAdvanced });

        chat.messages.push(aiMessage);

        await chat.save();

        return {
            userMessage,
            aiMessage
        };
    } catch (err) {
        try {
            await releaseChatMessageSlot(userId);
        } catch {
            /* ignore */
        }
        throw err;
    }
};

// Helper function to classify user intent
async function classifyUserIntent(userMessage) {
    const prompt = `
Classify the following user message into one of these categories:
- question: User is asking for information, advice, or analysis
- greeting: User is saying hello, hi, or similar greetings
- thanks: User is thanking or expressing gratitude
- feedback: User is providing feedback or comments about the analysis
- other: Anything else that doesn't fit the above categories

User message: "${userMessage}"

Respond with ONLY the category name (question, greeting, thanks, feedback, or other), nothing else.
`;

    try {
        const response = await requestChatCompletion({
            label: 'chat_intent',
            messages: [{ role: "user", content: prompt }],
            role: 'classifier',
            temperature: 0.1,
            maxTokens: 20,
            systemPrompt: "You are an intent classifier. Return only the category name."
        });

        const intent = response.trim().toLowerCase();
        const validIntents = ['question', 'greeting', 'thanks', 'feedback', 'other'];
        return validIntents.includes(intent) ? intent : 'other';
    } catch (error) {
        console.error('[Chat] Error classifying intent:', error.message);
        return 'other';
    }
}

function buildNumericScoresBlock(video) {
    const parts = [];
    if (video.viralityScore != null) parts.push(`Virality Score: ${video.viralityScore}/100`);
    const analysis = video.analysis || [];
    const featureLabels = { hook: 'Hook', caption: 'Caption', pacing: 'Pacing', audio: 'Audio', advanced_analytics: 'Advanced', views_predictor: 'Views' };
    analysis.forEach(a => {
        const label = featureLabels[a.feature] || a.feature;
        const score = a.score != null ? a.score : (a.rating ? (a.rating.toLowerCase().includes('strong') || a.rating.toLowerCase().includes('high') ? 85 : a.rating.toLowerCase().includes('medium') ? 55 : 25) : null);
        if (score != null) parts.push(`${label}: ${score}/100`);
    });
    // Same ceiling the report shows, so chat never quotes an uncalibrated (inflated) band.
    const views = displayViewBand(video);
    const fmtViews = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
    if (views.low != null && views.high != null) {
        parts.push(`Predicted views: ${fmtViews(views.low)} - ${fmtViews(views.high)}`);
        if (views.expected != null) parts.push(`Expected: ~${fmtViews(views.expected)}`);
    }
    const curve = video.retentionCurve || [];
    if (curve.length > 0) {
        const first = curve[0];
        const mid = curve[Math.floor(curve.length / 2)];
        const last = curve[curve.length - 1];
        parts.push(`Retention: start ${first}%, mid ${mid}%, end ${last}%`);
    }
    return parts.length > 0 ? 'VIDEO SCORES AND METRICS:\n' + parts.join('\n') + '\n\n' : '';
}

/**
 * Stored frame feedback, rendered with ids so the model can cite an existing item
 * instead of re-deriving it. Advanced Analytics items are filtered out for plans
 * that cannot see them.
 */
function buildStoredFeedbackBlock(video, canSeeAdvanced) {
    const items = (video.timestampFeedback || [])
        .filter((item) => canSeeAdvanced || item.sourceFeature !== 'advanced_analytics');

    if (items.length === 0) {
        const legacy = video.timestampFeedbackLegacy || [];
        if (legacy.length === 0) {
            return 'STORED FRAME FEEDBACK: none. Do not claim feedback exists that is not listed here.\n\n';
        }
        const legacyLines = legacy.map((item, index) => {
            const range = item.endTimestamp ? `${item.timestamp}s-${item.endTimestamp}s` : `${item.timestamp}s`;
            return `- [legacy] ${range} [${item.category}] ${item.issue} Suggested: ${item.suggestion}`;
        });
        return [
            'STORED FRAME FEEDBACK (legacy, generated before frame-level fixes shipped — directional only, not verified against frames):',
            ...legacyLines,
            '',
            '',
        ].join('\n');
    }

    const lines = items.map((item) => [
        `- id=${item.id} | ${formatTimecode(item.tStart)}-${formatTimecode(item.tEnd)} (${item.tStart}s-${item.tEnd}s)`,
        `  category=${item.category} severity=${item.severity}/5 (${severityToLegacy(item.severity)})`,
        `  observed: ${item.observed}`,
        `  issue: ${item.issue}`,
        `  fix(${item.fix?.type}): before="${item.fix?.before ?? ''}" after="${item.fix?.after ?? ''}"`,
        item.expectedImpact ? `  expectedImpact: ${item.expectedImpact}` : null,
    ].filter(Boolean).join('\n'));

    return `STORED FRAME FEEDBACK (cite these ids in citedFeedbackIds when you reference them):\n${lines.join('\n')}\n\n`;
}

/** Stored script rewrites with their lineIds, for citation. */
function buildStoredRewritesBlock(video, canSeeAdvanced) {
    const items = (video.scriptRewrites || [])
        .filter((item) => canSeeAdvanced || item.sourceFeature !== 'advanced_analytics');

    if (items.length === 0) {
        return 'STORED SCRIPT REWRITES: none.\n\n';
    }

    const lines = items.map((item) => [
        `- lineId=${item.lineId} | ${formatTimecode(item.timestamp)} (${item.timestamp}s)`,
        `  original: "${item.originalTranscript}"`,
        `  rewritten: "${item.rewrittenLine}"`,
        item.deliveryNote ? `  delivery: ${item.deliveryNote}` : null,
    ].filter(Boolean).join('\n'));

    return `STORED SCRIPT REWRITES (cite these lineIds in citedRewriteIds when you reference them):\n${lines.join('\n')}\n\n`;
}

const CHAT_SYSTEM_PROMPT = [
    "You are Vireact's video analyst. You answer only about the specific video whose data is supplied, using its transcript, scores, frame feedback, and script rewrites.",
    '',
    'Hard rules:',
    '- Ground every claim in the supplied data. Never invent timestamps, quotes, scores, or platform algorithm rules.',
    '- Do not give advice that could apply to any video. If your answer would still be true for a different video, it is not specific enough.',
    '- When the supplied analysis does not cover what the creator asked, set coverage to "not_covered" and say so plainly in the reply (for example: "The analysis does not cover thumbnail performance. It only measures what happens inside the video."). Never fill the gap with plausible generic advice.',
    '- Hedge phrasing ("try to", "consider", "you could", "make it more ___") is banned unless the very next words are the literal replacement.',
    '- Reference stored items by their ids in citedFeedbackIds / citedRewriteIds instead of restating them loosely.',
    '- Plain text only: no markdown, no bullet characters, no emojis, no em dashes. Keep the reply under 140 words.',
    '- Lead with the single most important change for this video. Number the steps when there is more than one.',
    '- Use the RELEVANT EXPERT KNOWLEDGE to decide what to recommend, but never mention it, quote it as a source, or say "examples" or "insights".',
    '',
    SPECIFICITY_CONTRACT,
].join('\n');

/**
 * Generate the assistant message for a chat turn.
 *
 * Returns a persistable message: prose `text` plus structured `fixes`,
 * `scriptRewrites`, `feedbackRefs`, and `coverage`.
 */
async function generateAIResponse(userMessage, video, intent = 'question', priorMessages = [], { canSeeAdvanced = false } = {}) {
    // Cheap short-circuits: no structured call needed, and these are not advice.
    if (intent === 'greeting') {
        return {
            text: "Hello. Ask me about any moment in your video and I'll point to the timestamp and give you the exact fix.",
            isUser: false,
            coverage: 'grounded',
        };
    }

    if (intent === 'thanks' || intent === 'feedback') {
        return {
            text: "Noted. Ask about any timestamp in this video and I'll give you the specific change to make.",
            isUser: false,
            coverage: 'grounded',
        };
    }

    if (!video.scenes || video.scenes.length === 0) {
        return {
            text: "This video has no scene analysis stored yet, so I have nothing specific to reference. Once analysis completes I can point to exact timestamps and fixes.",
            isUser: false,
            coverage: 'not_covered',
        };
    }

    const scenesContext = video.scenes.map((scene, idx) =>
        `Scene ${idx + 1} (${scene.startTime}s - ${scene.endTime}s):
- Visual: ${scene.visualDescription || 'N/A'}
- Text/Captions: ${scene.onScreenText || 'None'}
- Audio: ${scene.audioSummary || 'N/A'}
- Primary Action: ${scene.primaryAction || 'N/A'}
- Emotional Tone: ${scene.emotionalTone || 'N/A'}
- Purpose: ${scene.purpose || 'N/A'}`
    ).join('\n\n');

    const scoresBlock = buildNumericScoresBlock(video);
    const feedbackBlock = buildStoredFeedbackBlock(video, canSeeAdvanced);
    const rewritesBlock = buildStoredRewritesBlock(video, canSeeAdvanced);
    const transcriptBlock = buildTranscriptBlock(video.rawTranscript);
    const transcriptText = transcriptToPlainText(video.rawTranscript);

    const knowledgeDocs = intent === 'question'
        ? await retrieveKnowledge({ query: userMessage })
        : [];
    const knowledgeContext = formatKnowledgeContext(
        knowledgeDocs,
        'No knowledge base documents matched. Ground the answer in this video\'s data only.'
    );

    const prompt = `${scoresBlock}TRANSCRIPT (verbatim, with timestamps; the only source for quoted lines):
${transcriptBlock}

VIDEO SCENES BREAKDOWN:
${scenesContext}

${feedbackBlock}${rewritesBlock}RELEVANT EXPERT KNOWLEDGE:
${knowledgeContext}

CREATOR'S MESSAGE:
"${userMessage}"

TASK:
Answer using this video's data. Reference specific numbers and timestamps. When you propose a change, put it in fixes or scriptRewrites with the literal replacement content, not in prose. If the answer is already covered by a stored item, cite its id instead of duplicating it. If this video's analysis does not contain what was asked, set coverage to "not_covered" and say so in the reply.`;

    const maxHistory = 10;
    const historyMessages = (priorMessages || [])
        .slice(-maxHistory)
        .map((msg) => ({ role: msg.isUser ? 'user' : 'assistant', content: msg.text }));

    try {
        const { payload, frameFeedback, scriptRewrites } = await runValidatedStructuredCompletion({
            messages: [...historyMessages, { role: 'user', content: prompt }],
            schemaName: 'chat_response',
            jsonSchema: chatResponseJsonSchema,
            systemPrompt: CHAT_SYSTEM_PROMPT,
            normalize: (candidate) => normalizeChatPayload(candidate, video),
            scope: 'chat',
            videoId: video._id,
            transcriptText,
            temperature: 0.4,
            maxTokens: 2500,
            role: 'writer',
        });

        const chatDuration = video.duration || video.scenes?.[video.scenes.length - 1]?.endTime;
        const validIds = new Set((video.timestampFeedback || []).map((item) => item.id));
        const validLineIds = new Set((video.scriptRewrites || []).map((item) => item.lineId));

        const feedbackRefs = [
            ...(payload.citedFeedbackIds || []).filter((id) => validIds.has(id)),
            ...(payload.citedRewriteIds || []).filter((id) => validLineIds.has(id)),
        ];

        return {
            text: retimeForDuration(cleanUserText(payload.reply), chatDuration),
            isUser: false,
            feedbackRefs,
            fixes: retimeForDuration(cleanUserFacing(frameFeedback), chatDuration),
            scriptRewrites: retimeForDuration(cleanUserFacing(scriptRewrites), chatDuration),
            coverage: payload.coverage || 'grounded',
        };
    } catch (error) {
        console.error('[Chat] Error generating AI response:', error.message);
        return {
            text: "I couldn't generate a grounded answer just now. Ask again, or name the timestamp you want me to look at.",
            isUser: false,
            coverage: 'not_covered',
        };
    }
}

/** Normalize chat-authored fixes/rewrites; `cfb_` ids mark them as chat-authored. */
function normalizeChatPayload(payload, video) {
    const duration = video.duration || video.scenes?.[video.scenes.length - 1]?.endTime;
    return {
        frameFeedback: (payload?.fixes || [])
            .map((item, index) => normalizeFrameFeedback(item, {
                index,
                sourceFeature: 'chat',
                duration,
                idBuilder: buildChatFixId,
            }))
            .filter(Boolean),
        scriptRewrites: (payload?.scriptRewrites || [])
            .map((item, index) => normalizeScriptRewrite(item, { index, sourceFeature: 'chat', duration }))
            .filter(Boolean),
    };
}
