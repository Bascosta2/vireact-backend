import {
    getUserProfileService,
    updateUserProfileService,
    updateUserPasswordService,
    getNotificationPreferencesService,
    updateNotificationPreferencesService
} from "../service/profile.service.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";

/**
 * Get user profile controller
 * Returns the authenticated user's profile data
 */
export const getProfile = async (req, res, next) => {
    try {
        if (!req.user || !req.user._id) {
            throw new ApiError(401, "Authentication required.");
        }

        const user = await getUserProfileService(req.user._id);

        res.status(200).json(
            ApiResponse.success(
                200,
                "Profile fetched successfully",
                { user }
            )
        );
    } catch (error) {
        next(error);
    }
};

/**
 * Update user profile controller
 * Updates name and email for the authenticated user
 */
export const updateProfile = async (req, res, next) => {
    try {
        if (!req.user || !req.user._id) {
            throw new ApiError(401, "Authentication required.");
        }

        const { name, email, currentPassword } = req.body ?? {};

        if (!name || !email) {
            throw new ApiError(400, "Name and email are required.");
        }

        const { user, emailChange } = await updateUserProfileService(
            req.user._id,
            name,
            email,
            currentPassword
        );

        // A new email is not applied yet: the frontend shows "confirm your new email" while emailChange is set.
        const message = emailChange
            ? "Profile updated. Open the link we sent to your new email to finish changing it."
            : "Profile updated successfully";

        res.status(200).json(
            ApiResponse.success(
                200,
                message,
                { user, emailChange }
            )
        );
    } catch (error) {
        next(error);
    }
};

/**
 * Update user password controller
 * Updates password for local users only
 */
export const updatePassword = async (req, res, next) => {
    try {
        if (!req.user || !req.user._id) {
            throw new ApiError(401, "Authentication required.");
        }

        const { currentPassword, newPassword, confirmPassword } = req.body ?? {};

        if (!currentPassword || !newPassword || !confirmPassword) {
            throw new ApiError(400, "Current password, new password, and confirm password are required.");
        }

        // This device stays signed in; every other device is signed out.
        await updateUserPasswordService(
            req.user._id,
            currentPassword,
            newPassword,
            confirmPassword,
            req.cookies?.refreshToken || req.body?.refreshToken
        );

        res.status(200).json(
            ApiResponse.success(
                200,
                "Password updated. Other devices have been signed out."
            )
        );
    } catch (error) {
        next(error);
    }
};

/**
 * Get notification preferences controller
 * Returns the authenticated user's email notification preferences
 */
export const getNotificationPreferences = async (req, res, next) => {
    try {
        if (!req.user || !req.user._id) {
            throw new ApiError(401, "Authentication required.");
        }

        const preferences = await getNotificationPreferencesService(req.user._id);

        res.status(200).json(
            ApiResponse.success(
                200,
                "Notification preferences fetched successfully",
                preferences
            )
        );
    } catch (error) {
        next(error);
    }
};

/**
 * Update notification preferences controller
 * Updates email notification preferences for the authenticated user
 */
export const updateNotificationPreferences = async (req, res, next) => {
    try {
        if (!req.user || !req.user._id) {
            throw new ApiError(401, "Authentication required.");
        }

        const updates = req.body;
        const preferences = await updateNotificationPreferencesService(req.user._id, updates);

        res.status(200).json(
            ApiResponse.success(
                200,
                "Notification preferences updated successfully",
                preferences
            )
        );
    } catch (error) {
        next(error);
    }
};
