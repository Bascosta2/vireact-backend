import {
    getUserProfileService,
    updateUserProfileService,
    updateUserPasswordService
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

        const { name, email } = req.body;

        if (!name || !email) {
            throw new ApiError(400, "Name and email are required.");
        }

        const updatedUser = await updateUserProfileService(
            req.user._id,
            name,
            email
        );

        res.status(200).json(
            ApiResponse.success(
                200,
                "Profile updated successfully",
                { user: updatedUser }
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

        const { newPassword, confirmPassword } = req.body;

        if (!newPassword || !confirmPassword) {
            throw new ApiError(400, "New password and confirm password are required.");
        }

        await updateUserPasswordService(
            req.user._id,
            newPassword,
            confirmPassword
        );

        res.status(200).json(
            ApiResponse.success(
                200,
                "Password updated successfully"
            )
        );
    } catch (error) {
        next(error);
    }
};

