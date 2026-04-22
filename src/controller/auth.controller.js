import {
    generateAccessToken,
    signupAdminService,
    loginAdminService,
    loginUserService,
    customSignupUserService,
    verifyEmailService,
    resendEmailVerificationService,
    refreshTokenService
} from "../service/auth.service.js";
import { Admin } from "../model/admin.model.js";
import { User } from "../model/user.model.js";
import { COOKIE_OPTIONS, OAUTH_PROVIDERS, ROLES } from "../constants.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import passport from "../lib/passport.js";
import { FRONTEND_URL, NODE_ENV } from "../config/index.js";
import { getSafeOAuthRedirectUrl } from "../utils/oauth-redirect.js";

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

        const user = await customSignupUserService(
            name,
            email,
            password,
            provider
        )

        res.status(201).json(
            ApiResponse.success(
                201,
                "User Created Successfully",
                { user }
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

        const { accessToken, refreshToken } = await generateAccessToken(user._id, User, "User");

        const loggedInUser = await User.findById(user._id).select("-password").lean();
        res.clearCookie("accessToken", COOKIE_OPTIONS)
        res.clearCookie("refreshToken", COOKIE_OPTIONS)

        res.status(200)
            .cookie("accessToken", accessToken, COOKIE_OPTIONS)
            .cookie("refreshToken", refreshToken, { ...COOKIE_OPTIONS, maxAge: 30 * 24 * 60 * 60 * 1000 }) // 30 days
            .json(
                ApiResponse.success(
                    200,
                    "Login Successful",
                    {
                        user: loggedInUser,
                        accessToken,
                        refreshToken
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


// Signup Admin
export const signupAdmin = async (req, res, next) => {
    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            throw new ApiError(400, "All fields are required.")
        }

        const admin = await signupAdminService(name, email, password)

        res.status(201).json({
            message: "Admin Created Successfully",
            id: admin._id.toString()
        });

    } catch (error) {
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
            .select("-password")
            .lean()

        res.clearCookie("accessToken", COOKIE_OPTIONS)
        res.clearCookie("refreshToken", COOKIE_OPTIONS)

        res.status(200)
            .cookie("accessToken", accessToken, COOKIE_OPTIONS)
            .cookie("refreshToken", refreshToken, { ...COOKIE_OPTIONS, maxAge: 30 * 24 * 60 * 60 * 1000 }) // 30 days
            .json({
                message: "Login Successful",
                admin: loggedInAdmin,
                accessToken,
                refreshToken
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
            await signupAdmin(req, res, next);
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
    const { token } = req.query;

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
export const logoutUser = async (req, res, next) => {
    try {
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
                        `${FRONTEND_URL}/auth/error?message=${encodeURIComponent('Google account email must be verified before sign-in.')}`
                    );
                }
                return res.redirect(`${FRONTEND_URL}/auth/error?message=${encodeURIComponent(err.message)}`);
            }

            if (!user) {
                return res.redirect(`${FRONTEND_URL}/auth/error?message=${encodeURIComponent('Authentication failed')}`);
            }

            // Generate access and refresh tokens for the user
            const { accessToken, refreshToken } = await generateAccessToken(user._id, User, "User");

            // Get user without password
            const loggedInUser = await User.findById(user._id).select("-password").lean();

            // Set cookies
            res.cookie("accessToken", accessToken, COOKIE_OPTIONS);
            res.cookie("refreshToken", refreshToken, { ...COOKIE_OPTIONS, maxAge: 30 * 24 * 60 * 60 * 1000 }); // 30 days

            const defaultRedirect = `${FRONTEND_URL}/auth/google/callback`;
            const fromSession = req.session.redirectUrl;
            delete req.session.redirectUrl;
            const redirectUrl = getSafeOAuthRedirectUrl(fromSession) || defaultRedirect;

            res.redirect(`${redirectUrl}?auth=success`);
        })(req, res, next);
    } catch (error) {
        next(error);
    }
};

export const googleAuthFailure = (req, res) => {
    res.redirect(`${FRONTEND_URL}/auth/error?message=${encodeURIComponent('Google authentication failed')}`);
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

// Session identity echo. Lives behind authenticateToken; req.user is already hydrated.
// Used by the frontend after a cross-site Google OAuth redirect to populate Redux
// without embedding tokens in the URL.
export const getMe = async (req, res, next) => {
    try {
        if (!req.user || !req.user._id) {
            throw new ApiError(401, "Authentication required");
        }
        res.status(200).json(
            ApiResponse.success(200, "Authenticated", { user: req.user })
        );
    } catch (error) {
        next(error);
    }
};