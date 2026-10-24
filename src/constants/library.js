/**
 * Library + quiz taxonomies (plan §5.1, §6.2). Mirrored by the frontend in
 * src/funnel/quiz.config.ts; keep the two lists identical.
 */

export const LIBRARY_ITEM_TYPES = Object.freeze(['hook', 'structure', 'insight']);
export const LIBRARY_VISIBILITY = Object.freeze({ PRIVATE: 'private', MEMBERS: 'members', PUBLIC: 'public' });
export const LIBRARY_REVIEW_STATUS = Object.freeze({ DRAFT: 'draft', APPROVED: 'approved', REJECTED: 'rejected' });
export const LIBRARY_CREATED_BY = Object.freeze(['extractor', 'admin']);
export const LIBRARY_PLATFORMS = Object.freeze(['tiktok', 'reels', 'shorts']);

export const NICHES = Object.freeze([
    'education',
    'business_finance',
    'entertainment_comedy',
    'lifestyle_vlog',
    'gaming',
    'fitness_health',
    'beauty_fashion',
    'food',
    'tech',
    'other',
]);

export const PROBLEMS = Object.freeze([
    'swipe_first_3s',
    'views_plateau',
    'mid_video_dropoff',
    'dont_know_what_to_post',
    'inconsistent_results',
]);
