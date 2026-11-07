import { getChatMessagesService, sendChatMessageService } from '../service/chat.service.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { withAiContext, newTraceId } from '../lib/ai-tracking.js';

export const getChatMessages = async (req, res, next) => {
    try {
        const { videoId } = req.params;
        const userId = req.user._id;

        if (!videoId) {
            throw new ApiError(400, 'Video ID is required');
        }

        const messages = await getChatMessagesService(videoId, userId);

        res.status(200).json(
            ApiResponse.success(
                200,
                'Chat messages retrieved successfully',
                { messages }
            )
        );
    } catch (error) {
        next(error);
    }
};

export const sendChatMessage = async (req, res, next) => {
    try {
        const { videoId } = req.params;
        const { text } = req.body;
        const userId = req.user._id;

        if (!videoId) {
            throw new ApiError(400, 'Video ID is required');
        }

        if (typeof text !== 'string' || !text.trim()) {
            throw new ApiError(400, 'Message text is required');
        }
        if (text.length > 2000) {
            throw new ApiError(400, 'Message too long (max 2000 characters)');
        }

        // One trace per message; all messages about this video form one AI session (lib/ai-tracking.js).
        const { userMessage, aiMessage } = await withAiContext(
            { feature: 'chat', videoId, userId, distinctId: userId, traceId: newTraceId('chat'), sessionId: `chat-${videoId}-${userId}` },
            () => sendChatMessageService(videoId, userId, text.trim())
        );

        res.status(200).json(
            ApiResponse.success(
                200,
                'Message sent successfully',
                { userMessage, aiMessage }
            )
        );
    } catch (error) {
        next(error);
    }
};

