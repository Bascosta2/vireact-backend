import './load-env.js';

/**
 * Funnel V2 flags. Each defaults off and is read on every call so a flag can be
 * flipped (or toggled in a test) without re-importing modules.
 */
const isOn = (name) => String(process.env[name] || '').trim().toLowerCase() === 'true';

export const isLibraryEnabled = () => isOn('LIBRARY_ENABLED');
export const isFunnelV2Enabled = () => isOn('FUNNEL_V2_ENABLED');
export const isLifecycleEmailsEnabled = () => isOn('LIFECYCLE_EMAILS_ENABLED');

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
