import { User } from "../model/user.model.js";
import { ApiError } from "../utils/ApiError.js";
import { OAUTH_PROVIDERS } from "../constants.js";
import {
    normalizeEmail,
    findOtherUserWithEmail,
    startEmailChange,
    cancelEmailChange,
    revokeOtherRefreshSessions,
    NO_PENDING_EMAIL_CHANGE,
    PASSWORD_MAX_LENGTH
} from "./auth.service.js";

const PROFILE_FIELDS = "-password -refreshToken -emailVerificationToken";
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;

/** Unexpected errors: log the detail, answer with a generic message (never the raw internal error). */
const toApiError = (error, context, publicMessage) => {
    if (error instanceof ApiError) return error;
    console.error(`[Profile] ${context} failed:`, error?.message || error);
    return new ApiError(500, publicMessage);
};

/**
 * Get user profile service
 * Fetches user profile data excluding sensitive information
 */
export const getUserProfileService = async (userId) => {
    try {
        if (!userId) {
            throw new ApiError(400, "User ID is required.");
        }

        const user = await User.findById(userId).select(PROFILE_FIELDS).lean();

        if (!user) {
            throw new ApiError(404, "User not found.");
        }

        return user;
    } catch (error) {
        throw toApiError(error, "Fetch profile", "Failed to fetch user profile.");
    }
};

/**
 * Update user profile service
 * The name changes right away. A new email does NOT: it is stored as pendingEmail and only replaces the
 * current email once the link sent to the new inbox is opened (auth.service confirmEmailChangeService).
 * Changing the email needs the current password when the account has one. Sending the current email
 * again cancels a pending change.
 * Returns { user, emailChange } where emailChange is { pendingEmail, expiresAt } or null.
 */
export const updateUserProfileService = async (userId, name, email, currentPassword) => {
    try {
        if (!userId) {
            throw new ApiError(400, "User ID is required.");
        }

        if (!name || !email) {
            throw new ApiError(400, "Name and email are required.");
        }
        if (typeof name !== 'string' || typeof email !== 'string') {
            throw new ApiError(400, "Name and email must be text.");
        }
        if (!name.trim()) {
            throw new ApiError(400, "Name and email are required.");
        }

        const newEmail = normalizeEmail(email);
        if (newEmail.length > MAX_EMAIL_LENGTH || !EMAIL_FORMAT.test(newEmail)) {
            throw new ApiError(400, "Invalid email format.");
        }

        const user = await User.findById(userId);

        if (!user) {
            throw new ApiError(404, "User not found.");
        }

        const emailChanging = user.email !== newEmail;
        let emailChange = null;

        if (emailChanging) {
            // Prevent email updates for Google OAuth users
            if (user.provider === OAUTH_PROVIDERS.GOOGLE) {
                throw new ApiError(403, "Email cannot be changed for Google accounts. Email is managed by Google.");
            }

            if (user.password) {
                if (typeof currentPassword !== 'string' || !currentPassword) {
                    throw new ApiError(400, "Enter your current password to change your email.");
                }
                if (!(await user.comparePassword(currentPassword))) {
                    throw new ApiError(401, "Current password is incorrect.");
                }
            }

            if (await findOtherUserWithEmail(newEmail, user._id)) {
                throw new ApiError(409, "An account with this email already exists.");
            }

            emailChange = await startEmailChange(user, newEmail);
        } else if (user.pendingEmail) {
            await cancelEmailChange(user._id);
        }

        user.name = name.trim();
        await user.save();

        // Return user without sensitive data
        const updatedUser = await User.findById(userId).select(PROFILE_FIELDS).lean();

        return { user: updatedUser, emailChange };
    } catch (error) {
        throw toApiError(error, "Update profile", "Failed to update user profile.");
    }
};

/**
 * Update user password service
 * Updates password for local users only. Every other device is signed out (the device presenting
 * `keepRefreshToken` stays signed in), and any unconfirmed email change or reset link is cancelled.
 */
export const updateUserPasswordService = async (userId, currentPassword, newPassword, confirmPassword, keepRefreshToken) => {
    try {
        if (!userId) {
            throw new ApiError(400, "User ID is required.");
        }

        if (!currentPassword || !newPassword || !confirmPassword) {
            throw new ApiError(400, "Current password, new password, and confirm password are required.");
        }

        if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || typeof confirmPassword !== 'string') {
            throw new ApiError(400, "Passwords must be text.");
        }

        if (newPassword !== confirmPassword) {
            throw new ApiError(400, "New password and confirm password do not match.");
        }

        if (newPassword.length < 8) {
            throw new ApiError(400, "Password must be at least 8 characters long.");
        }

        if (newPassword.length > PASSWORD_MAX_LENGTH) {
            throw new ApiError(400, `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);
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

        const currentOk = await user.comparePassword(currentPassword);
        if (!currentOk) {
            throw new ApiError(401, "Current password is incorrect.");
        }

        // Update password (will be hashed by pre-save hook)
        user.password = newPassword;
        user.passwordResetTokenHash = null;
        user.passwordResetExpires = null;
        Object.assign(user, NO_PENDING_EMAIL_CHANGE);
        await user.save();

        await revokeOtherRefreshSessions(user._id, keepRefreshToken);

        return { success: true };
    } catch (error) {
        throw toApiError(error, "Update password", "Failed to update password.");
    }
};

/**
 * Get notification preferences service
 * Returns the authenticated user's email notification preferences
 */
export const getNotificationPreferencesService = async (userId) => {
    try {
        if (!userId) {
            throw new ApiError(400, "User ID is required.");
        }        const user = await User.findById(userId)
            .select("notifyShortsReady notifyExportReady notifyProductUpdates")
            .lean();        if (!user) {
            throw new ApiError(404, "User not found.");
        }

        return {
            notifyShortsReady: user.notifyShortsReady ?? false,
            notifyExportReady: user.notifyExportReady ?? false,
            notifyProductUpdates: user.notifyProductUpdates ?? true
        };
    } catch (error) {
        throw toApiError(error, "Fetch notification preferences", "Failed to fetch notification preferences.");
    }
};/**
 * Update notification preferences service
 * Updates email notification preferences for the authenticated user
 */
export const updateNotificationPreferencesService = async (userId, updates) => {
    try {
        if (!userId) {
            throw new ApiError(400, "User ID is required.");
        }

        if (!updates || typeof updates !== "object") {
            throw new ApiError(400, "No valid fields to update.");
        }

        const allowedFields = ["notifyShortsReady", "notifyExportReady", "notifyProductUpdates"];
        const sanitizedUpdates = {};

        for (const field of allowedFields) {
            if (field in updates && typeof updates[field] === "boolean") {
                sanitizedUpdates[field] = updates[field];
            }
        }

        if (Object.keys(sanitizedUpdates).length === 0) {
            throw new ApiError(400, "No valid fields to update.");
        }

        const user = await User.findByIdAndUpdate(
            userId,
            { $set: sanitizedUpdates },
            { new: true, runValidators: true }
        )
            .select("notifyShortsReady notifyExportReady notifyProductUpdates")
            .lean();

        if (!user) {
            throw new ApiError(404, "User not found.");
        }

        return user;
    } catch (error) {
        throw toApiError(error, "Update notification preferences", "Failed to update notification preferences.");
    }
};
