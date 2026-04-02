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
import { FRONTEND_URL } from "../config/index.js";

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
    
    console.log('\n🔐 [LOGIN] Login attempt started');
    console.log(`   Email: ${email ? email : 'NOT PROVIDED'}`);
    console.log(`   Password: ${password ? '***' : 'NOT PROVIDED'}`);
    console.log(`   IP: ${req.ip || req.socket.remoteAddress}`);
    console.log(`   User-Agent: ${req.get('user-agent') || 'unknown'}`);
    
    try {
        // Step 1: Validate input
        console.log('   [STEP 1] Validating input...');
        if (!email || !password) {
            console.log('   ❌ [STEP 1] Validation failed: Email or password missing');
            throw new ApiError(400, "Email and Password are required fields.")
        }
        console.log('   ✅ [STEP 1] Input validation passed');

        // Step 2: Authenticate user
        console.log('   [STEP 2] Authenticating user...');
        const user = await loginUserService(email, password);
        console.log(`   ✅ [STEP 2] User authenticated: ${user._id}`);

        // Step 3: Generate tokens
        console.log('   [STEP 3] Generating access tokens...');
        const { accessToken, refreshToken } = await generateAccessToken(user._id, User, "User");
        console.log('   ✅ [STEP 3] Tokens generated successfully');

        // Step 4: Fetch user data
        console.log('   [STEP 4] Fetching user data...');
        const loggedInUser = await User.findById(user._id).select("-password").lean();
        console.log('   ✅ [STEP 4] User data fetched');

        // Step 5: Set cookies and send response
        console.log('   [STEP 5] Setting cookies and preparing response...');
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
        
        const duration = Date.now() - startTime;
        console.log(`   ✅ [LOGIN] Login successful in ${duration}ms`);
        console.log(`   User ID: ${user._id}\n`);

    }
    catch (error) {
        const duration = Date.now() - startTime;
        console.error(`   ❌ [LOGIN] Login failed after ${duration}ms`);
        console.error(`   Error: ${error.message}`);
        console.error(`   Status Code: ${error.statusCode || 500}`);
        if (error.stack) {
            console.error(`   Stack: ${error.stack}`);
        }
        console.log('');
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
    console.log('\n📥 [AUTH ROUTE] Login request received');
    console.log(`   Route: POST /api/v1/auth/login`);
    console.log(`   Body:`, { ...req.body, password: req.body.password ? '***' : undefined });
    console.log(`   Headers:`, {
        'content-type': req.get('content-type'),
        'origin': req.get('origin'),
        'user-agent': req.get('user-agent')?.substring(0, 50) + '...'
    });
    
    try {
        const { role } = req.body;
        console.log(`   Role requested: ${role || 'not specified'}`);

        if (role === ROLES.ADMIN) {
            console.log('   → Routing to admin login');
            await loginAdmin(req, res, next);
        }
        else if (role === ROLES.USER) {
            console.log('   → Routing to user login');
            await loginUser(req, res, next);
        }
        else {
            console.log(`   ❌ Invalid role: ${role}`);
            throw new ApiError(400, "Invalid User Type.");
        }
    } catch (error) {
        console.error(`   ❌ [AUTH ROUTE] Error in login handler: ${error.message}`);
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
        // Store the intended redirect URL in session
        if (req.query.redirect) {
            req.session.redirectUrl = req.query.redirect;
        }

        // Authenticate with Google
        passport.authenticate('google', {
            scope: ['profile', 'email']
        })(req, res, next);
    } catch (error) {
        next(error);
    }
};

export const googleCallback = async (req, res, next) => {
    try {
        passport.authenticate('google', async (err, user, info) => {
            if (err) {
                // Handle provider conflict error
                if (err.message && err.message.startsWith('ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER:')) {
                    const provider = err.message.split(':')[1];
                    const providerName = getProviderDisplayName(provider);
                    const errorMessage = `This email is already registered via ${providerName}. Please log in with ${providerName} instead.`;
                    return res.redirect(`${FRONTEND_URL}/login?error=${encodeURIComponent(errorMessage)}`);
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

            // Redirect to frontend with success
            const redirectUrl = req.session.redirectUrl || `${FRONTEND_URL}/auth/google/callback`;
            delete req.session.redirectUrl; // Clean up session

            // Redirect with user data as query params (for frontend to handle)
            const userData = encodeURIComponent(JSON.stringify({
                user: loggedInUser,
                accessToken,
                refreshToken
            }));

            res.redirect(`${redirectUrl}?auth=success&data=${userData}`);
        })(req, res, next);
    } catch (error) {
        next(error);
    }
};

export const googleAuthFailure = (req, res) => {
    res.redirect(`${FRONTEND_URL}/auth/error?message=${encodeURIComponent('Google authentication failed')}`);
};

// Refresh Token Controller
export const refreshToken = async (req, res, next) => {
    try {
        const { refreshToken } = req.body;

        if (!refreshToken) {
            throw new ApiError(400, "Refresh token is required");
        }

        const { accessToken, refreshToken: newRefreshToken } = await refreshTokenService(refreshToken);

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