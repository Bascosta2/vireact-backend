import { NODE_ENV, STRIPE_PRICE_ID_PREMIUM, STRIPE_PRICE_ID_PRO } from "./config/index.js";

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
  QUEUED: 'queued',
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
// FREE is the default-on-signup state. PREMIUM/PRO purchase via Stripe Checkout.
// ENTERPRISE is sales-led via /contact (no Checkout mapping).
export const SUBSCRIPTION_PLANS = {
  FREE: 'free',
  PREMIUM: 'premium',
  PRO: 'pro',
  ENTERPRISE: 'enterprise'
};

// PLAN LIMITS — real values per Phase 2B tier spec.
// `null` is the unlimited sentinel for Enterprise; consumers MUST short-circuit
// any comparison/CAS on a null limit (see claimVideoMonthlySlot /
// claimChatMessageSlot). Free is 2/month for the monthly counter; the lifetime
// 2-video trial is enforced separately at the upload guard layer.
export const PLAN_LIMITS = {
  free: {
    videosPerMonth: 2,
    chatMessagesPerMonth: 20
  },
  premium: {
    videosPerMonth: 15,
    chatMessagesPerMonth: 100
  },
  pro: {
    videosPerMonth: 30,
    chatMessagesPerMonth: 500
  },
  enterprise: {
    videosPerMonth: null,
    chatMessagesPerMonth: null
  }
};

// Lifetime free-trial video allowance per user account. Enforced via
// assertLifetimeFreeTrialAvailable in subscription.service.js. Independent of
// PLAN_LIMITS[FREE].videosPerMonth (which is the per-period cap). Counter is
// monotonic — never decremented; schema enforces min: 0 on the User field.
export const LIFETIME_FREE_VIDEO_LIMIT = 2;

// Per-tier whitelist of allowed analyzer features. Canonical source of truth
// for both upload-time filtering (video.service.js) and dispatch-time gating
// (video.controller.js processVideoAnalysis). Any feature not in a tier's
// array is silently dropped at both layers — the user is not informed,
// because the frontend should never have offered the feature.
//
// Currently the only gated feature is 'advanced_analytics' (Pro+ only). All
// other analyzers are universal across tiers including Free.
export const PLAN_FEATURES = {
  [SUBSCRIPTION_PLANS.FREE]:       ['hook', 'caption', 'pacing', 'audio', 'views_predictor'],
  [SUBSCRIPTION_PLANS.PREMIUM]:    ['hook', 'caption', 'pacing', 'audio', 'views_predictor'],
  [SUBSCRIPTION_PLANS.PRO]:        ['hook', 'caption', 'pacing', 'audio', 'views_predictor', 'advanced_analytics'],
  [SUBSCRIPTION_PLANS.ENTERPRISE]: ['hook', 'caption', 'pacing', 'audio', 'views_predictor', 'advanced_analytics'],
};

// Returns the allowed feature set for a given plan, or the FREE set as a
// safe fallback for unknown/missing plans (treats any anomaly as least-
// privilege). Used by both the upload filter and the dispatch gate.
export const allowedFeaturesForPlan = (plan) => {
  return PLAN_FEATURES[plan] || PLAN_FEATURES[SUBSCRIPTION_PLANS.FREE];
};

// PLAN PRICES (in cents). Public display prices live in the frontend pricing
// page and are rewritten in Phase 2C — these are internal reference values.
export const PLAN_PRICES = {
  premium: {
    amount: 1500, // $15.00
    currency: 'usd'
  },
  pro: {
    amount: 3000, // $30.00
    currency: 'usd'
  },
  enterprise: {
    amount: null,
    currency: 'usd',
    isContactSales: true
  }
};

// Plans that can be purchased through Stripe Checkout.
// ENTERPRISE is intentionally excluded — it is sales-led via /contact.
export const STRIPE_CHECKOUT_PLANS = [
  SUBSCRIPTION_PLANS.PREMIUM,
  SUBSCRIPTION_PLANS.PRO
];

// STRIPE PRICE IDS — only for Stripe Checkout plans.
export const STRIPE_PRICE_IDS = {
  premium: STRIPE_PRICE_ID_PREMIUM,
  pro: STRIPE_PRICE_ID_PRO
};

// Reverse lookup used by Stripe webhooks (e.g. customer.subscription.updated
// when a user changes tier via the Stripe Customer Portal). Entries whose
// env var is undefined are filtered out so a missing price id does not
// pollute the map with a literal "undefined" key.
export const STRIPE_PRICE_ID_TO_PLAN = Object.freeze(
  Object.fromEntries(
    [
      [STRIPE_PRICE_ID_PREMIUM, SUBSCRIPTION_PLANS.PREMIUM],
      [STRIPE_PRICE_ID_PRO, SUBSCRIPTION_PLANS.PRO]
    ].filter(([priceId]) => Boolean(priceId))
  )
);
