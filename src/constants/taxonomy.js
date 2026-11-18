/**
 * Learning-engine taxonomy, version TAXONOMY_VERSION. Two levels of niche (niche -> sub-niche) plus a
 * format archetype and a hook pattern, all closed lists so classifier output can be validated.
 *
 * The first ten niches are the same keys as NICHES in constants/library.js (quiz, library, creator
 * profile), so existing data maps 1:1. Changing a list here means bumping TAXONOMY_VERSION; videos
 * labelled under an older version are re-labelled by the daily job.
 */

export const TAXONOMY_VERSION = 1;

export const NICHE_TREE = Object.freeze({
    education: ['study_tips', 'science_explainers', 'history', 'language_learning', 'life_skills', 'career_advice'],
    business_finance: ['personal_finance', 'investing_crypto', 'entrepreneurship', 'side_hustles', 'marketing_sales', 'real_estate'],
    entertainment_comedy: ['skits', 'pranks', 'reactions', 'pop_culture', 'memes_edits', 'storytime'],
    lifestyle_vlog: ['day_in_life', 'home_decor', 'travel', 'relationships_dating', 'parenting_family', 'routines_productivity'],
    gaming: ['gameplay_highlights', 'game_reviews_news', 'stream_clips', 'mobile_gaming', 'esports'],
    fitness_health: ['home_workouts', 'gym_training', 'transformations', 'nutrition_diet', 'running_endurance', 'wellness_mental_health'],
    beauty_fashion: ['makeup', 'skincare', 'hair', 'outfits_styling', 'nails', 'grwm'],
    food: ['recipes', 'food_reviews', 'restaurant_finds', 'quick_meals', 'baking', 'mukbang_asmr'],
    tech: ['gadget_reviews', 'ai_tools', 'software_tips', 'coding', 'tech_news', 'desk_setups'],
    other: ['other'],
    sports: ['highlights', 'skills_training', 'analysis_commentary', 'fan_culture'],
    music_dance: ['dance_trends', 'covers', 'original_music', 'music_production'],
    art_creative: ['drawing_painting', 'diy_crafts', 'photo_video', 'design'],
    pets_animals: ['dogs', 'cats', 'exotic_pets', 'wildlife'],
    automotive: ['car_reviews', 'car_mods', 'driving', 'motorcycles'],
});

export const TAXONOMY_NICHES = Object.freeze(Object.keys(NICHE_TREE));
export const TAXONOMY_SUB_NICHES = Object.freeze([...new Set(Object.values(NICHE_TREE).flat())]);

export const FORMATS = Object.freeze([
    'talking_head', 'tutorial', 'listicle', 'storytime', 'before_after', 'pov_skit', 'day_in_life', 'reaction_stitch',
    'green_screen', 'product_demo', 'challenge_trend', 'slideshow', 'interview_street', 'asmr_satisfying', 'meme_edit',
    'montage', 'voiceover_broll', 'vlog', 'transformation', 'other',
]);

export const HOOK_PATTERNS = Object.freeze([
    'question', 'bold_claim', 'result_first', 'pov', 'pattern_interrupt', 'curiosity_gap', 'direct_callout', 'controversy',
    'story_open', 'list_countdown', 'mistake_warning', 'visual_only', 'none',
]);

/** The sub-niche when it belongs to that niche, else null. */
export const subNicheOf = (niche, subNiche) => (NICHE_TREE[niche]?.includes(subNiche) ? subNiche : null);
export const isNiche = (value) => Object.hasOwn(NICHE_TREE, String(value ?? ''));

/** Content-strategy tags (CONTENT_FORMATS / HOOK_TYPES) mapped onto this taxonomy. */
const FORMAT_FROM_STRATEGY = { skit: 'pov_skit', reaction: 'reaction_stitch' };
export const formatFromStrategy = (format) => {
    const f = FORMAT_FROM_STRATEGY[format] ?? format;
    return FORMATS.includes(f) ? f : null;
};
const HOOK_FROM_STRATEGY = { visual_only: 'visual_only' };
export const hookFromStrategy = (hookType) => {
    const h = HOOK_FROM_STRATEGY[hookType] ?? hookType;
    return HOOK_PATTERNS.includes(h) ? h : null;
};
