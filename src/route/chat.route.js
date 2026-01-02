import { Router } from 'express';
import {
    getChatMessages,
    sendChatMessage
} from '../controller/chat.controller.js';
import { authenticateToken } from '../middleware/auth.js';

const chatRoutes = Router();

// All chat routes require authentication
chatRoutes.use(authenticateToken);

// Get chat messages for a video
chatRoutes.get('/:videoId', getChatMessages);

// Send a chat message
chatRoutes.post('/:videoId', sendChatMessage);

export default chatRoutes;

