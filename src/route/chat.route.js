import { Router } from 'express';
import {
    getChatMessages,
    sendChatMessage
} from '../controller/chat.controller.js';
import { authenticateToken } from '../middleware/auth.js';
import { chatPostRateLimit } from '../middleware/chatRateLimit.js';

const chatRoutes = Router();

// All chat routes require authentication
chatRoutes.use(authenticateToken);

// Get chat messages for a video
chatRoutes.get('/:videoId', getChatMessages);

// Send a chat message (rate-limited: OpenAI cost protection)
chatRoutes.post('/:videoId', chatPostRateLimit, sendChatMessage);

export default chatRoutes;

