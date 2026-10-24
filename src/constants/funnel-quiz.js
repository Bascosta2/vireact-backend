import { NICHES, PROBLEMS } from './library.js';
import { SUBSCRIPTION_PLANS } from '../constants.js';

/** Quiz answer enums (plan §6.1). Labels live in the frontend quiz config. */
export const QUIZ_OPTIONS = Object.freeze({
    platform: Object.freeze(['tiktok', 'reels', 'shorts', 'all']),
    niche: NICHES,
    followers: Object.freeze(['lt_1k', '1k_10k', '10k_100k', '100k_1m', 'gt_1m']),
    problem: PROBLEMS,
    cadence: Object.freeze(['0_1', '2_4', '5_10', '10_plus']),
    persona: Object.freeze(['solo_creator', 'brand_business', 'agency_multi_creator']),
});

export const QUIZ_KEYS = Object.freeze(Object.keys(QUIZ_OPTIONS));

export const FUNNEL_STATUSES = Object.freeze([
    'started',
    'completed',
    'email_captured',
    'account_created',
    'trial_started',
    'first_upload',
]);

/** Status only moves forward. */
export const statusRank = (status) => FUNNEL_STATUSES.indexOf(status);

/** Keeps only known keys with allowed values. Returns { answers, errors }. */
export function sanitizeAnswers(input) {
    const answers = {};
    const errors = [];
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { answers, errors };
    for (const key of QUIZ_KEYS) {
        if (input[key] === undefined) continue;
        if (QUIZ_OPTIONS[key].includes(input[key])) answers[key] = input[key];
        else errors.push(`${key} is invalid`);
    }
    return { answers, errors };
}

export const isQuizComplete = (answers) => QUIZ_KEYS.every((key) => QUIZ_OPTIONS[key].includes(answers?.[key]));

const atLeast = (value, list, threshold) => list.indexOf(value) >= list.indexOf(threshold);

/** Plan §6.4. */
export function isHighIntent({ persona, followers, cadence }) {
    if (persona === 'agency_multi_creator') return true;
    if (atLeast(followers, QUIZ_OPTIONS.followers, '100k_1m')) return true;
    return persona === 'brand_business' && atLeast(cadence, QUIZ_OPTIONS.cadence, '5_10');
}

/** Plan §6.4: Pro for larger accounts or non-solo personas, otherwise the mid tier (premium). */
export function recommendedPlanFor({ persona, followers }) {
    if (atLeast(followers, QUIZ_OPTIONS.followers, '10k_100k') || persona !== 'solo_creator') {
        return SUBSCRIPTION_PLANS.PRO;
    }
    return SUBSCRIPTION_PLANS.PREMIUM;
}

export const segmentFor = ({ persona, followers }) => `${persona}:${followers}`;
