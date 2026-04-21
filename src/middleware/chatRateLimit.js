import rateLimit from 'express-rate-limit';

/**
 * Per-user + IP limit for POST /chat (OpenAI cost protection). Runs after authenticateToken.
 */
export const chatPostRateLimit = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        const uid = req.user?._id?.toString() || 'anon';
        const ip = req.ip || req.socket?.remoteAddress || '';
        return `${uid}:${ip}`;
    },
    message: { error: 'Too many chat messages, please try again shortly' },
});
