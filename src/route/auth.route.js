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
    getMe
} from '../controller/auth.controller.js';
import { authenticateToken } from '../middleware/auth.js';

const authRoutes = Router();

// Regular auth routes
authRoutes.post('/signup', signup);
authRoutes.post('/login', login);
authRoutes.post('/logout', logout);
authRoutes.post('/refresh-token', refreshToken);
authRoutes.post('/verify-email', verifyEmail);
authRoutes.post('/resend-verification', resendEmailVerification);

// Session identity echo for OAuth hydration (cookie- or Bearer-authenticated).
authRoutes.get('/me', authenticateToken, getMe);

// Google OAuth routes
authRoutes.get('/google', googleAuth);
authRoutes.get('/google/callback', googleCallback);
authRoutes.get('/google/failure', googleAuthFailure);

export default authRoutes;