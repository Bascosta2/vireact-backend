import 'dotenv/config'

// Server port
export const PORT = process.env.PORT || 5000;

// Environment
export const NODE_ENV = process.env.NODE_ENV;

// Frontend & Backend URLs
export const FRONTEND_URL = process.env.FRONTEND_URL;
export const BACKEND_URL = process.env.BACKEND_URL;

// Database Credentials
export const DB_NAME = process.env.DB_NAME;
export const DB_PASSWORD = process.env.DB_PASSWORD;
export const DB_URL = process.env.DB_URL;

// Third Party API & Keys
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const RESEND_API_KEY = process.env.RESEND_API_KEY;
export const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
export const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
export const AWS_S3_BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME;
export const AWS_S3_REGION = process.env.AWS_S3_REGION;

// Redis Configuration
export const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
export const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// QStash
export const QSTASH_URL = process.env.QSTASH_URL;
export const QSTASH_TOKEN = process.env.QSTASH_TOKEN;
export const QSTASH_CURRENT_SIGNING_KEY = process.env.QSTASH_CURRENT_SIGNING_KEY;
export const QSTASH_NEXT_SIGNING_KEY = process.env.QSTASH_NEXT_SIGNING_KEY;

// Twelve Labs API Key
export const TWELVE_LABS_API_KEY = process.env.TWELVE_LABS_API_KEY;
export const TWELVE_LABS_INDEX_ID = process.env.TWELVE_LABS_INDEX_ID;

// MongoDB Vector Index for KnowledgeBase
export const KNOWLEDGE_BASE_VECTOR_INDEX = process.env.KNOWLEDGE_BASE_VECTOR_INDEX

// JWT Secret Key
export const JWT_SECRET = process.env.JWT_SECRET;
export const ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || JWT_SECRET;

// Google OAuth Configuration
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
export const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
export const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL;

// Session Secret
export const SESSION_SECRET = process.env.SESSION_SECRET || JWT_SECRET;

// Lambda check
export const IS_LAMBDA = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);

// Stripe Configuration
export const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY;
export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
export const STRIPE_PRICE_ID_STARTER = process.env.STRIPE_PRICE_ID_STARTER;
export const STRIPE_PRICE_ID_PRO = process.env.STRIPE_PRICE_ID_PRO;
