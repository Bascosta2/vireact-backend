/**
 * What the creator posts and how often (Analytics tab). Saved on user.creatorProfile; until they save
 * one, it is derived from their funnel quiz answers (user.onboarding.answers) when those exist.
 */
import { NICHES } from '../constants/library.js';
import { ApiError } from '../utils/ApiError.js';
import { PLATFORMS, normalizeFollowers } from './view-prediction.service.js';

export const GOALS = Object.freeze(['grow_followers', 'more_views', 'monetize', 'brand']);
export const DEFAULT_POSTS_PER_WEEK = 3;
export const MAX_POSTS_PER_WEEK = 21;

// Quiz answers use funnel buckets; map them to profile values.
const QUIZ_PLATFORM = { tiktok: ['tiktok'], reels: ['instagram'], shorts: ['youtube'], all: ['tiktok', 'instagram', 'youtube'] };
const QUIZ_FOLLOWERS = { lt_1k: 500, '1k_10k': 5_000, '10k_100k': 50_000, '100k_1m': 500_000, gt_1m: 2_000_000 };
const QUIZ_CADENCE = { '0_1': 1, '2_4': 3, '5_10': 7, '10_plus': 12 };
const QUIZ_GOAL = { views_plateau: 'more_views', swipe_first_3s: 'more_views', mid_video_dropoff: 'more_views' };

export const isValidTimezone = (tz) => {
    if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
};

const fromQuiz = (answers = {}) => ({
    niche: NICHES.includes(answers.niche) ? answers.niche : null,
    platforms: QUIZ_PLATFORM[answers.platform] ?? [],
    followers: QUIZ_FOLLOWERS[answers.followers] ?? null,
    goal: QUIZ_GOAL[answers.problem] ?? null,
    postsPerWeek: QUIZ_CADENCE[answers.cadence] ?? null,
});

/** Saved profile, else quiz-derived values, else empty. `source` tells the UI which. */
export const resolveCreatorProfile = (user) => {
    const saved = user?.creatorProfile;
    const quiz = fromQuiz(user?.onboarding?.answers);
    const hasSaved = Boolean(saved?.updatedAt);
    const base = hasSaved ? saved : quiz;
    const profile = {
        niche: base.niche ?? null,
        platforms: Array.isArray(base.platforms) ? [...base.platforms] : [],
        followers: base.followers ?? null,
        goal: base.goal ?? null,
        postsPerWeek: base.postsPerWeek ?? null,
        preferredDays: hasSaved && Array.isArray(saved.preferredDays) ? [...saved.preferredDays] : [],
        timezone: hasSaved && isValidTimezone(saved.timezone) ? saved.timezone : null,
        updatedAt: hasSaved ? saved.updatedAt : null,
    };
    const source = hasSaved ? 'saved' : (user?.onboarding?.answers ? 'quiz' : 'empty');
    // Enough to write a strategy: a niche, at least one platform and a posting rhythm.
    const complete = Boolean(profile.niche && profile.platforms.length && profile.postsPerWeek);
    return { ...profile, source, complete };
};

/** Validates a full profile body. Throws ApiError(400) with a user-facing message. */
export const normalizeCreatorProfileInput = (body = {}) => {
    if (!NICHES.includes(body.niche)) throw new ApiError(400, 'Pick your niche from the list.');
    const platforms = [...new Set(Array.isArray(body.platforms) ? body.platforms : [])];
    if (!platforms.length || !platforms.every((p) => PLATFORMS.includes(p))) {
        throw new ApiError(400, 'Pick at least one platform you post on.');
    }
    const followers = body.followers === undefined || body.followers === null || body.followers === ''
        ? null
        : normalizeFollowers(body.followers);
    if (followers === null && body.followers !== undefined && body.followers !== null && body.followers !== '') {
        throw new ApiError(400, 'Enter your follower count as a whole number.');
    }
    if (!GOALS.includes(body.goal)) throw new ApiError(400, 'Pick your main goal.');
    const postsPerWeek = Number(body.postsPerWeek);
    if (!Number.isInteger(postsPerWeek) || postsPerWeek < 1 || postsPerWeek > MAX_POSTS_PER_WEEK) {
        throw new ApiError(400, `Posts per week must be between 1 and ${MAX_POSTS_PER_WEEK}.`);
    }
    const days = Array.isArray(body.preferredDays) ? body.preferredDays.map(Number) : [];
    if (!days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw new ApiError(400, 'Pick days of the week from the list.');
    const preferredDays = [...new Set(days)].sort((a, b) => a - b);
    const timezone = body.timezone == null || body.timezone === '' ? 'UTC' : body.timezone;
    if (!isValidTimezone(timezone)) throw new ApiError(400, 'That time zone is not recognised.');
    return { niche: body.niche, platforms, followers, goal: body.goal, postsPerWeek, preferredDays, timezone, updatedAt: new Date() };
};
