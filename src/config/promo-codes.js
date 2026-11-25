import { createHash } from 'node:crypto';
import { SUBSCRIPTION_PLANS } from '../constants.js';

/**
 * Promo codes a signed-in creator can redeem in Settings. Codes are case-insensitive.
 * No code is written in the source (the repos are public): they come from the PROMO_CODES env var,
 * a JSON object keyed by code, e.g.
 *   PROMO_CODES={"SPRING-7Q2X":{"plan":"premium","days":30,"label":"Premium for 1 month","limit":100}}
 * `days: null` (or left out) means the plan never expires; `limit` caps total redemptions (left out = no cap).
 * Bad JSON or a bad entry is logged and ignored (bad JSON means no codes at all). Each account can redeem
 * each code once. Plans already granted keep working whatever this variable says.
 *
 * Owner controls (Railway env, read on every request, no deploy needed):
 *   PROMO_CODES_DISABLED=code1,code2      switch codes off (already granted plans stay)
 *   PROMO_CODE_LIMITS=code1=25            stop a code after this many redemptions in total (overrides `limit`)
 */

const PROMO_PLANS = new Set(Object.values(SUBSCRIPTION_PLANS).filter((plan) => plan !== SUBSCRIPTION_PLANS.FREE));
const CODE_PATTERN = /^[a-z0-9_-]{1,64}$/;
const isCount = (n) => Number.isInteger(n) && n >= 0;

const envList = (name) =>
    String(process.env[name] ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

/** Short, non-reversible reference to a code for logs and analytics (never log or send the code itself). */
export const promoCodeRef = (code) => createHash('sha256').update(String(code ?? '')).digest('hex').slice(0, 10);

/** What the person typed, as a lookup key: trimmed, lower case, inner spaces removed. */
export const normalizePromoCode = (raw) => String(raw ?? '').trim().toLowerCase().replace(/\s+/g, '');

/**
 * Parses the PROMO_CODES value into a Map of code -> { plan, days, label, limit }.
 * Never throws: bad JSON gives no codes, a bad entry is skipped. Logs never include the codes themselves.
 */
export const parsePromoCodes = (raw, log = console) => {
    const codes = new Map();
    if (raw == null || String(raw).trim() === '') return codes;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        log.error('[Promo] PROMO_CODES is not valid JSON; no promo codes are active.');
        return codes;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        log.error('[Promo] PROMO_CODES must be a JSON object keyed by code; no promo codes are active.');
        return codes;
    }
    Object.entries(parsed).forEach(([rawCode, entry], index) => {
        const code = normalizePromoCode(rawCode);
        const days = entry?.days ?? null;
        const limit = entry?.limit ?? null;
        const valid = CODE_PATTERN.test(code)
            && entry && typeof entry === 'object'
            && PROMO_PLANS.has(entry.plan)
            && (days === null || (Number.isInteger(days) && days > 0))
            && (limit === null || isCount(limit))
            && (entry.label === undefined || (typeof entry.label === 'string' && entry.label.trim()));
        if (!valid || codes.has(code)) {
            log.error(`[Promo] PROMO_CODES entry #${index + 1} is invalid or a duplicate and was ignored.`);
            return;
        }
        const label = entry.label?.trim() || `${entry.plan[0].toUpperCase()}${entry.plan.slice(1)} ${days ? `for ${days} days` : 'for life'}`;
        codes.set(code, Object.freeze({ plan: entry.plan, days, label, limit }));
    });
    return codes;
};

let cache = { raw: undefined, codes: new Map() };

/** The configured codes. Re-parsed only when PROMO_CODES changes. */
export const loadPromoCodes = () => {
    const raw = process.env.PROMO_CODES;
    if (raw !== cache.raw) cache = { raw, codes: parsePromoCodes(raw) };
    return cache.codes;
};

const limitOverride = (code) => {
    for (const pair of envList('PROMO_CODE_LIMITS')) {
        const [key, value] = pair.split('=');
        if (key === code) {
            const n = Number(value);
            // A value that is not a whole number is ignored, so it can never lift the JSON `limit`.
            return isCount(n) ? n : undefined;
        }
    }
    return undefined;
};

/** The code's grant, or null when it does not exist or is switched off. */
export const getPromoCode = (code) => {
    const promo = code ? loadPromoCodes().get(code) : undefined;
    if (!promo) return null;
    if (envList('PROMO_CODES_DISABLED').includes(code)) return null;
    const override = limitOverride(code);
    return { code, plan: promo.plan, days: promo.days, label: promo.label, maxRedemptions: override === undefined ? promo.limit : override };
};

// Validate (and log problems with) PROMO_CODES once at startup.
const startupCount = loadPromoCodes().size;
if (startupCount) console.log(`[Promo] ${startupCount} promo code(s) configured.`);
