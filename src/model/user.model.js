import bcrypt, { compare } from "bcryptjs";
import mongoose from "mongoose"
import jwt from "jsonwebtoken";
import { ACCESS_TOKEN_SECRET } from "../config/index.js";
import { OAUTH_PROVIDERS, ROLES } from "../constants.js";

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    password: {
        type: String,
        required: function () {
            // Password is required only if user is not using OAuth
            return !this.googleId;
        }
    },
    refreshToken: {
        type: String
    },
    role: {
        type: String,
        enum: ROLES,
        default: ROLES.USER,
        required: true
    },
    emailVerificationToken: {
        type: String,
        default: null
    },
    isEmailVerified: {
        type: Boolean,
        default: false
    },
    // Google OAuth fields
    googleId: {
        type: String,
        unique: true,
        sparse: true // Allows multiple null values
    },
    provider: {
        type: String,
        enum: OAUTH_PROVIDERS,
        default: OAUTH_PROVIDERS.LOCAL
    },
    avatar: {
        type: String,
        default: null
    }
}, { timestamps: true });


userSchema.pre("save", async function (next) {
    // Only hash password if it exists and has been modified
    if (this.isModified("password") && this.password) {
        this.password = await bcrypt.hash(this.password, 10);
    }
    next();
});


userSchema.methods.comparePassword = async function (candidatePassword) {
    const user = this;
    // For OAuth users without passwords, return false
    if (!user.password) {
        return false;
    }
    return await compare(candidatePassword, user.password);
};


userSchema.methods.generateAccessToken = function () {
    const signOptions = {
        expiresIn: "7d"
    };

    return jwt.sign(
        { _id: this._id, email: this.email },
        ACCESS_TOKEN_SECRET,
        signOptions
    );
};

userSchema.methods.generateRefreshToken = function () {
    const signOptions = {
        expiresIn: "30d"
    };

    return jwt.sign(
        { _id: this._id, email: this.email },
        ACCESS_TOKEN_SECRET,
        signOptions
    );
};

// Utility methods for OAuth users
userSchema.methods.isOAuthUser = function () {
    return this.provider !== OAUTH_PROVIDERS.LOCAL && this.googleId;
};

userSchema.methods.isGoogleUser = function () {
    return this.provider === OAUTH_PROVIDERS.GOOGLE && this.googleId;
};

userSchema.methods.hasPassword = function () {
    return !!this.password;
};

// Static method to find user by Google ID
userSchema.statics.findByGoogleId = function (googleId) {
    return this.findOne({ googleId, provider: OAUTH_PROVIDERS.GOOGLE });
};

// Static method to find or create user by Google profile
userSchema.statics.findOrCreateByGoogleProfile = async function (googleProfile) {
    const { id: googleId, emails, displayName, photos } = googleProfile;
    const email = emails && emails[0] ? emails[0].value : null;

    if (!email) {
        throw new Error('Email is required for ' + OAUTH_PROVIDERS.GOOGLE + ' OAuth');
    }

    // Try to find existing user by Google ID first
    let user = await this.findByGoogleId(googleId);

    if (user) {
        return user;
    }

    // Try to find existing user by email
    user = await this.findOne({ email });

    if (user) {
        // Check if user exists with a different provider
        if (user.provider !== OAUTH_PROVIDERS.GOOGLE) {
            // Don't auto-link providers - this is a security risk
            // Instead, we'll handle this in the OAuth callback with proper error messaging
            throw new Error(`ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER:${user.provider}`);
        }
        
        // User already has Google account linked, just update the Google ID if needed
        if (!user.googleId) {
            user.googleId = googleId;
            user.isEmailVerified = true; // Google emails are verified
            if (photos && photos[0]) {
                user.avatar = photos[0].value;
            }
            await user.save();
        }
        return user;
    }

    // Create new user
    const newUser = new this({
        name: displayName || email.split('@')[0],
        email,
        googleId,
        provider: OAUTH_PROVIDERS.GOOGLE,
        isEmailVerified: true,
        avatar: photos && photos[0] ? photos[0].value : null
    });

    await newUser.save();
    return newUser;
};


export const User = mongoose.model("User", userSchema);