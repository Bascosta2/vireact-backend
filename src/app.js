import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import MongoStore from 'connect-mongo';


import passport from './lib/passport.js';
import { ApiResponse } from './utils/ApiResponse.js';
import { errorHandler } from './middleware/errorHandler.js';


import { FRONTEND_URL, NODE_ENV, SESSION_SECRET,DB_URL } from './config/index.js';
import { EarlyAccess } from './model/early-access.model.js';

// route imports
import authRoutes from './route/auth.route.js';
import earlyAccessRoutes from './route/early-access.route.js';
import videoRoutes from './route/video.route.js';
import chatRoutes from './route/chat.route.js';
import profileRoutes from './route/profile.route.js';
import subscriptionRoutes from './route/subscription.route.js';

const app = express();

// Security
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false
}));

app.use(cors({
    origin: [
        "https://vireact.io",
        'https://vireact-frontend.vercel.app',
        "https://www.vireact.io",
        "http://localhost:5173",
        "http://192.168.1.112:5173"
    ].filter(Boolean), // Remove any undefined values
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    exposedHeaders: ['Set-Cookie'],
    maxAge: 86400 // 24 hours - cache preflight requests
}));

// Rate limiting (optional in dev)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests, please try again later.'
});
// app.use(limiter);

// Logging
app.use(morgan('dev'));

// Stripe webhook route MUST come before express.json() to receive raw body
// This is required for webhook signature verification
app.post('/api/v1/subscription/webhook', 
    express.raw({ type: 'application/json' }), 
    async (req, res, next) => {
        const { handleWebhook } = await import('./controller/subscription.controller.js');
        return handleWebhook(req, res, next);
    }
);

// Body parsers (applied after webhook route)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Session configuration (only used for OAuth handshake)
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: DB_URL,
        touchAfter: 24 * 3600, // Lazy update (24 hours)
        crypto: {
            secret: SESSION_SECRET
        }
    }),
    cookie: {
        secure: NODE_ENV === 'production',
        httpOnly: true,
        sameSite: NODE_ENV === 'production' ? 'none' : 'lax',
        maxAge: 10 * 60 * 1000 // 10 minutes (OAuth handshake only)
    }
}));

// Passport middleware
app.use(passport.initialize());
app.use(passport.session());

// Health check
app.get('/health', (req, res) => {
    res.
        status(200).
        json(
            ApiResponse
                .success(200, 'Health check successful', null)
        );
});

app.get('/early-access-list', async (req, res) => {
    const earlyAccessList = await EarlyAccess.find()
    res.
        status(200)
        .json(
            ApiResponse.success(200, 'Early access list', earlyAccessList)
        );
});

// Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/early-access', earlyAccessRoutes);
app.use('/api/v1/videos', videoRoutes);
app.use('/api/v1/chat', chatRoutes);
app.use('/api/v1/profile', profileRoutes);
app.use('/api/v1/subscription', subscriptionRoutes);

// 404 handler
app.use((req, res, next) => {
    res.
        status(404)
        .json(ApiResponse
            .error(404, "Route not found")
        );
});

// Centralized error handler
app.use(errorHandler);

export default app;
