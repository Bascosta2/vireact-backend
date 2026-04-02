import { Router } from "express";
import { authenticateToken } from "../middleware/auth.js";
import {
    getProfile,
    updateProfile,
    updatePassword,
    getNotificationPreferences,
    updateNotificationPreferences
} from "../controller/profile.controller.js";

const profileRoutes = Router();

// All profile routes require authentication
profileRoutes.use(authenticateToken);

// Get user profile
profileRoutes.get("/", getProfile);

// Update user profile (name and email)
profileRoutes.patch("/", updateProfile);

// Update user password
profileRoutes.patch("/password", updatePassword);

// Notification preferences
profileRoutes.get("/notification-preferences", getNotificationPreferences);
profileRoutes.patch("/notification-preferences", updateNotificationPreferences);

export default profileRoutes;

