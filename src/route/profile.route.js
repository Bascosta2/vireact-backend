import { Router } from "express";
import { authenticateToken } from "../middleware/auth.js";
import {
    getProfile,
    updateProfile,
    updatePassword
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

export default profileRoutes;

