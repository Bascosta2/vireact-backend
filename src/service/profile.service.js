import { User } from "../model/user.model.js";
import { ApiError } from "../utils/ApiError.js";
import { OAUTH_PROVIDERS } from "../constants.js";

/**
 * Get user profile service
 * Fetches user profile data excluding sensitive information
 */
export const getUserProfileService = async (userId) => {
    try {
        if (!userId) {
            throw new ApiError(400, "User ID is required.");
        }

        const user = await User.findById(userId).select("-password -refreshToken").lean();

        if (!user) {
            throw new ApiError(404, "User not found.");
        }

        return user;
    } catch (error) {
        if (error instanceof ApiError) {
            throw error;
        }
        throw new ApiError(500, error?.message || "Failed to fetch user profile.");
    }
};

/**
 * Update user profile service
 * Updates name and email with validation
 */
export const updateUserProfileService = async (userId, name, email) => {
    try {
        if (!userId) {
            throw new ApiError(400, "User ID is required.");
        }

        if (!name || !email) {
            throw new ApiError(400, "Name and email are required.");
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            throw new ApiError(400, "Invalid email format.");
        }

        // Find user
        const user = await User.findById(userId);

        if (!user) {
            throw new ApiError(404, "User not found.");
        }

        // Prevent email updates for Google OAuth users
        if (user.provider === OAUTH_PROVIDERS.GOOGLE && user.email !== email.toLowerCase().trim()) {
            throw new ApiError(403, "Email cannot be changed for Google accounts. Email is managed by Google.");
        }

        // Check if email is being changed
        if (user.email !== email.toLowerCase().trim()) {
            // Check if new email already exists (excluding current user)
            const existingUser = await User.findOne({ 
                email: email.toLowerCase().trim(),
                _id: { $ne: userId }
            });

            if (existingUser) {
                throw new ApiError(409, "An account with this email already exists.");
            }
        }

        // Update user fields
        user.name = name.trim();
        user.email = email.toLowerCase().trim();

        await user.save();

        // Return user without sensitive data
        const updatedUser = await User.findById(userId).select("-password -refreshToken").lean();

        return updatedUser;
    } catch (error) {
        if (error instanceof ApiError) {
            throw error;
        }
        throw new ApiError(500, error?.message || "Failed to update user profile.");
    }
};

/**
 * Update user password service
 * Updates password for local users only
 */
export const updateUserPasswordService = async (userId, newPassword, confirmPassword) => {
    try {
        if (!userId) {
            throw new ApiError(400, "User ID is required.");
        }

        if (!newPassword || !confirmPassword) {
            throw new ApiError(400, "New password and confirm password are required.");
        }

        if (newPassword !== confirmPassword) {
            throw new ApiError(400, "New password and confirm password do not match.");
        }

        if (newPassword.length < 8) {
            throw new ApiError(400, "Password must be at least 8 characters long.");
        }

        // Find user
        const user = await User.findById(userId);

        if (!user) {
            throw new ApiError(404, "User not found.");
        }

        // Check if user is OAuth-based
        if (user.provider !== OAUTH_PROVIDERS.LOCAL) {
            throw new ApiError(403, "Password update is only available for local accounts.");
        }

        // Check if user has a password (should always be true for local users, but double-check)
        if (!user.password) {
            throw new ApiError(400, "User account does not have a password set.");
        }

        // Update password (will be hashed by pre-save hook)
        user.password = newPassword;
        await user.save();

        return { success: true };
    } catch (error) {
        if (error instanceof ApiError) {
            throw error;
        }
        throw new ApiError(500, error?.message || "Failed to update password.");
    }
};

