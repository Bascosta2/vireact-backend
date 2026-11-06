import { Router } from "express";
import passport from '../lib/passport.js';
import {
    signup,
    login,
    logout,
    verifyEmail,
    resendEmailVerification,
    googleAuth,
    googleCallback,
    googleAuthFailure,
    refreshToken,
    getMe,
    saveAttribution,
    forgotPassword,
    resetPassword
} from '../controller/auth.controller.js';
import { authenticateToken, optionalAuth } from '../middleware/auth.js';

const authRoutes = Router();

// Regular auth routes
authRoutes.post('/signup', signup);
authRoutes.post('/login', login);
// Logout requires authentication so the server can revoke the caller's
// persisted refresh token. Clients with already-expired access tokens will
// receive 401 here; the frontend should treat that as "already logged out"
// and clear local state.
// Logout works with an expired access token too: the refresh cookie identifies the device to sign out.
authRoutes.post('/logout', optionalAuth, logout);
authRoutes.post('/refresh-token', refreshToken);
authRoutes.post('/verify-email', verifyEmail);
authRoutes.post('/resend-verification', resendEmailVerification);
authRoutes.post('/forgot-password', forgotPassword);
authRoutes.post('/reset-password', resetPassword);

// Session identity echo for OAuth hydration (cookie- or Bearer-authenticated).
authRoutes.get('/me', authenticateToken, getMe);
authRoutes.post('/attribution', authenticateToken, saveAttribution);

// Google OAuth routes
authRoutes.get('/google', googleAuth);
authRoutes.get('/google/callback', googleCallback);
authRoutes.get('/google/failure', googleAuthFailure);

export default authRoutes;