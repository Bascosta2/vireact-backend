import { Chat } from '../model/chat.model.js';
import { Video } from '../model/video.model.js';
import { ApiError } from '../utils/ApiError.js';
import { ANALYSIS_STATUS } from '../constants.js';
import { KNOWLEDGE_BASE_VECTOR_INDEX } from '../config/index.js';
import { requestChatCompletion } from './openai-response.service.js';
import { checkChatLimit, incrementChatUsage } from './subscription.service.js';

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

    // Check chat message limit before processing
    await checkChatLimit(userId);

    // Verify video belongs to user
    const video = await Video.findOne({ _id: videoId, uploader_id: userId });
    if (!video) {
        throw new ApiError(404, 'Video not found');
    }

    // Find or create chat
    let chat = await Chat.findOne({ videoId, userId });
    
    if (!chat) {
        chat = new Chat({
            videoId,
            userId,
            messages: []
        });
    }

    // Add user message
    const userMessage = {
        text: messageText,
        isUser: true
    };
    
    chat.messages.push(userMessage);

    // Classify user intent
    const intent = await classifyUserIntent(messageText);

    // Generate AI response using OpenAI based on intent
    const aiResponse = await generateAIResponse(messageText, video, intent);

    // Add AI message
    const aiMessage = {
        text: aiResponse,
        isUser: false
    };
    
    chat.messages.push(aiMessage);

    await chat.save();

    // Increment chat usage after AI response is generated
    try {
        await incrementChatUsage(userId);
    } catch (usageError) {
        console.error(`[Chat] Failed to increment chat usage for user ${userId}:`, usageError.message);
    }

    return {
        userMessage,
        aiMessage
    };
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
            messages: [{ role: "user", content: prompt }],
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

// Helper function to generate AI response using OpenAI based on video scenes
async function generateAIResponse(userMessage, video, intent = 'question') {
    const openai = (await import('../lib/openai.js')).default;
    const { KnowledgeBase } = await import('../model/knowledge-base.model.js');

    // Handle non-question intents with appropriate responses
    if (intent === 'greeting') {
        return "Hello! I'm here to help you understand and improve your video. Ask me anything about your video analysis.";
    }

    if (intent === 'thanks' || intent === 'feedback') {
        return "You're welcome! Feel free to ask if you need any more insights about your video.";
    }

    // For 'question' and 'other' intents, provide full analysis
    // Check if video has scenes
    if (!video.scenes || video.scenes.length === 0) {
        return "I'm analyzing your video. Once the scene analysis is complete, I'll be able to provide detailed insights and recommendations.";
    }

    // Format scenes for context
    const scenesContext = video.scenes.map((scene, idx) => 
        `Scene ${idx + 1} (${scene.startTime}s - ${scene.endTime}s):
- Visual: ${scene.visualDescription || 'N/A'}
- Text/Captions: ${scene.onScreenText || 'None'}
- Audio: ${scene.audioSummary || 'N/A'}
- Primary Action: ${scene.primaryAction || 'N/A'}
- Emotional Tone: ${scene.emotionalTone || 'N/A'}
- Purpose: ${scene.purpose || 'N/A'}`
    ).join('\n\n');

    // Get relevant knowledge base chunks based on user message (only for questions)
    let relevantChunks = [];
    if (intent === 'question') {
        try {
            // Generate embedding for the user message
            const embeddingResponse = await openai.embeddings.create({
                model: "text-embedding-3-large",
                input: userMessage
            });

            const messageEmbedding = embeddingResponse.data[0].embedding;

            // Perform vector search to find relevant knowledge base documents
            relevantChunks = await KnowledgeBase.aggregate([
                {
                    $vectorSearch: {
                        index: KNOWLEDGE_BASE_VECTOR_INDEX,
                        queryVector: messageEmbedding,
                        path: "embedding",
                        limit: 10,
                        numCandidates: 100
                    }
                }
            ]);
        } catch (error) {
            console.error('[Chat] Error fetching knowledge base chunks:', error.message);
            // Continue without knowledge base chunks if there's an error
        }
    }

    // Format knowledge base context
    const knowledgeContext = relevantChunks.length > 0
        ? relevantChunks
            .map(
                (c, i) =>
                    `${i + 1}. [${c.metadata.layer.toUpperCase()}] ${c.content}`
            )
            .join("\n")
        : 'No specific knowledge base documents found, but use general video content creation best practices.';

    // Build the prompt based on intent
    let prompt = '';
    let systemPrompt = '';

    if (intent === 'question') {
        prompt = `
You are an expert video content advisor helping a creator improve their short-form social media video.

VIDEO SCENES BREAKDOWN:
${scenesContext}

RELEVANT EXPERT KNOWLEDGE:
${knowledgeContext}

USER QUESTION:
"${userMessage}"

TASK:
Provide a concise, actionable response grounded in the scenes above and the knowledge base. Reference specific scenes when relevant. Keep the response structured in short paragraphs with clear recommendations. Avoid markdown and emojis. Limit to about 180 words.
`;
        systemPrompt = "You are a precise video content advisor. Deliver concise, actionable guidance in plain text. Keep responses under 180 words.";
    } else {
        // For 'other' intent, provide general helpful response
        prompt = `
You are an expert video content advisor helping a creator improve their short-form social media video.

VIDEO SCENES BREAKDOWN:
${scenesContext}

USER MESSAGE:
"${userMessage}"

TASK:
Provide a helpful, concise response. If the message seems unclear, politely ask how you can help with their video analysis. Keep responses brief and professional. Avoid markdown and emojis. Limit to about 100 words.
`;
        systemPrompt = "You are a helpful video content advisor. Provide brief, professional responses in plain text.";
    }

    try {
        return await requestChatCompletion({
            messages: [{ role: "user", content: prompt }],
            temperature: 0.7,
            maxTokens: intent === 'question' ? 700 : 400,
            systemPrompt
        });
    } catch (error) {
        console.error('[Chat] Error generating AI response:', error.message);
        return "I'm having trouble processing your request right now. Please try again in a moment, or rephrase your question.";
    }
}

