import { NODE_ENV, STRIPE_PRICE_ID_STARTER, STRIPE_PRICE_ID_PRO } from "./config/index.js";

export const ROLES = {
  ADMIN: "admin",
  SUPER_ADMIN: "super-admin",
  USER: "user"
};

export const OAUTH_PROVIDERS = {
  LOCAL: "local",
  GOOGLE: "google"
};



export const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: NODE_ENV === 'production',
  sameSite: NODE_ENV === 'production' ? 'none' : 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
};

// DATSBASE
export const MAX_RETRIES = 3;
export const RETRY_DELAY = 1000; // Reduced for serverless cold starts
export const CONNECTION_TIMEOUT = 3000; // Reduced timeout for serverless

// VIDEO UPLOAD STATUS
export const UPLOAD_STATUS = {
  PENDING: 'pending',
  UPLOADING: 'uploading',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

// VIDEO ANALYSIS STATUS
export const ANALYSIS_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

// SUBSCRIPTION STATUS
export const SUBSCRIPTION_STATUS = {
  ACTIVE: 'active',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  TRIAL: 'trial'
};

// SUBSCRIPTION PLANS
export const SUBSCRIPTION_PLANS = {
  FREE: 'free',
  STARTER: 'starter',
  PRO: 'pro'
};

// PLAN LIMITS
export const PLAN_LIMITS = {
  free: {
    videosPerMonth: 3,
    chatMessagesPerMonth: 20
  },
  starter: {
    videosPerMonth: 15,
    chatMessagesPerMonth: 100
  },
  pro: {
    videosPerMonth: 40,
    chatMessagesPerMonth: 400
  }
};

// PLAN PRICES (in cents)
export const PLAN_PRICES = {
  starter: {
    amount: 1500, // $15.00
    currency: 'usd'
  },
  pro: {
    amount: 3000, // $30.00
    currency: 'usd'
  }
};

// STRIPE PRICE IDS (to be filled after creating products in Stripe Dashboard)
export const STRIPE_PRICE_IDS = {
  starter: STRIPE_PRICE_ID_STARTER,
  pro: STRIPE_PRICE_ID_PRO
};

