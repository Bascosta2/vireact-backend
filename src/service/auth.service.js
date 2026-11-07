import { Admin } from "../model/admin.model.js";
import { FRONTEND_URL, REFRESH_TOKEN_SECRET, RESEND_FROM_EMAIL, NODE_ENV } from "../config/index.js";
import { ApiError } from "../utils/ApiError.js";
import { User } from "../model/user.model.js";
import crypto from "crypto"
import resend from "../lib/resend.js";
import { OAUTH_PROVIDERS } from "../constants.js";
import jwt from "jsonwebtoken";
import { hashRefreshToken, refreshTokenMatches } from "../utils/refresh-token-hash.js";
import { captureError } from "./ops-monitoring.service.js";

/** Signed-in devices kept per user. The oldest falls off when an 11th device signs in. */
export const MAX_REFRESH_SESSIONS = 10;
/** Password reset links work for one hour. */
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
/** Minimum gap between automatic verification or reset emails to the same address. */
export const EMAIL_RESEND_COOLDOWN_MS = 60 * 1000;
export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 128;

export const normalizeEmail = (email) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** Hash variants a stored session hash may use (peppered and unpeppered), so adding a pepper later never signs users out. */
const sessionHashCandidates = (token) => {
    const candidates = new Set([hashRefreshToken(token)]);
    if (process.env.REFRESH_TOKEN_PEPPER) candidates.add(hashRefreshToken(token, ''));
    return [...candidates];
};

const assertValidPassword = (password) => {
    if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
        throw new ApiError(400, `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
        throw new ApiError(400, `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);
    }
};

/**
 * What happened when we tried to get a verification link to the user.
 * - SENT: the email went out just now.
 * - RECENT: one went out in the last minute (cooldown), so the user already has a link.
 * - BAD_ADDRESS: the provider rejected this recipient address.
 * - UNAVAILABLE: email is down for everyone (domain not verified, bad API key, provider outage).
 */
export const VERIFICATION_EMAIL = Object.freeze({
    SENT: 'sent',
    RECENT: 'recent',
    BAD_ADDRESS: 'bad_address',
    UNAVAILABLE: 'unavailable',
});

/** Resend's message for a malformed recipient; anything else is a sending problem on our side. */
const RECIPIENT_REJECTED = /invalid `?to`? field/i;

const sendEmail = async ({ to, subject, html }) => {
    try {
        const { error } = (await resend.emails.send({ from: RESEND_FROM_EMAIL, to, subject, html })) ?? {};
        if (error) throw new Error(error.message || 'Resend rejected the email');
        return { ok: true };
    } catch (error) {
        const message = error?.message || String(error);
        console.error(`[Auth] Could not send "${subject}" email: ${message}`);
        const recipientRejected = RECIPIENT_REJECTED.test(message);
        if (!recipientRejected) {
            captureError(new Error(`Auth email "${subject}" could not be sent: ${message}`), { source: 'server', route: 'auth/email' });
        }
        return { ok: false, recipientRejected };
    }
};

const sendVerificationEmail = async (user, token) => {
    const verificationUrl = `${FRONTEND_URL}/verify-email?token=${token}`;
    const { ok, recipientRejected } = await sendEmail({
        to: user.email,
        subject: 'Verify your Vireact email',
        html: `<div>
                <p>Hey ${user.name || 'there'}, welcome to Vireact.</p>
                <p><a href="${verificationUrl}">Verify your email</a> to finish setting up your account.</p>
                <p>If you didn't create a Vireact account, ignore this email.</p>
                <p>The Vireact Team</p>
               </div>`,
    });
    if (ok) {
        await User.updateOne({ _id: user._id }, { $set: { verificationEmailSentAt: new Date() } });
        return VERIFICATION_EMAIL.SENT;
    }
    return recipientRejected ? VERIFICATION_EMAIL.BAD_ADDRESS : VERIFICATION_EMAIL.UNAVAILABLE;
};

/**
 * Issue a fresh verification token and email it, unless one went out in the last minute.
 * verificationEmailSentAt is only stamped on a successful send, so RECENT always means a real link exists.
 */
const resendVerificationIfDue = async (user) => {
    const last = user.verificationEmailSentAt ? new Date(user.verificationEmailSentAt).getTime() : 0;
    if (Date.now() - last < EMAIL_RESEND_COOLDOWN_MS) return VERIFICATION_EMAIL.RECENT;
    const token = crypto.randomBytes(32).toString("hex");
    await User.updateOne({ _id: user._id }, { $set: { emailVerificationToken: token } });
    return sendVerificationEmail(user, token);
};

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


/**
 * Issue an access + refresh token pair.
 * Users: the refresh token becomes a new per-device session (max MAX_REFRESH_SESSIONS).
 * Admins: single stored hash, as before.
 */
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
        const hash = hashRefreshToken(refreshToken);

        if (model === User) {
            const now = new Date();
            await User.updateOne(
                { _id: user._id },
                {
                    $set: { refreshToken: hash },
                    $push: { refreshSessions: { $each: [{ hash, createdAt: now, lastUsedAt: now }], $slice: -MAX_REFRESH_SESSIONS } },
                }
            );
        } else {
            // Only the hash is persisted; the raw token lives in the HttpOnly cookie.
            user.refreshToken = hash;
            await user.save({ validateBeforeSave: false });
        }

        return { accessToken, refreshToken };
    } catch (error) {
        if (error instanceof ApiError) throw error;
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
            if (error instanceof ApiError) throw error;
            throw new ApiError(500, error?.message || "Failed to create admin.");
        }
    };

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


/**
 * Sign up with email + password.
 * - Existing verified account (or a Google account): 409 with what to do instead.
 * - Existing account that was never verified: treated as a fresh signup (new name/password, new email),
 *   so someone who lost the first verification email is never stuck.
 * The account is saved even if the verification email fails.
 * Returns { user, verificationEmail } where verificationEmail is a VERIFICATION_EMAIL value.
 */
export const customSignupUserService = async (
    name,
    email,
    password,
    provider,
    attribution = null
) => {
    try {
        const cleanEmail = normalizeEmail(email);
        assertValidPassword(password);

        const existingUser = await User.findOne({ email: cleanEmail }).select('+password');
        if (existingUser) {
            if (!existingUser.password && existingUser.googleId) {
                throw new ApiError(409, "This email already signs in with Google. Use Continue with Google, or Forgot password to add a password.");
            }
            if (existingUser.isEmailVerified) {
                throw new ApiError(409, "An account with this email already exists. Log in instead, or use Forgot password.");
            }
            // Unverified: restart signup for whoever owns the inbox.
            const token = crypto.randomBytes(32).toString("hex");
            existingUser.name = name;
            existingUser.password = password;
            existingUser.emailVerificationToken = token;
            await existingUser.save();
            const verificationEmail = await sendVerificationEmail(existingUser, token);
            return { user: existingUser, verificationEmail };
        }

        const token = crypto.randomBytes(32).toString("hex");
        const user = new User({
            name,
            email: cleanEmail,
            password,
            provider: provider || OAUTH_PROVIDERS.LOCAL,
            emailVerificationToken: token,
            isEmailVerified: false,
            ...(attribution ? { attribution } : {})
        });

        const savedUser = await user.save();
        const verificationEmail = await sendVerificationEmail(savedUser, token);
        return { user: savedUser, verificationEmail };

    } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error?.code === 11000) {
            throw new ApiError(409, "An account with this email already exists. Log in instead, or use Forgot password.");
        }
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
            throw new ApiError(400, "This verification link is invalid or was already used. Log in, or request a new link.");
        }

        user.isEmailVerified = true;
        user.emailVerificationToken = undefined;

        await user.save({ validateBeforeSave: false });

        return {
            success: true,
            message: "Email verified successfully.",
        };
    } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(500, error?.message || "Failed to verify email.");
    }
};


/**
 * Resend the verification email. Always answers the same way, whether or not the address exists or
 * is already verified, so it cannot be used to discover accounts.
 */
export const resendEmailVerificationService = async (email) => {
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) {
        throw new ApiError(400, "Email is required.");
    }
    const generic = {
        success: true,
        message: "If that email has an account waiting for verification, a new link is on its way.",
    };
    try {
        const user = await User.findOne({ email: cleanEmail });
        if (user && !user.isEmailVerified) {
            await resendVerificationIfDue(user);
        }
    } catch (error) {
        console.error('[Auth] Resend verification failed:', error.message);
    }
    return generic;
};


// Generic credential-failure response for unknown email and wrong password, so accounts
// cannot be enumerated. Messages that need the correct password first (unverified email)
// or that are a usability signal (Google-only account) are specific.
const GENERIC_LOGIN_ERROR_MESSAGE = "Invalid email or password";

export const loginUserService = async (email, password) => {
    const user = await User.findOne({ email: normalizeEmail(email) });

    if (!user) {
        throw new ApiError(401, GENERIC_LOGIN_ERROR_MESSAGE);
    }

    // Google-only account (no password yet). Not a credential check: tell the user the way in.
    if (!user.password) {
        throw new ApiError(
            409,
            `This email signs in with ${getProviderDisplayName(OAUTH_PROVIDERS.GOOGLE)}. Use Continue with Google, or Forgot password to add a password.`,
            { code: 'USE_GOOGLE' }
        );
    }

    const isPasswordValid = await user.comparePassword(password);

    if (!isPasswordValid) {
        throw new ApiError(401, GENERIC_LOGIN_ERROR_MESSAGE);
    }

    // Correct password but the email was never verified. Only the account owner can get here, so it
    // is safe to say so, and a fresh link goes out (at most once a minute).
    if (!user.isEmailVerified) {
        const outcome = await resendVerificationIfDue(user);
        if (outcome === VERIFICATION_EMAIL.UNAVAILABLE) {
            // Email is down for everyone, so no link can reach this user. Let them in rather than lock
            // them out; the account stays unverified and is asked to verify again once email works.
            console.warn(`[Auth] Login allowed without verification for user ${user._id}: verification email unavailable`);
            return user;
        }
        const messages = {
            [VERIFICATION_EMAIL.SENT]: `Verify your email to log in. We sent a new link to ${user.email}. Check your spam folder too.`,
            [VERIFICATION_EMAIL.RECENT]: `Verify your email to log in. We sent a link to ${user.email} in the last minute. Check your spam folder too.`,
            [VERIFICATION_EMAIL.BAD_ADDRESS]: `We can't send email to ${user.email}. Check the address for typos and sign up again with the right one.`,
        };
        throw new ApiError(403, messages[outcome], { code: 'EMAIL_NOT_VERIFIED', email: user.email });
    }

    if (NODE_ENV !== 'production') {
        console.log(`[AUTH SERVICE] Login OK for user id: ${user._id}`);
    }
    return user;
};


/**
 * Forgot password. Always answers the same way. Works for Google-only accounts too, which is how
 * they add a password.
 */
export const forgotPasswordService = async (email) => {
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) {
        throw new ApiError(400, "Email is required.");
    }
    const generic = {
        success: true,
        message: "If an account uses that email, a link to reset your password is on its way. It works for one hour.",
    };
    try {
        const user = await User.findOne({ email: cleanEmail }).select('+passwordResetRequestedAt');
        if (!user) return generic;
        const last = user.passwordResetRequestedAt ? new Date(user.passwordResetRequestedAt).getTime() : 0;
        if (Date.now() - last < EMAIL_RESEND_COOLDOWN_MS) return generic;

        const token = crypto.randomBytes(32).toString('hex');
        await User.updateOne(
            { _id: user._id },
            {
                $set: {
                    passwordResetTokenHash: sha256(token),
                    passwordResetExpires: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
                    passwordResetRequestedAt: new Date(),
                },
            }
        );
        const resetUrl = `${FRONTEND_URL}/reset-password?token=${token}`;
        const action = user.password ? 'reset your password' : 'set a password for your account';
        await sendEmail({
            to: user.email,
            subject: user.password ? 'Reset your Vireact password' : 'Set a password for Vireact',
            html: `<div>
                    <p>Hey ${user.name || 'there'},</p>
                    <p><a href="${resetUrl}">Click here to ${action}</a>. The link works for one hour.</p>
                    <p>If you didn't ask for this, ignore this email. Your password stays the same.</p>
                    <p>The Vireact Team</p>
                   </div>`,
        });
    } catch (error) {
        console.error('[Auth] Forgot password failed:', error.message);
    }
    return generic;
};


/**
 * Set a new password from a reset link. Proves inbox ownership, so the email becomes verified.
 * Signs out every device (all refresh sessions are revoked).
 */
export const resetPasswordService = async (token, password) => {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
        throw new ApiError(400, "This reset link is invalid. Request a new one.");
    }
    assertValidPassword(password);

    const user = await User.findOne({
        passwordResetTokenHash: sha256(token),
        passwordResetExpires: { $gt: new Date() },
    }).select('+passwordResetTokenHash +passwordResetExpires');

    if (!user) {
        throw new ApiError(400, "This reset link has expired or was already used. Request a new one.");
    }

    user.password = password;
    user.isEmailVerified = true;
    user.emailVerificationToken = null;
    user.passwordResetTokenHash = null;
    user.passwordResetExpires = null;
    user.refreshSessions = [];
    user.refreshToken = undefined;
    await user.save();

    return { success: true, message: "Password updated. You can log in now.", email: user.email };
};


/**
 * Rotate a refresh token.
 * Users: the presented token must match one device session; only that session rotates, and the
 * old token stops working immediately (replay -> 401). Sessions created before per-device sessions
 * existed match the single stored hash and are moved into the session list on first use.
 */
export const refreshTokenService = async (refreshToken) => {
    try {
        if (!refreshToken) {
            throw new ApiError(401, "Refresh token is required");
        }

        const decoded = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET);

        const user = await User.findById(decoded._id).select('+refreshSessions');
        if (!user) {
            throw new ApiError(401, "Invalid refresh token - user not found");
        }

        const newAccessToken = user.generateAccessToken();
        const newRefreshToken = user.generateRefreshToken();
        const newHash = hashRefreshToken(newRefreshToken);
        const now = new Date();

        // Per-device session: rotate exactly the matching entry, atomically.
        const rotated = await User.updateOne(
            { _id: user._id, 'refreshSessions.hash': { $in: sessionHashCandidates(refreshToken) } },
            { $set: { 'refreshSessions.$.hash': newHash, 'refreshSessions.$.lastUsedAt': now, refreshToken: newHash } }
        );
        if (rotated.modifiedCount === 1) {
            return { accessToken: newAccessToken, refreshToken: newRefreshToken };
        }

        // Older single-session sign-in (or a legacy plaintext token).
        if (refreshTokenMatches(user.refreshToken, refreshToken) || sessionHashCandidates(refreshToken).includes(user.refreshToken)) {
            const migrated = await User.updateOne(
                { _id: user._id, refreshToken: user.refreshToken },
                {
                    $set: { refreshToken: newHash },
                    $push: { refreshSessions: { $each: [{ hash: newHash, createdAt: now, lastUsedAt: now }], $slice: -MAX_REFRESH_SESSIONS } },
                }
            );
            if (migrated.modifiedCount === 1) {
                return { accessToken: newAccessToken, refreshToken: newRefreshToken };
            }
        }

        throw new ApiError(401, "Invalid refresh token");
    } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error.name === 'JsonWebTokenError') {
            throw new ApiError(401, 'Invalid refresh token');
        } else if (error.name === 'TokenExpiredError') {
            throw new ApiError(401, 'Refresh token expired');
        }
        throw new ApiError(500, error?.message || "Failed to refresh token");
    }
};


/**
 * Sign out one device (the one presenting this refresh token). Without a token, signs out everywhere.
 */
export const revokeRefreshSession = async (userId, refreshToken) => {
    if (!refreshToken) {
        await User.updateOne({ _id: userId }, { $set: { refreshSessions: [] }, $unset: { refreshToken: 1 } });
        return;
    }
    const candidates = sessionHashCandidates(refreshToken);
    await User.updateOne({ _id: userId }, { $pull: { refreshSessions: { hash: { $in: candidates } } } });
    await User.updateOne({ _id: userId, refreshToken: { $in: candidates } }, { $unset: { refreshToken: 1 } });
};
