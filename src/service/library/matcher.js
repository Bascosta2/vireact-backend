import { PROBLEM_CATEGORY_MAP, MID_VIDEO_TEXT_CATEGORY } from '../../constants/problem-category-map.js';

export const MIN_RESULTS = 3;
export const MAX_RESULTS = 5;

const fitsPlatform = (item, platform) =>
    !platform || platform === 'all' || !Array.isArray(item.platforms) || item.platforms.length === 0 || item.platforms.includes(platform);

const rank = (items, { niche, platform }) =>
    [...items].sort((a, b) => {
        const nicheA = a.niches?.includes(niche) ? 1 : 0;
        const nicheB = b.niches?.includes(niche) ? 1 : 0;
        if (nicheA !== nicheB) return nicheB - nicheA;
        const platA = fitsPlatform(a, platform) ? 1 : 0;
        const platB = fitsPlatform(b, platform) ? 1 : 0;
        if (platA !== platB) return platB - platA;
        return (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER);
    });

/**
 * Picks hooks for quiz results (plan §6.3). `hooks` must already be limited to
 * approved public hooks. Returns { items, strongMatches, hooksHidden }.
 *   1. featuredFree hooks tagged with the problem, ranked by niche then platform
 *   2. hooks in the problem's mapped categories, in map order
 *   3. any remaining public hooks
 * 3 results, or 5 when at least 5 come from tiers 1-2. Fewer than 3 public hooks
 * in total hides the block (a launch blocker for the owner, not an error).
 */
export function matchHooks(hooks, { problem, niche, platform, preferSlug } = {}) {
    const pool = Array.isArray(hooks) ? hooks.filter((h) => h && h.type === 'hook') : [];
    if (pool.length < MIN_RESULTS) return { items: [], strongMatches: 0, hooksHidden: true };

    const picked = [];
    const seen = new Set();
    const add = (item) => {
        if (!item || seen.has(item.slug)) return;
        seen.add(item.slug);
        picked.push(item);
    };

    if (preferSlug) add(pool.find((h) => h.slug === preferSlug));

    const tier1 = rank(pool.filter((h) => h.featuredFree && h.problemTags?.includes(problem)), { niche, platform });
    tier1.forEach(add);

    const categories = PROBLEM_CATEGORY_MAP[problem] || [];
    for (const category of categories) {
        rank(pool.filter((h) => h.category === category), { niche, platform }).forEach(add);
    }
    const strongMatches = picked.length;

    const allowMidVideo = problem === 'mid_video_dropoff';
    rank(pool.filter((h) => allowMidVideo || h.category !== MID_VIDEO_TEXT_CATEGORY), { niche, platform }).forEach(add);

    const size = strongMatches >= MAX_RESULTS ? MAX_RESULTS : MIN_RESULTS;
    return { items: picked.slice(0, size), strongMatches, hooksHidden: false };
}
