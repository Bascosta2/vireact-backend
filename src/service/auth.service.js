import { Admin } from "../model/admin.model.js";
import { FRONTEND_URL, ACCESS_TOKEN_SECRET } from "../config/index.js";
import { ApiError } from "../utils/ApiError.js";
import { User } from "../model/user.model.js";
import crypto from "crypto"
import resend from "../lib/resend.js";
import { OAUTH_PROVIDERS } from "../constants.js";
import jwt from "jsonwebtoken";

// Helper function to get user-friendly provider names
const getProviderDisplayName = (provider) => {
    switch (provider) {
        case OAUTH_PROVIDERS.GOOGLE:
            return 'Google';
        case OAUTH_PROVIDERS.LOCAL:
            return 'email/password';
        default:
            return provider;
    }
};


export const generateAccessToken = async (
    userId,
    model,
    userType
) => {
    try {
        const user = await model.findById(userId);

        if (!user) {
            throw new ApiError(404, `${userType} not found while generating access token.`);
        }

        const accessToken = user.generateAccessToken();
        const refreshToken = user.generateRefreshToken();
        
        // Store refresh token in database
        user.refreshToken = refreshToken;
        await user.save({ validateBeforeSave: false });

        return { accessToken, refreshToken };
    } catch (error) {
        throw new ApiError(500, error?.message || `Something went wrong on server, while generating access token for ${userType}.`);
    }
};


// Sign up a new Admin
export const signupAdminService =
    async (name, email, password) => {
        try {
            const existingAdmin = await Admin.findOne({ email });
            if (existingAdmin) {
                throw new ApiError(409, "Admin already exists.");
            }

            const admin = new Admin({
                name,
                email,
                password,
            });

            return await admin.save();
        } catch (error) {
            throw new ApiError(500, error?.message || "Failed to create admin.");
        }
    };
//Login admin by verifying credentials

/*
- Login Admin

1. Get admin name and pass from req body.
2. Check if admin exsists - compare email
3. if admin exsists, compare his pass with pass stored in database.
5. if comparison become false, return error.
4. if comparison become successfull, return access token.
5. Send cookies

*/
export const loginAdminService = async (email, password) => {

    const admin = await Admin.findOne({ email });

    if (!admin) {
        throw new ApiError(404, "Admin Not Found");
    }

    const isPasswordValid = await admin.comparePassword(password);

    if (!isPasswordValid) {
        throw new ApiError(400, "Invalid Password");
    }

    return admin;
};



// Sign up a new user
export const customSignupUserService = async (
    name,
    email,
    password,
    provider
) => {
    try {
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            // Check if user exists with a different provider
            if (existingUser.provider !== provider) {
                const existingProviderName = getProviderDisplayName(existingUser.provider);
                throw new ApiError(409, `This email is already registered via ${existingProviderName}. Please log in with ${existingProviderName} instead.`);
            } else {
                throw new ApiError(409, "An account with this email already exists. Please log in instead.");
            }
        }
        const requireVerification = true;

        let token = null;
        let isEmailVerified = false;

        if (requireVerification) {
            token = crypto.randomBytes(32).toString("hex");
        } else {
            isEmailVerified = true;
        }

        const user = new User({
            name,
            email,
            password,
            provider,
            emailVerificationToken: token,
            isEmailVerified
        });

        const savedUser = await user.save();

        if (requireVerification) {
            const verificationUrl = `${FRONTEND_URL}/verify-email?token=${token}`;

            await resend.emails.send({
                from: 'support@vireact.io',
                to: email,
                subject: 'Verify Your Email',
                html: `<div>
                        <p>Hey ${name}, Welcome to Vireact</p>
                        <p>Please <a href="${verificationUrl}">click here</a> to verify your email.</p>
                        <p>If you didn't request this verification, please ignore this email.</p>
                        <p>Thank you for using Vireact!</p>
                        <p>Best regards,</p>
                        <p>The Vireact Team</p>
                       </div>`
            });
        }

        return savedUser;

    } catch (error) {
        throw new ApiError(500, error?.message || "Failed to create user.");
    }
};



export const verifyEmailService = async (token) => {
    try {
        if (!token) {
            throw new ApiError(400, "Token is missing.");
        }

        const user = await User.findOne({ emailVerificationToken: token });

        if (!user) {
            throw new ApiError(400, "Invalid or expired token.");
        }

        user.isEmailVerified = true;
        user.emailVerificationToken = undefined;

        await user.save({ validateBeforeSave: false });

        return {
            success: true,
            message: "Email verified successfully.",
        };
    } catch (error) {
        throw new ApiError(500, error?.message || "Failed to verify email.");
    }
};



export const resendEmailVerificationService = async (email) => {
    try {
        if (!email) {
            throw new ApiError(400, "Email is required.");
        }

        const user = await User.findOne({ email });

        if (!user) {
            throw new ApiError(400, "User not found.");
        }

        if (user.isEmailVerified) {
            throw new ApiError(400, "Email is already verified.");
        }

        const newToken = crypto.randomBytes(32).toString("hex");
        user.emailVerificationToken = newToken;
        await user.save({ validateBeforeSave: false });

        const verificationUrl = `${FRONTEND_URL}/verify-email?token=${newToken}`;

        await resend.emails.send({
            from: "support@vireact.io",
            to: user.email,
            subject: "Verify your email",
            html: `
                <div>
                    <p>Click <a href="${verificationUrl}">here</a> to verify your email.</p>
                </div>
            `
        });

        return {
            success: true,
            message: "Verification email resent successfully."
        };

    } catch (error) {
        throw new ApiError(500, error.message || "Failed to resend verification email.");
    }
};




//Login user by verifying credentials

/*
- Login User

1. Get username and pass from req body.
2. Check if user exsists - compare email
3. if user exsists, compare his pass with pass stored in database.
5. if comparison become false, return error.
4. if comparison become successfull, return access and refresh token.
5. Send cookies

*/
export const loginUserService = async (email, password) => {
    const user = await User.findOne({ email });

    if (!user) {
        throw new ApiError(400, "User Not Found");
    }

    // Check if user is trying to login with password but account was created with OAuth
    if (user.provider !== OAUTH_PROVIDERS.LOCAL) {
        const providerName = getProviderDisplayName(user.provider);
        throw new ApiError(409, `This email is already registered via ${providerName}. Please log in with ${providerName} instead.`);
    }

    if (!user.isEmailVerified) {
        throw new ApiError(401, "Please verify your email first.");
    }

    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
        throw new ApiError(401, "Invalid Password");
    }

    return user;
};

export const refreshTokenService = async (refreshToken) => {
    try {
        if (!refreshToken) {
            throw new ApiError(401, "Refresh token is required");
        }

        // Verify the refresh token
        const decoded = jwt.verify(refreshToken, ACCESS_TOKEN_SECRET);
        
        // Find user by ID from token
        const user = await User.findById(decoded._id);
        
        if (!user) {
            throw new ApiError(401, "Invalid refresh token - user not found");
        }

        // Check if the stored refresh token matches
        if (user.refreshToken !== refreshToken) {
            throw new ApiError(401, "Invalid refresh token");
        }

        // Generate new tokens
        const newAccessToken = user.generateAccessToken();
        const newRefreshToken = user.generateRefreshToken();
        
        // Update refresh token in database
        user.refreshToken = newRefreshToken;
        await user.save({ validateBeforeSave: false });

        return { accessToken: newAccessToken, refreshToken: newRefreshToken };
    } catch (error) {
        if (error.name === 'JsonWebTokenError') {
            throw new ApiError(401, 'Invalid refresh token');
        } else if (error.name === 'TokenExpiredError') {
            throw new ApiError(401, 'Refresh token expired');
        }
        throw new ApiError(500, error?.message || "Failed to refresh token");
    }
};