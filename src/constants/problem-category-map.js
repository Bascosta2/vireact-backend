/**
 * Quiz `problem` → ordered hook categories from the owner's PDF (plan §6.3).
 * Category names are the headings read from the 8 KB chunks by
 * scripts/library/extract-drafts.js. Owner review pending (see ops log).
 */
export const MID_VIDEO_TEXT_CATEGORY = 'Format Specific Text to add mid video (Text on screen)';

export const PROBLEM_CATEGORY_MAP = Object.freeze({
    swipe_first_3s: [
        'Content, Curiosity hooks (powerful)',
        'Suspense Shock Hooks',
        'Invoke Fear and Urgency',
        'Surprise Hooks',
        'Danger and High Stakes Hooks',
    ],
    views_plateau: [
        'Hard Truths And Controversy',
        'Psychological and Mystery Hooks',
        'Scary Mind Blowing Facts',
        'Challenge or Extreme Daring Hooks',
        'Reaction and Voiceover-Style Hooks',
    ],
    mid_video_dropoff: [
        MID_VIDEO_TEXT_CATEGORY,
        'Suspense and Scary Stories',
        'Psychological and Mystery Hooks',
        'Suspense Shock Hooks',
    ],
    dont_know_what_to_post: [
        'Relatable Hooks',
        'Money and Success Hooks',
        'Animal and Viral Video Hooks',
        'Challenge or Extreme Daring Hooks',
        'Reaction and Voiceover-Style Hooks',
    ],
    inconsistent_results: [
        'Content, Curiosity hooks (powerful)',
        'Hard Truths And Controversy',
        'Invoke Fear and Urgency',
        'Suspense and Scary Stories',
        'Relatable Hooks',
    ],
});
