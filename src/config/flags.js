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

export const hasEditorAccess = (user) => {
    if (isEditorEnabled()) return true;
    const email = String(user?.email || '').trim().toLowerCase();
    if (!email) return false;
    return String(process.env.EDITOR_BETA_EMAILS || '').split(',').some((e) => e.trim().toLowerCase() === email);
};

export const ACCESS_MODELS =Object.freeze({ LEGACY_FREE: 'legacy_free', CARD_TRIAL: 'card_trial' });

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
