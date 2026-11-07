import {
    generateAccessToken,
    loginAdminService,
    loginUserService,
    customSignupUserService,
    verifyEmailService,
    resendEmailVerificationService,
    refreshTokenService,
    forgotPasswordService,
    resetPasswordService,
    revokeRefreshSession,
    VERIFICATION_EMAIL
} from "../service/auth.service.js";
import jwt from "jsonwebtoken";
import { REFRESH_TOKEN_SECRET } from "../config/index.js";
import { Admin } from "../model/admin.model.js";
import { User } from "../model/user.model.js";
import { COOKIE_OPTIONS, OAUTH_PROVIDERS, ROLES } from "../constants.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import passport from "../lib/passport.js";
import { FRONTEND_URL, NODE_ENV } from "../config/index.js";
import { getSafeOAuthRedirectUrl } from "../utils/oauth-redirect.js";
import { sanitizeAttribution, attributionEventProperties } from "../utils/attribution.js";
import { captureServerEvent } from "../lib/analytics.js";
import { storeFirstTouchAttribution } from "../service/attribution.service.js";
import { isFunnelV2Enabled } from "../config/flags.js";
import { isSessionId, linkFunnelSession } from "../service/funnel.service.js";
import { resolveAccess, computePostAuthPath } from "../service/access.service.js";
import { Video } from "../model/video.model.js";

const MAX_OAUTH_ATTR_LENGTH = 2048;
const NEW_GOOGLE_USER_WINDOW_MS = 2 * 60 * 1000;

/** Links a quiz session when the funnel is on. Never fails the auth request. */
const linkFunnelSafely = async (userId, sessionId) => {
    if (!isFunnelV2Enabled() || !isSessionId(sessionId)) return { linked: false };
    try {
        return await linkFunnelSession(userId, sessionId);
    } catch (error) {
        console.error('[funnel] session link failed:', error.message);
        return { linked: false };
    }
};

/** `attr` on /auth/google is base64url JSON of the client's first-touch attribution. */
const decodeOAuthAttribution = (raw) => {
    if (typeof raw !== 'string' || !raw || raw.length > MAX_OAUTH_ATTR_LENGTH) return null;
    try {
        return sanitizeAttribution(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    } catch {
        return null;
    }
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




// Signup User
export const signupUser = async (req, res, next) => {
    try {
        const {
            name,
            email,
            password,
            provider = OAUTH_PROVIDERS.LOCAL
        } = req.body;

        if (!name || !email || !password) {
            throw new ApiError(400, "All fields are required.")
        }

        const attribution = sanitizeAttribution(req.body.attribution);
        const { user, verificationEmail } = await customSignupUserService(
            name,
            email,
            password,
            provider,
            attribution
        )

        captureServerEvent(user._id, 'user_signed_up', {
            method: 'email',
            ...attributionEventProperties(attribution)
        });
        await linkFunnelSafely(user._id, req.body.funnelSessionId);

        const verificationEmailSent = verificationEmail === VERIFICATION_EMAIL.SENT;

        // Email is down for everyone, so the user could never verify. Sign them in now, exactly as
        // login would (see loginUserService); the account stays unverified.
        if (verificationEmail === VERIFICATION_EMAIL.UNAVAILABLE) {
            const { accessToken, refreshToken } = await generateAccessToken(user._id, User, "User");
            return res.status(201)
                .cookie("accessToken", accessToken, COOKIE_OPTIONS)
                .cookie("refreshToken", refreshToken, { ...COOKIE_OPTIONS, maxAge: 30 * 24 * 60 * 60 * 1000 }) // 30 days
                .json(
                    ApiResponse.success(
                        201,
                        "Account created. You're signed in.",
                        { user, accessToken, verificationEmailSent }
                    )
                );
        }

        res.status(201).json(
            ApiResponse.success(
                201,
                "User Created Successfully",
                { user, verificationEmailSent }
            )
        );

    } catch (error) {
        next(error)
    }
};


// Login User
export const loginUser = async (req, res, next) => {
    const startTime = Date.now();
    const { email, password } = req.body;
    
    if (NODE_ENV !== 'production') {
        console.log('\n🔐 [LOGIN] Login attempt started');
        console.log(`   Email: ${email ? '[redacted]' : 'NOT PROVIDED'}`);
        console.log(`   Password: ${password ? '***' : 'NOT PROVIDED'}`);
    }
    
    try {
        if (!email || !password) {
            throw new ApiError(400, "Email and Password are required fields.")
        }

        const user = await loginUserService(email, password);
        await linkFunnelSafely(user._id, req.body.funnelSessionId);

        const { accessToken, refreshToken } = await generateAccessToken(user._id, User, "User");

        // Explicit field exclusion: this query is .lean() so the schema-level
        // toJSON transform does not run. We must strip sensitive fields here.
        const loggedInUser = await User.findById(user._id)
            .select("-password -refreshToken -emailVerificationToken")
            .lean();
        res.clearCookie("accessToken", COOKIE_OPTIONS)
        res.clearCookie("refreshToken", COOKIE_OPTIONS)

        // The refresh token is set as an HttpOnly cookie above and intentionally
        // not echoed in the JSON body. Email/password clients still receive the
        // access token in the body for Bearer-header use; the refresh token must
        // never leave the server outside of the HttpOnly cookie channel.
        res.status(200)
            .cookie("accessToken", accessToken, COOKIE_OPTIONS)
            .cookie("refreshToken", refreshToken, { ...COOKIE_OPTIONS, maxAge: 30 * 24 * 60 * 60 * 1000 }) // 30 days
            .json(
                ApiResponse.success(
                    200,
                    "Login Successful",
                    {
                        user: loggedInUser,
                        accessToken
                    }
                )
            )
        
        if (NODE_ENV !== 'production') {
            const duration = Date.now() - startTime;
            console.log(`   ✅ [LOGIN] Login successful in ${duration}ms`);
        }

    }
    catch (error) {
        if (NODE_ENV !== 'production') {
            const duration = Date.now() - startTime;
            console.error(`   ❌ [LOGIN] Login failed after ${duration}ms`);
            console.error(`   Error: ${error.message}`);
            console.error(`   Status Code: ${error.statusCode || 500}`);
        }
        next(error)
    }
};


// Login Controller
export const loginAdmin = async (req, res, next) => {
    try {
        const { email, password } = req.body;

        const admin = await loginAdminService(email, password);
        const { accessToken, refreshToken } = await generateAccessToken(admin._id, Admin, "Admin");

        const loggedInAdmin = await Admin
            .findById(admin._id)
            .select("-password -refreshToken")
            .lean()

        res.clearCookie("accessToken", COOKIE_OPTIONS)
        res.clearCookie("refreshToken", COOKIE_OPTIONS)

        // Same contract as loginUser: the refresh token only travels in the HttpOnly cookie.
        res.status(200)
            .cookie("accessToken", accessToken, COOKIE_OPTIONS)
            .cookie("refreshToken", refreshToken, { ...COOKIE_OPTIONS, maxAge: 30 * 24 * 60 * 60 * 1000 }) // 30 days
            .json({
                message: "Login Successful",
                admin: loggedInAdmin,
                accessToken
            });
    }
    catch (error) {
        next(error)
    }
};


// single function to handle login by invoking current controllers as functions
export const login = async (req, res, next) => {
    try {
        const { role } = req.body;

        if (role === ROLES.ADMIN) {
            await loginAdmin(req, res, next);
        }
        else if (role === ROLES.USER) {
            await loginUser(req, res, next);
        }
        else {
            throw new ApiError(400, "Invalid User Type.");
        }
    } catch (error) {
        next(error)
    }
}


export const signup = async (req, res, next) => {
    try {
        const { role } = req.body;

        if (role === ROLES.ADMIN) {
            // There is no public admin signup; operators use scripts/create-admin.js.
            throw new ApiError(404, "Not found");
        }
        else if (role === ROLES.USER) {
            await signupUser(req, res, next);
        }
        else {
            throw new ApiError(400, "Invalid User Type.");
        }
    } catch (error) {
        next(error)
    }
};




export const resendEmailVerification = async (req, res, next) => {
    try {
        const { email } = req.body;

        const result = await resendEmailVerificationService(email);

        res
            .status(200)
            .json(result);

    } catch (error) {
        next(error)
    }
};




export const verifyEmail = async (req, res, next) => {
    const token = req.query?.token || req.body?.token;

    try {
        if (!token) {
            throw new ApiError(400, "Verification token is required.");
        }

        const result = await verifyEmailService(token);

        res.status(200).json(result);
    } catch (error) {
        next(error)
    }
};




// Logout Admin
export const logoutAdmin = async (req, res, next) => {
    try {
        res.clearCookie("accessToken", COOKIE_OPTIONS);
        res.clearCookie("refreshToken", COOKIE_OPTIONS);
        res.status(200).json(
            ApiResponse.success(200, "Admin Logout Successful")
        );
    } catch (error) {
        next(error)
    }
};


// Logout User
// Server-side revocation: the persisted refresh token must be cleared so a
// captured/stolen JWT (e.g. from an XSS leak prior to this hardening) cannot
// be replayed for up to 30 days. The route is gated by authenticateToken so
// req.user is hydrated and we know whose token to revoke.
export const logoutUser = async (req, res, next) => {
    try {
        // Identify the account from the access token, or from the refresh cookie when the access
        // token has already expired (expired refresh tokens still identify the session to revoke).
        const cookieToken = req.cookies?.refreshToken;
        let userId = req.user?._id;
        if (!userId && cookieToken) {
            try {
                userId = jwt.verify(cookieToken, REFRESH_TOKEN_SECRET, { ignoreExpiration: true })?._id;
            } catch {
                userId = null;
            }
        }
        if (userId) {
            // Sign out this device only; other devices stay signed in.
            await revokeRefreshSession(userId, cookieToken);
        }
        res.clearCookie("accessToken", COOKIE_OPTIONS);
        res.clearCookie("refreshToken", COOKIE_OPTIONS);
        res.status(200).json(
            ApiResponse.success(200, "User Logout Successful")
        );
    } catch (error) {
        next(error)
    }
};

// Single Logout Handler
export const logout = async (req, res, next) => {
    try {
        const { role } = req.body;

        if (role === ROLES.ADMIN) {
            await logoutAdmin(req, res, next);
        }
        else if (role === ROLES.USER) {
            await logoutUser(req, res, next);
        }
        else {
            throw new ApiError(400, "Invalid User Role");
        }
    } catch (error) {
        next(error)
    }
};

// Google OAuth Controllers
export const googleAuth = (req, res, next) => {
    try {
        // Store only same-origin redirect targets (prevents open redirect after OAuth)
        if (req.query.redirect) {
            const safe = getSafeOAuthRedirectUrl(req.query.redirect);
            if (safe) {
                req.session.redirectUrl = safe;
            }
        }
        // Funnel context rides in the server session; OAuth `state` stays CSRF-only.
        if (isFunnelV2Enabled()) {
            const funnel = {};
            if (isSessionId(req.query.fs)) funnel.sessionId = req.query.fs;
            const attribution = decodeOAuthAttribution(req.query.attr);
            if (attribution) funnel.attribution = attribution;
            if (Object.keys(funnel).length) req.session.funnel = funnel;
        }

        passport.authenticate('google', {
            scope: ['profile', 'email'],
            state: true,
        })(req, res, next);
    } catch (error) {
        next(error);
    }
};

export const googleCallback = async (req, res, next) => {
    try {
        passport.authenticate('google', {
            state: true,
        }, async (err, user, info) => {
            if (err) {
                // Handle provider conflict error
                if (err.message && err.message.startsWith('ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER:')) {
                    const provider = err.message.split(':')[1];
                    const providerName = getProviderDisplayName(provider);
                    const errorMessage = `This email is already registered via ${providerName}. Please log in with ${providerName} instead.`;
                    return res.redirect(`${FRONTEND_URL}/login?error=${encodeURIComponent(errorMessage)}`);
                }
                if (err.message === 'GOOGLE_EMAIL_NOT_VERIFIED') {
                    return res.redirect(
                        `${FRONTEND_URL}/login?error=${encodeURIComponent('Your Google account email is not verified yet. Verify it with Google, or sign up with email and password.')}`
                    );
                }
                console.error('[Auth] Google sign-in failed:', err.message);
                return res.redirect(`${FRONTEND_URL}/login?error=${encodeURIComponent('Google sign-in did not complete. Try again, or log in with email.')}`);
            }

            if (!user) {
                // Usually the user cancelled on Google's screen, or the sign-in took too long.
                return res.redirect(`${FRONTEND_URL}/login?error=${encodeURIComponent('Google sign-in was cancelled or expired. Try again.')}`);
            }

            // Generate access and refresh tokens for the user
            const { accessToken, refreshToken } = await generateAccessToken(user._id, User, "User");

            // Get user without sensitive fields. .lean() bypasses the schema toJSON
            // transform, so explicit exclusion is required even though this value
            // is currently unused before the redirect.
            const loggedInUser = await User.findById(user._id)
                .select("-password -refreshToken -emailVerificationToken")
                .lean();

            // Set cookies
            res.cookie("accessToken", accessToken, COOKIE_OPTIONS);
            res.cookie("refreshToken", refreshToken, { ...COOKIE_OPTIONS, maxAge: 30 * 24 * 60 * 60 * 1000 }); // 30 days

            const defaultRedirect = `${FRONTEND_URL}/auth/google/callback`;
            const fromSession = req.session.redirectUrl;
            delete req.session.redirectUrl;
            const funnel = req.session.funnel;
            delete req.session.funnel;
            const target = new URL(getSafeOAuthRedirectUrl(fromSession) || defaultRedirect);
            target.searchParams.set('auth', 'success');

            const isNewUser = loggedInUser?.createdAt
                && Date.now() - new Date(loggedInUser.createdAt).getTime() < NEW_GOOGLE_USER_WINDOW_MS;
            if (isNewUser) {
                target.searchParams.set('new', '1');
                captureServerEvent(user._id, 'user_signed_up', {
                    method: 'google',
                    ...attributionEventProperties(funnel?.attribution)
                });
            }

            if (isFunnelV2Enabled()) {
                if (funnel?.attribution) await storeFirstTouchAttribution(user._id, funnel.attribution);
                const link = await linkFunnelSafely(user._id, funnel?.sessionId);
                if (link.linked) {
                    const { state } = await resolveAccess(loggedInUser);
                    const hasUploaded = Boolean(await Video.exists({ uploader_id: user._id }));
                    target.searchParams.set('next', computePostAuthPath(state, { hasUploaded }));
                }
            }

            res.redirect(target.toString());
        })(req, res, next);
    } catch (error) {
        next(error);
    }
};

export const googleAuthFailure = (req, res) => {
    res.redirect(`${FRONTEND_URL}/login?error=${encodeURIComponent('Google sign-in did not complete. Try again, or log in with email.')}`);
};

// Refresh Token Controller
// Source order: body first (form users), cookie second (OAuth users on HttpOnly-only path).
export const refreshToken = async (req, res, next) => {
    try {
        const bodyToken = req.body?.refreshToken;
        const cookieToken = req.cookies?.refreshToken;
        const tokenIn = bodyToken || cookieToken;

        if (!tokenIn) {
            throw new ApiError(400, "Refresh token is required");
        }

        const { accessToken, refreshToken: newRefreshToken } = await refreshTokenService(tokenIn);

        res.status(200)
            .cookie("accessToken", accessToken, COOKIE_OPTIONS)
            .cookie("refreshToken", newRefreshToken, { ...COOKIE_OPTIONS, maxAge: 30 * 24 * 60 * 60 * 1000 }) // 30 days
            .json(
                ApiResponse.success(
                    200,
                    "Token refreshed successfully",
                    {
                        accessToken,
                        refreshToken: newRefreshToken
                    }
                )
            );
    } catch (error) {
        next(error);
    }
};

// POST /auth/attribution - set-once first-touch attribution for users who did
// not sign up through the email form (e.g. Google OAuth). Admins are ignored.
export const saveAttribution = async (req, res, next) => {
    try {
        if (!req.user || !req.user._id) {
            throw new ApiError(401, "Authentication required");
        }
        const stored = await storeFirstTouchAttribution(req.user._id, req.body?.attribution);
        res.status(200).json(
            ApiResponse.success(200, stored ? "Attribution stored" : "Attribution unchanged", { stored })
        );
    } catch (error) {
        next(error);
    }
};

// Session identity echo. Lives behind authenticateToken; req.user is already hydrated.
// Used by the frontend after a cross-site Google OAuth redirect to populate Redux
// without embedding tokens in the URL.
export const getMe = async (req, res, next) => {
    try {
        if (!req.user || !req.user._id) {
            throw new ApiError(401, "Authentication required");
        }
        const data = { user: req.user };
        if (req.user.role === ROLES.USER) {
            const [{ state, entitled }, uploaded] = await Promise.all([
                resolveAccess(req.user),
                Video.exists({ uploader_id: req.user._id }),
            ]);
            const hasUploaded = Boolean(uploaded);
            data.access = { state, entitled };
            data.onboarding = { hasUploaded, nextPath: computePostAuthPath(state, { hasUploaded }) };
        }
        res.status(200).json(
            ApiResponse.success(200, "Authenticated", data)
        );
    } catch (error) {
        next(error);
    }
};
// POST /auth/forgot-password { email } - always the same answer (no account discovery).
export const forgotPassword = async (req, res, next) => {
    try {
        const result = await forgotPasswordService(req.body?.email);
        res.status(200).json(ApiResponse.success(200, result.message, { sent: true }));
    } catch (error) {
        next(error);
    }
};

// POST /auth/reset-password { token, password } - sets the password and signs out every device.
export const resetPassword = async (req, res, next) => {
    try {
        const result = await resetPasswordService(req.body?.token, req.body?.password);
        res.clearCookie("accessToken", COOKIE_OPTIONS);
        res.clearCookie("refreshToken", COOKIE_OPTIONS);
        res.status(200).json(ApiResponse.success(200, result.message, { email: result.email }));
    } catch (error) {
        next(error);
    }
};
