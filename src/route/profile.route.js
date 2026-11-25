import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { authenticateToken } from "../middleware/auth.js";
import {
    getProfile,
    updateProfile,
    updatePassword,
    getNotificationPreferences,
    updateNotificationPreferences
} from "../controller/profile.controller.js";

const profileRoutes = Router();

/**
 * Password checks and email-change emails: 10 tries per account per 15 minutes (from any network), so a
 * stolen session cannot guess the current password or flood inboxes. Runs after authenticateToken (req.user set).
 */
const credentialChangeLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req.user?._id ? `user:${req.user._id}` : ipKeyGenerator(req.ip || req.socket?.remoteAddress || '')),
    message: { success: false, statusCode: 429, message: 'Too many attempts. Try again in 15 minutes.', data: { code: 'PROFILE_RATE_LIMIT' } },
});

// All profile routes require authentication
profileRoutes.use(authenticateToken);

// Get user profile
profileRoutes.get("/", getProfile);

// Update user profile (name now; a new email waits for confirmation from the new inbox)
profileRoutes.patch("/", credentialChangeLimit, updateProfile);

// Update user password (signs out every other device)
profileRoutes.patch("/password", credentialChangeLimit, updatePassword);

// Notification preferences
profileRoutes.get("/notification-preferences", getNotificationPreferences);
profileRoutes.patch("/notification-preferences", updateNotificationPreferences);

export default profileRoutes;

