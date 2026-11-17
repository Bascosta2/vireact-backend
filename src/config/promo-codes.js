import { SUBSCRIPTION_PLANS } from '../constants.js';

/**
 * Promo codes a signed-in creator can redeem in Settings. Codes are case-insensitive.
 * `days: null` means the plan never expires. Each account can redeem each code once.
 *
 * Owner controls (Railway env, read on every request, no deploy needed):
 *   PROMO_CODES_DISABLED=goat,skyrocket   switch codes off (already granted plans stay)
 *   PROMO_CODE_LIMITS=goat=25             stop a code after this many redemptions in total
 */
export const PROMO_CODES = Object.freeze({
    skyrocket: Object.freeze({ plan: SUBSCRIPTION_PLANS.PREMIUM, days: 30, label: 'Premium for 1 month' }),
    goat: Object.freeze({ plan: SUBSCRIPTION_PLANS.PRO, days: null, label: 'Pro for life' }),
});

const envList = (name) =>
    String(process.env[name] ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

/** What the person typed, as a lookup key: trimmed, lower case, inner spaces removed. */
export const normalizePromoCode = (raw) => String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '');

const maxRedemptionsFor = (code) => {
    for (const pair of envList('PROMO_CODE_LIMITS')) {
        const [key, value] = pair.split('=');
        if (key === code) {
            const n = Number(value);
            return Number.isInteger(n) && n >= 0 ? n : null;
        }
    }
    return null;
};

/** The code's grant, or null when it does not exist or is switched off. */
export const getPromoCode = (code) => {
    if (!code || !Object.hasOwn(PROMO_CODES, code)) return null;
    if (envList('PROMO_CODES_DISABLED').includes(code)) return null;
    return { code, ...PROMO_CODES[code], maxRedemptions: maxRedemptionsFor(code) };
};
