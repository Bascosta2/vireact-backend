import { Admin } from "../model/admin.model.js";
import { FRONTEND_URL, REFRESH_TOKEN_SECRET, RESEND_FROM_EMAIL, RESEND_REPLY_TO, NODE_ENV } from "../config/index.js";
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
/** Verification links work for 7 days after they are issued. Resending the same link does not extend it. */
export const EMAIL_VERIFICATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A resend reuses the current link only if it still has this long left; otherwise a new link is issued. */
export const EMAIL_VERIFICATION_MIN_REMAINING_MS = 24 * 60 * 60 * 1000;
export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 128;

export const normalizeEmail = (email) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * Emailed-link tokens (verify email, reset password) are 32 random bytes as lowercase hex.
 * Anything else (an object such as {"$ne": null}, an array, a number) is rejected before it can reach a query.
 */
const EMAIL_LINK_TOKEN = /^[a-f0-9]{64}$/;
export const isEmailLinkToken = (token) => typeof token === 'string' && EMAIL_LINK_TOKEN.test(token);

/** Outcome of POST /auth/verify-email. A second click (or an email scanner opening the link first) is not an error. */
export const EMAIL_VERIFICATION_STATUS = Object.freeze({
    VERIFIED: 'verified',
    ALREADY_VERIFIED: 'already_verified',
    /** Verified after competing signups: no password is kept; the response carries a one-hour resetToken. */
    VERIFIED_SET_PASSWORD: 'verified_set_password',
});

const isPast = (date, now) => Boolean(date) && new Date(date).getTime() <= now;

const newEmailLinkToken = () => crypto.randomBytes(32).toString('hex');

/**
 * The { token, expiresAt } for the next verification email: the user's current link with its original
 * expiry while it has at least a day left, so every link we have sent keeps working; otherwise a new link
 * that works for 7 days. A token from before expiries existed is reused and gets 7 days from now.
 */
export const verificationTokenFor = (user, now = Date.now()) => {
    const current = user?.emailVerificationToken;
    const expiresAt = user?.emailVerificationTokenExpiresAt ? new Date(user.emailVerificationTokenExpiresAt) : null;
    if (isEmailLinkToken(current)) {
        if (!expiresAt) return { token: current, expiresAt: new Date(now + EMAIL_VERIFICATION_TTL_MS) };
        if (expiresAt.getTime() - now >= EMAIL_VERIFICATION_MIN_REMAINING_MS) return { token: current, expiresAt };
    }
    return { token: newEmailLinkToken(), expiresAt: new Date(now + EMAIL_VERIFICATION_TTL_MS) };
};

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

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

/** "Vireact <support@vireact.io>" unless the configured address already carries a display name. */
export const formatFromAddress = (from = RESEND_FROM_EMAIL) => {
    const address = String(from || '').trim();
    if (!address || address.includes('<')) return address;
    return `Vireact <${address}>`;
};

/** Replies go to RESEND_REPLY_TO when set, otherwise to the bare sending address. */
export const replyToAddress = (from = RESEND_FROM_EMAIL, replyTo = RESEND_REPLY_TO) => {
    const explicit = String(replyTo || '').trim();
    if (explicit) return explicit;
    const address = String(from || '').trim();
    return address.match(/<([^>]+)>/)?.[1]?.trim() || address;
};

/**
 * Verification email. The name typed at signup is left out on purpose: whoever signs up chooses it, and the
 * email goes to an inbox that may belong to someone else, so it must not carry text a stranger wrote.
 */
export const buildVerificationEmail = (verificationUrl) => ({
    subject: 'Verify your Vireact email',
    html: `<div>
                <p>Hi there, welcome to Vireact.</p>
                <p><a href="${escapeHtml(verificationUrl)}">Verify your email</a> to finish setting up your account. If the link has expired, log in to get a new one.</p>
                <p>If you didn't create a Vireact account, ignore this email.</p>
                <p>The Vireact Team</p>
               </div>`,
    text: [
        'Hi there, welcome to Vireact.',
        '',
        'Verify your email to finish setting up your account:',
        verificationUrl,
        '',
        'If the link has expired, log in to get a new one.',
        '',
        "If you didn't create a Vireact account, ignore this email.",
        '',
        'The Vireact Team',
    ].join('\n'),
});

const MAX_GREETING_NAME_LENGTH = 50;

export const buildPasswordResetEmail = ({ name, resetUrl, hasPassword }) => {
    const action = hasPassword ? 'reset your password' : 'set a password for your account';
    const plainName = String(name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_GREETING_NAME_LENGTH) || 'there';
    return {
        subject: hasPassword ? 'Reset your Vireact password' : 'Set a password for Vireact',
        html: `<div>
                    <p>Hey ${escapeHtml(plainName)},</p>
                    <p><a href="${escapeHtml(resetUrl)}">Click here to ${action}</a>. The link works for one hour.</p>
                    <p>If you didn't ask for this, ignore this email. Your password stays the same.</p>
                    <p>The Vireact Team</p>
                   </div>`,
        text: [
            `Hey ${plainName},`,
            '',
            `Open this link to ${action} (it works for one hour):`,
            resetUrl,
            '',
            "If you didn't ask for this, ignore this email. Your password stays the same.",
            '',
            'The Vireact Team',
        ].join('\n'),
    };
};

const sendEmail = async ({ to, subject, html, text }) => {
    try {
        const message = { from: formatFromAddress(), replyTo: replyToAddress(), to, subject, html, text };
        const { error } = (await resend.emails.send(message)) ?? {};
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
    const { ok, recipientRejected } = await sendEmail({ to: user.email, ...buildVerificationEmail(verificationUrl) });
    if (ok) {
        await User.updateOne({ _id: user._id }, { $set: { verificationEmailSentAt: new Date() } });
        return VERIFICATION_EMAIL.SENT;
    }
    return recipientRejected ? VERIFICATION_EMAIL.BAD_ADDRESS : VERIFICATION_EMAIL.UNAVAILABLE;
};

/** Fields verification needs (not selected by default). */
const VERIFICATION_FIELDS = '+emailVerificationTokenExpiresAt +competingSignupAt';

const isWithinCooldown = (user, now = Date.now()) =>
    Boolean(user.verificationEmailSentAt) && now - new Date(user.verificationEmailSentAt).getTime() < EMAIL_RESEND_COOLDOWN_MS;

/**
 * Email the verification link, unless one went out in the last minute. The current link is reused
 * (see verificationTokenFor), so links in earlier emails keep working; resending never extends it.
 * verificationEmailSentAt is only stamped on a successful send, so RECENT always means a real link exists.
 * `user` must be loaded with VERIFICATION_FIELDS.
 */
const resendVerificationIfDue = async (user) => {
    if (isWithinCooldown(user)) return VERIFICATION_EMAIL.RECENT;
    const { token, expiresAt } = verificationTokenFor(user);
    await User.updateOne(
        { _id: user._id },
        { $set: { emailVerificationToken: token, emailVerificationTokenExpiresAt: expiresAt } }
    );
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
    // Plain strings only, so an operator object (e.g. {"$ne": null}) can never pick an admin.
    if (typeof email !== 'string' || !email || typeof password !== 'string' || !password) {
        throw new ApiError(400, "Email and Password are required fields.");
    }

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
 * - Existing account that was never verified: a competing signup. Nothing on the account changes and the
 *   password typed now is not kept; the account is marked (competingSignupAt) and the verification link is
 *   emailed again (at most once a minute, else 429). Two people may have chosen passwords for this address,
 *   so whoever opens the link proves they own the inbox and then sets a new password (see verifyEmailService).
 * The account is saved even if the verification email fails.
 * Returns { user, verificationEmail, pendingSignup } where verificationEmail is a VERIFICATION_EMAIL value.
 * For a competing signup (pendingSignup true), `user` is the existing account; never show it to the caller.
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

        const existingUser = await User.findOne({ email: cleanEmail }).select(`+password ${VERIFICATION_FIELDS}`);
        if (existingUser) {
            if (!existingUser.password && existingUser.googleId) {
                throw new ApiError(409, "This email already signs in with Google. Use Continue with Google, or Forgot password to add a password.");
            }
            if (existingUser.isEmailVerified) {
                throw new ApiError(409, "An account with this email already exists. Log in instead, or use Forgot password.");
            }
            if (isWithinCooldown(existingUser)) {
                throw new ApiError(429, "We just sent a verification link to this email. Check your inbox and spam folder, or try again in a minute.");
            }
            // Unverified: a competing signup. Only the inbox owner can finish it, by opening the link.
            const marked = await User.updateOne(
                { _id: existingUser._id, isEmailVerified: false },
                { $set: { competingSignupAt: new Date() } }
            );
            if (marked.modifiedCount !== 1) {
                throw new ApiError(409, "An account with this email already exists. Log in instead, or use Forgot password.");
            }
            const verificationEmail = await resendVerificationIfDue(existingUser);
            return { user: existingUser, verificationEmail, pendingSignup: true };
        }

        const token = newEmailLinkToken();
        const user = new User({
            name,
            email: cleanEmail,
            password,
            provider: provider || OAUTH_PROVIDERS.LOCAL,
            emailVerificationToken: token,
            emailVerificationTokenExpiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
            isEmailVerified: false,
            ...(attribution ? { attribution } : {})
        });

        const savedUser = await user.save();
        const verificationEmail = await sendVerificationEmail(savedUser, token);
        return { user: savedUser, verificationEmail, pendingSignup: false };

    } catch (error) {
        if (error instanceof ApiError) throw error;
        if (error?.code === 11000) {
            throw new ApiError(409, "An account with this email already exists. Log in instead, or use Forgot password.");
        }
        throw new ApiError(500, error?.message || "Failed to create user.");
    }
};


/**
 * Verify an email from the emailed link. Idempotent: the link stays on the account, so a second click (or a
 * mail scanner that opened the link first) answers ALREADY_VERIFIED instead of an error. A used link can only
 * ever report "already verified"; it unlocks nothing.
 * Competing signups (someone signed up again before verifying): two people may have chosen a password, and
 * only the inbox owner can open the link. So the inbox is verified but NO password is kept: the password is
 * removed, every device signed out, and a one-hour password-reset token (same as Forgot password) is returned
 * to the person who opened the link, and emailed as a fallback.
 * Returns { status, message, resetToken? } with status an EMAIL_VERIFICATION_STATUS value.
 */
const VERIFIED_RESULT = Object.freeze({ status: EMAIL_VERIFICATION_STATUS.VERIFIED, message: "Email verified successfully." });
const LINK_NO_LONGER_WORKS = "This verification link is invalid or no longer works. Log in, or request a new link.";
const LINK_EXPIRED = "This verification link has expired. Log in, or request a new link.";

const alreadyVerifiedResult = (user) => ({
    status: EMAIL_VERIFICATION_STATUS.ALREADY_VERIFIED,
    message: !user?.password && !user?.googleId
        ? "Your email is verified. Set a password with the link we emailed you, or use Forgot password."
        : "Your email is already verified. You can log in.",
});

/** Lost a race with another click on the same link: answer like a second click. */
const afterLostRace = async (user, token) => {
    const verified = await User.findOne({ _id: user._id, emailVerificationToken: token, isEmailVerified: true });
    if (verified) return alreadyVerifiedResult(verified);
    throw new ApiError(400, LINK_NO_LONGER_WORKS);
};

const resolveCompetingSignup = async (user, token) => {
    const resetToken = newEmailLinkToken();
    const now = Date.now();
    const done = await User.updateOne(
        { _id: user._id, emailVerificationToken: token, isEmailVerified: false },
        {
            $set: {
                isEmailVerified: true,
                // Either signup may have typed the name; start from a neutral one.
                name: String(user.email).split('@')[0],
                passwordResetTokenHash: sha256(resetToken),
                passwordResetExpires: new Date(now + PASSWORD_RESET_TTL_MS),
                passwordResetRequestedAt: new Date(now),
                refreshSessions: [],
            },
            $unset: { password: 1, refreshToken: 1 },
        }
    );
    if (done.modifiedCount !== 1) return afterLostRace(user, token);

    await sendEmail({
        to: user.email,
        ...buildPasswordResetEmail({ name: '', resetUrl: `${FRONTEND_URL}/reset-password?token=${resetToken}`, hasPassword: false }),
    });
    return {
        status: EMAIL_VERIFICATION_STATUS.VERIFIED_SET_PASSWORD,
        message: "Your email is verified. This address was signed up more than once, so choose a new password to finish.",
        resetToken,
    };
};

export const verifyEmailService = async (token) => {
    try {
        if (!token) {
            throw new ApiError(400, "Token is missing.");
        }
        if (!isEmailLinkToken(token)) {
            throw new ApiError(400, "This verification link is invalid. Log in, or request a new link.");
        }

        const user = await User.findOne({ emailVerificationToken: token }).select(VERIFICATION_FIELDS);
        if (!user) {
            throw new ApiError(400, LINK_NO_LONGER_WORKS);
        }
        if (user.isEmailVerified) {
            return alreadyVerifiedResult(user);
        }
        if (isPast(user.emailVerificationTokenExpiresAt, Date.now())) {
            throw new ApiError(400, LINK_EXPIRED);
        }
        if (user.competingSignupAt) {
            return await resolveCompetingSignup(user, token);
        }

        // Matching on the token too means a link that was replaced in the meantime cannot verify.
        const done = await User.updateOne(
            { _id: user._id, emailVerificationToken: token, isEmailVerified: false },
            { $set: { isEmailVerified: true } }
        );
        if (done.modifiedCount !== 1) return await afterLostRace(user, token);
        return VERIFIED_RESULT;
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
        const user = await User.findOne({ email: cleanEmail }).select(VERIFICATION_FIELDS);
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
    const user = await User.findOne({ email: normalizeEmail(email) }).select(VERIFICATION_FIELDS);

    if (!user) {
        throw new ApiError(401, GENERIC_LOGIN_ERROR_MESSAGE);
    }

    // Verified after competing signups, before the owner chose a password.
    if (!user.password && !user.googleId) {
        throw new ApiError(409, "This account has no password yet. Use Forgot password to set one.", { code: 'SET_PASSWORD' });
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
        await sendEmail({
            to: user.email,
            ...buildPasswordResetEmail({ name: user.name, resetUrl, hasPassword: Boolean(user.password) }),
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
    if (!isEmailLinkToken(token)) {
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
