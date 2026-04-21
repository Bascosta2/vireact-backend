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


import { NODE_ENV, SESSION_SECRET, DB_URL } from './config/index.js';
import { getAllowedCorsOrigins } from './config/cors-allowed-origins.js';
import mongoose from 'mongoose';

// route imports
import authRoutes from './route/auth.route.js';
import earlyAccessRoutes from './route/early-access.route.js';
import videoRoutes from './route/video.route.js';
import chatRoutes from './route/chat.route.js';
import profileRoutes from './route/profile.route.js';
import subscriptionRoutes from './route/subscription.route.js';
import adminRoutes from './route/admin.routes.js';
import { verifyQStashAndParseBody } from './middleware/qstash-verify.js';
import { processVideoAnalysis } from './controller/video.controller.js';

const app = express();

// So req.protocol matches HTTPS when behind ngrok / reverse proxy (needed for QStash signature URL)
app.set('trust proxy', 1);

// Security
app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false
}));

// CORS allowed origins — single source of truth in cors-allowed-origins.js (must match errorHandler).
const allowedOrigins = getAllowedCorsOrigins();

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        console.warn(`⚠️ CORS: Blocked origin ${origin}`);
        return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-admin-key'],
    exposedHeaders: ['Set-Cookie'],
    maxAge: 86400 // 24 hours - cache preflight requests
}));

// Rate limiting: auth + video uploads only (in-memory; never global — QStash/Stripe webhooks are not limited).
// Upstash REST Redis does not support Lua SCRIPT used by rate-limit-redis, so no external store here.
const authRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Too many attempts, please try again later' },
});
const videoUploadRateLimit = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: { error: 'Upload limit reached, please try again later' },
});

// Logging
app.use(morgan('dev'));

// Request logging middleware - log all incoming requests
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  const origin = req.get('origin') || 'no origin';
  console.log(`[${timestamp}] ${req.method} ${req.path} from ${origin}`);
  next();
});

// Stripe webhook route MUST come before express.json() to receive raw body
// This is required for webhook signature verification
app.post('/api/v1/subscription/webhook', 
    express.raw({ type: 'application/json' }), 
    async (req, res, next) => {
        const { handleWebhook } = await import('./controller/subscription.controller.js');
        return handleWebhook(req, res, next);
    }
);

// QStash analyze webhook: raw body required for signature verification
app.post(
    '/api/v1/videos/analyze',
    express.raw({ type: 'application/json' }),
    verifyQStashAndParseBody,
    processVideoAnalysis
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

// Scoped rate limits: /api/v1/auth/* and /api/v1/videos/upload* only
app.use((req, res, next) => {
    const p = req.path || '';
    if (p.startsWith('/api/v1/auth')) {
        return authRateLimit(req, res, next);
    }
    if (p.startsWith('/api/v1/videos/upload')) {
        return videoUploadRateLimit(req, res, next);
    }
    next();
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: Date.now(),
        services: {
            mongo: mongoose.connection.readyState === 1,
            server: true
        }
    });
});

// API health check
app.get('/api/health', async (req, res) => {
    try {
        const mongoose = (await import('mongoose')).default;
        const { isConnected } = await import('./db/index.js');
        
        // Check Redis connection (optional)
        let redisStatus = false;
        try {
            const { Redis } = await import('@upstash/redis');
            const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = await import('./config/index.js');
            if (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN) {
                const redis = new Redis({
                    url: UPSTASH_REDIS_REST_URL,
                    token: UPSTASH_REDIS_REST_TOKEN
                });
                await redis.ping();
                redisStatus = true;
            }
        } catch (redisError) {
            console.log('Redis not configured or unavailable (optional service)');
        }
        
        // Check external service configurations
        const { TWELVE_LABS_API_KEY, OPENAI_API_KEY, JWT_SECRET } = await import('./config/index.js');
        
        res.status(200).json({
            status: 'ok',
            timestamp: Date.now(),
            environment: process.env.NODE_ENV || 'development',
            services: {
                mongo: isConnected(),
                redis: redisStatus,
                server: true,
                twelveLabs: !!TWELVE_LABS_API_KEY,
                twelveLabsUserIndex: !!process.env.TWELVELABS_USER_INDEX,
                twelveLabsDatasetIndex: !!process.env.TWELVELABS_DATASET_INDEX,
                openai: !!OPENAI_API_KEY,
                jwt: !!JWT_SECRET
            }
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            timestamp: Date.now(),
            error: 'health_check_failed'
        });
    }
});

// Database status endpoint
app.get('/api/db-status', async (req, res) => {
    try {
        const mongoose = (await import('mongoose')).default;
        const { isConnected } = await import('./db/index.js');
        
        res.status(200).json({
            connected: isConnected(),
            readyState: mongoose.connection.readyState
        });
    } catch (error) {
        res.status(500).json({
            error: 'db_status_check_failed'
        });
    }
});

// Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/early-access', earlyAccessRoutes);
app.use('/api/v1/videos', videoRoutes);
app.use('/api/v1/chat', chatRoutes);
app.use('/api/v1/profile', profileRoutes);
app.use('/api/v1/subscription', subscriptionRoutes);
app.use('/api/v1/admin', adminRoutes);

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
