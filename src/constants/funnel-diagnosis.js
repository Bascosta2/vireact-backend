/**
 * Deterministic quiz diagnosis copy (plan §6.2). No statistics, percentages or
 * performance claims: this is advice keyed on the answers, not a measurement.
 */
const NICHE_LABELS = Object.freeze({
    education: 'education',
    business_finance: 'business and finance',
    entertainment_comedy: 'entertainment and comedy',
    lifestyle_vlog: 'lifestyle and vlog',
    gaming: 'gaming',
    fitness_health: 'fitness and health',
    beauty_fashion: 'beauty and fashion',
    food: 'food',
    tech: 'tech',
    other: 'your niche',
});

const PLATFORM_LABELS = Object.freeze({
    tiktok: 'TikTok',
    reels: 'Instagram Reels',
    shorts: 'YouTube Shorts',
    all: 'short-form feeds',
});

const PROBLEM_COPY = Object.freeze({
    swipe_first_3s: {
        headline: 'Viewers decide in the first seconds, and your opening is losing them',
        body: ({ niche, platform }) =>
            `On ${platform}, ${niche} viewers swipe when the first line doesn't give them a reason to stay. Lead with the most surprising or high-stakes part of the video, say it in one short sentence, and show it on screen at the same time. The hooks below are written for exactly that moment.`,
        nextStep: 'Rewrite your next opening line with one of these patterns, then upload the video so we can check the first seconds frame by frame.',
    },
    views_plateau: {
        headline: 'Your videos reach the same audience and stop there',
        body: ({ niche, platform }) =>
            `When ${niche} videos on ${platform} stall at a similar range, the opening usually speaks only to people who already follow you. Hooks built on a strong opinion, a mystery or a surprising fact give new viewers a reason to stop. Start with the patterns below.`,
        nextStep: 'Pick one pattern, test it on your next post, and upload the video to see where viewers drop.',
    },
    mid_video_dropoff: {
        headline: 'You win the start, then lose viewers in the middle',
        body: ({ niche, platform }) =>
            `A strong opening only buys a few seconds. ${niche[0].toUpperCase()}${niche.slice(1)} videos on ${platform} hold viewers when there is a fresh reason to keep watching halfway through: an open question, a reveal that is still coming, or on-screen text that resets attention. The lines below are made for that point in the video.`,
        nextStep: 'Upload a video and the analysis will point to the exact timestamps where attention drops.',
    },
    dont_know_what_to_post: {
        headline: 'The problem is the idea, not the edit',
        body: ({ niche, platform }) =>
            `When you're unsure what to post, borrow a proven shape instead of starting from a blank page. These hook patterns work as ${niche} video ideas on ${platform}: fill each one with something true from your own experience and you have a concept, an opening line and a reason to finish the video.`,
        nextStep: 'Turn one of these into your next video, then upload it for frame-by-frame feedback.',
    },
    inconsistent_results: {
        headline: 'Some videos take off and others don\'t, and you can\'t see why',
        body: ({ niche, platform }) =>
            `Uneven results on ${platform} usually come from openings that change in strength from video to video. Using a small set of reliable hook patterns for your ${niche} content makes the first seconds consistent, so you can tell which other changes actually matter.`,
        nextStep: 'Use these patterns for your next few posts and upload each one to compare where viewers leave.',
    },
});

export function buildDiagnosis({ problem, niche, platform } = {}) {
    const copy = PROBLEM_COPY[problem];
    if (!copy) return null;
    const vars = { niche: NICHE_LABELS[niche] || NICHE_LABELS.other, platform: PLATFORM_LABELS[platform] || PLATFORM_LABELS.all };
    return { headline: copy.headline, body: copy.body(vars), nextStep: copy.nextStep };
}
