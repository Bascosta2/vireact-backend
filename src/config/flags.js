import './load-env.js';

/**
 * Funnel V2 flags. Each defaults off and is read on every call so a flag can be
 * flipped (or toggled in a test) without re-importing modules.
 */
const isOn = (name) => String(process.env[name] || '').trim().toLowerCase() === 'true';

export const isLibraryEnabled = () => isOn('LIBRARY_ENABLED');
export const isFunnelV2Enabled = () => isOn('FUNNEL_V2_ENABLED');
export const isLifecycleEmailsEnabled = () => isOn('LIFECYCLE_EMAILS_ENABLED');

/**
 * Editor tab private beta. Off (default): only accounts listed in EDITOR_BETA_EMAILS (comma-separated)
 * can use the editor; everyone else gets no tab and a 404 from the API. EDITOR_ENABLED=true opens it to all.
 */
export const isEditorEnabled = () => isOn('EDITOR_ENABLED');

/**
 * Editor features V2 (brand sheet, split screen, storyboard review, screen recordings). Off (default):
 * the editor behaves exactly as before and the new endpoints answer 404.
 */
export const isEditorFeaturesV2 = () => isOn('EDITOR_FEATURES_V2');

export const hasEditorAccess = (user) => {
    if (isEditorEnabled()) return true;
    const email = String(user?.email || '').trim().toLowerCase();
    if (!email) return false;
    return String(process.env.EDITOR_BETA_EMAILS || '').split(',').some((e) => e.trim().toLowerCase() === email);
};

/**
 * Accounts tab (connected TikTok / YouTube / Instagram accounts) private beta, same pattern as the editor:
 * off (default) = only ACCOUNTS_BETA_EMAILS see it; ACCOUNTS_ENABLED=true opens it to everyone.
 */
export const isAccountsEnabled = () => isOn('ACCOUNTS_ENABLED');

export const hasAccountsAccess = (user) => {
    if (isAccountsEnabled()) return true;
    const email = String(user?.email || '').trim().toLowerCase();
    if (!email) return false;
    return String(process.env.ACCOUNTS_BETA_EMAILS || '').split(',').some((e) => e.trim().toLowerCase() === email);
};

/**
 * Scheduled posting to the user's connected accounts (src/service/publish/), same pattern again:
 * off (default) = only PUBLISHING_BETA_EMAILS can schedule; PUBLISHING_ENABLED=true opens it to everyone.
 * PUBLISHING_DRY_RUN=true simulates every post (nothing reaches a platform) so the flow can be tested
 * before the platforms approve the app.
 */
export const isPublishingEnabled = () => isOn('PUBLISHING_ENABLED');
export const isPublishingDryRun = () => isOn('PUBLISHING_DRY_RUN');

export const hasPublishingAccess = (user) => {
    if (isPublishingEnabled()) return true;
    const email = String(user?.email || '').trim().toLowerCase();
    if (!email) return false;
    return String(process.env.PUBLISHING_BETA_EMAILS || '').split(',').some((e) => e.trim().toLowerCase() === email);
};

/**
 * Meta data-deletion and deauthorize callbacks (POST /api/v1/meta/data-deletion, /api/v1/meta/deauthorize).
 * Off (default): both answer 404, as before. Turn on with FACEBOOK_APP_SECRET and/or INSTAGRAM_APP_SECRET set.
 * Deliberately not gated: GET /api/v1/meta/data-deletion/:code and the daily finisher of pending deletions,
 * so requests already accepted still complete and stay checkable if the flag is turned off again.
 */
export const isMetaDataDeletionEnabled = () => isOn('META_DATA_DELETION_ENABLED');

/**
 * 7-day free trial of a paid plan through Stripe Checkout (card required, $0 today). On unless
 * TRIAL_BILLING_ENABLED is exactly 'false'. One trial per account (Subscription.trialUsedAt).
 */
export const isTrialBillingEnabled = () => String(process.env.TRIAL_BILLING_ENABLED ?? '').trim().toLowerCase() !== 'false';

export const ACCESS_MODELS = Object.freeze({ LEGACY_FREE: 'legacy_free', CARD_TRIAL: 'card_trial' });

/** legacy_free (default, current behavior) or card_trial. Unknown values fall back to legacy_free. */
export const getNewUserAccessModel = () => {
    const value = String(process.env.NEW_USER_ACCESS_MODEL || '').trim().toLowerCase();
    return value === ACCESS_MODELS.CARD_TRIAL ? ACCESS_MODELS.CARD_TRIAL : ACCESS_MODELS.LEGACY_FREE;
};

const positiveInt = (name, fallback) => {
    const n = Number.parseInt(process.env[name], 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Hook rewriter limits (plan §6.6). */
export const getHookRewriteLimits = () => ({
    perSession: positiveInt('HOOK_REWRITE_PER_SESSION', 1),
    anonPerIpPerDay: positiveInt('HOOK_REWRITE_ANON_PER_IP_PER_DAY', 5),
    entitledPerDay: positiveInt('HOOK_REWRITE_ENTITLED_PER_DAY', 50),
});

/** Trial length and the caps that apply while a subscription is trialing (the plan's own cap wins if lower). */
export const getTrialConfig = () => ({
    days: positiveInt('TRIAL_DAYS', 7),
    videoLimit: positiveInt('TRIAL_VIDEO_LIMIT', 5),
    chatMessageLimit: positiveInt('TRIAL_CHAT_MESSAGE_LIMIT', 60),
});
