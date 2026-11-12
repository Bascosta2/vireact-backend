import bcrypt, { compare } from "bcryptjs";
import mongoose from "mongoose"
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { ACCESS_TOKEN_SECRET, REFRESH_TOKEN_SECRET } from "../config/index.js";
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
    /** Hash of the most recently issued refresh token (kept for older sessions and admin parity). */
    refreshToken: {
        type: String
    },
    /**
     * One entry per signed-in device (max 10). Each refresh rotates only its own entry, so signing in
     * on a phone no longer signs the laptop out. Hashes only; never selected unless asked for.
     */
    refreshSessions: {
        type: [{
            _id: false,
            hash: { type: String, required: true },
            createdAt: { type: Date, default: Date.now },
            lastUsedAt: { type: Date, default: Date.now },
        }],
        default: [],
        select: false
    },
    /** Password reset: SHA-256 of the emailed token, its expiry, and when the last email went out. */
    passwordResetTokenHash: {
        type: String,
        default: null,
        select: false
    },
    passwordResetExpires: {
        type: Date,
        default: null,
        select: false
    },
    passwordResetRequestedAt: {
        type: Date,
        default: null,
        select: false
    },
    /** Last verification email, to rate-limit automatic resends. */
    verificationEmailSentAt: {
        type: Date,
        default: null
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
    },
    // Email notification preferences. Per-video emails (short ready, export/report ready) are
    // opt-in and start off; new features and events (notifyProductUpdates) start on.
    notifyShortsReady: {
        type: Boolean,
        default: false
    },
    notifyExportReady: {
        type: Boolean,
        default: false
    },
    notifyProductUpdates: {
        type: Boolean,
        default: true
    },
    // Monotonic per-account counter for the lifetime free-trial allowance.
    // Never reset by subscription lifecycle events. Enforcement is added in
    // Phase 2B; this field exists so new users default to 0 starting now.
    lifetimeFreeVideosUsed: {
        type: Number,
        default: 0,
        min: 0
    },
    // First-touch marketing attribution, written once (signup body or
    // POST /auth/attribution) and never overwritten. See utils/attribution.js.
    attribution: {
        type: new mongoose.Schema({
            ref: String,
            utm_source: String,
            utm_medium: String,
            utm_campaign: String,
            utm_term: String,
            utm_content: String,
            referrer: String,
            landing_path: String,
            captured_at: Date
        }, { _id: false }),
        default: undefined
    },
    // Funnel V2: first quiz session linked to this account (first wins) and the
    // answers copied from it. See service/funnel.service.js linkFunnelSession.
    funnelSessionId: {
        type: String,
        default: undefined
    },
    onboarding: {
        type: new mongoose.Schema({
            answers: { type: mongoose.Schema.Types.Mixed },
            segment: String,
            highIntent: Boolean,
            recommendedPlan: String,
            linkedAt: Date
        }, { _id: false }),
        default: undefined
    },
    // Analytics tab: what the creator posts and how often. Falls back to onboarding.answers when unset
    // (see service/creator-profile.service.js).
    creatorProfile: {
        type: new mongoose.Schema({
            niche: String,
            platforms: [String],
            followers: Number,
            goal: String,
            postsPerWeek: Number,
            preferredDays: [Number],
            timezone: String,
            updatedAt: Date
        }, { _id: false }),
        default: undefined
    },
    // Editor tab: when this account used its one free AI edit (null = still available).
    editorTrialUsedAt: { type: Date, default: null }
}, { timestamps: true });

// Schema-level serialization guard. Strips fields that must never reach a
// client over JSON. This is defense-in-depth: callsites should still .select
// these out where possible, but res.json(user) on a Mongoose doc routes
// through toJSON so a forgotten .select cannot leak the persisted refresh
// token, password hash, or email-verification token.
// NOTE: only fires for Mongoose documents. Queries that end in .lean() bypass
// this transform — those callsites must strip sensitive fields explicitly via
// .select(). See loginUser, googleCallback, and profile.service for examples.
userSchema.set("toJSON", {
    transform: (_doc, ret) => {
        delete ret.password;
        delete ret.refreshToken;
        delete ret.emailVerificationToken;
        delete ret.refreshSessions;
        delete ret.passwordResetTokenHash;
        delete ret.passwordResetExpires;
        delete ret.passwordResetRequestedAt;
        delete ret.__v;
        return ret;
    }
});


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
        expiresIn: "30m"
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

    // jti makes every refresh token unique, even two issued in the same second.
    return jwt.sign(
        { _id: this._id, email: this.email, jti: crypto.randomUUID() },
        REFRESH_TOKEN_SECRET,
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
// A Google identity can be linked to an email/password account too, so match on googleId alone.
userSchema.statics.findByGoogleId = function (googleId) {
    return this.findOne({ googleId });
};

// Static method to find or create user by Google profile
userSchema.statics.findOrCreateByGoogleProfile = async function (googleProfile) {
    const { id: googleId, emails, displayName, photos } = googleProfile;
    const email = emails && emails[0] ? emails[0].value : null;
    const emailVerified =
        googleProfile._json?.email_verified === true ||
        emails?.[0]?.verified === true;

    if (!email) {
        throw new Error('Email is required for ' + OAUTH_PROVIDERS.GOOGLE + ' OAuth');
    }

    if (!emailVerified) {
        throw new Error('GOOGLE_EMAIL_NOT_VERIFIED');
    }

    // Try to find existing user by Google ID first
    let user = await this.findByGoogleId(googleId);

    if (user) {
        return user;
    }

    // Existing account with this (Google-verified) email: link the Google identity to it.
    user = await this.findOne({ email: String(email).trim().toLowerCase() });
    if (user) {
        if (!user.googleId) user.googleId = googleId;
        if (!user.avatar && photos && photos[0]) user.avatar = photos[0].value;
        if (!user.isEmailVerified) {
            // Nobody had proven they own this address until now. Someone may have registered it
            // first with a password of their choosing ("pre-hijacking"), so that password is dropped;
            // the owner can add their own later through Forgot password.
            user.password = undefined;
            user.emailVerificationToken = null;
            user.isEmailVerified = true;
        }
        await user.save({ validateBeforeSave: false });
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


// Emailed-link lookups (verify email, reset password). Partial: only users with a live token are indexed.
userSchema.index({ emailVerificationToken: 1 }, { partialFilterExpression: { emailVerificationToken: { $type: 'string' } } });
userSchema.index({ passwordResetTokenHash: 1 }, { partialFilterExpression: { passwordResetTokenHash: { $type: 'string' } } });

export const User = mongoose.model("User", userSchema);