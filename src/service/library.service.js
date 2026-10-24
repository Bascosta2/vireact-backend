import { LibraryItem } from '../model/library-item.model.js';
import { LIBRARY_VISIBILITY, LIBRARY_REVIEW_STATUS, LIBRARY_ITEM_TYPES, NICHES, PROBLEMS } from '../constants/library.js';
import { matchHooks } from './library/matcher.js';

export const PAGE_SIZE = 24;

/** Visibility levels a caller may read. Only approved items are ever served. */
export const visibleLevels = (entitled) =>
    entitled ? [LIBRARY_VISIBILITY.PUBLIC, LIBRARY_VISIBILITY.MEMBERS] : [LIBRARY_VISIBILITY.PUBLIC];

export const servedFilter = (entitled) => ({
    reviewStatus: LIBRARY_REVIEW_STATUS.APPROVED,
    visibility: { $in: visibleLevels(entitled) },
});

/** Public shape: no KB ids, review state or provenance flags. */
export const serializeItem = (item) => ({
    slug: item.slug,
    type: item.type,
    title: item.title || null,
    displayText: item.displayText,
    body: item.body || null,
    category: item.category || null,
    niches: item.niches || [],
    problemTags: item.problemTags || [],
    platforms: item.platforms || [],
    visibility: item.visibility,
    featuredFree: Boolean(item.featuredFree),
});

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function listItems({ type, category, niche, problem, q, page } = {}, { entitled = false } = {}) {
    const filter = servedFilter(entitled);
    if (LIBRARY_ITEM_TYPES.includes(type)) filter.type = type;
    if (typeof category === 'string' && category.trim()) filter.category = category.trim().slice(0, 120);
    if (NICHES.includes(niche)) filter.niches = niche;
    if (PROBLEMS.includes(problem)) filter.problemTags = problem;
    if (typeof q === 'string' && q.trim().length >= 2) {
        const re = new RegExp(escapeRegex(q.trim().slice(0, 80)), 'i');
        filter.$or = [{ displayText: re }, { title: re }, { body: re }];
    }
    const pageNum = Math.max(1, Math.min(Number.parseInt(page, 10) || 1, 1000));
    const [items, total] = await Promise.all([
        LibraryItem.find(filter).sort({ order: 1, _id: 1 }).skip((pageNum - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean(),
        LibraryItem.countDocuments(filter),
    ]);
    return { items: items.map(serializeItem), page: pageNum, pageSize: PAGE_SIZE, total };
}

/**
 * Members items requested without entitlement return a locked teaser; drafts,
 * rejected and private items are indistinguishable from missing.
 */
export async function getItemBySlug(slug, { entitled = false } = {}) {
    if (typeof slug !== 'string' || !slug.trim()) return null;
    const item = await LibraryItem.findOne({ slug: slug.trim(), ...servedFilter(true) }).lean();
    if (!item) return null;
    if (item.visibility === LIBRARY_VISIBILITY.MEMBERS && !entitled) {
        return { locked: true, slug: item.slug, title: item.title || null, category: item.category || null };
    }
    return serializeItem(item);
}

export async function libraryStats() {
    const rows = await LibraryItem.aggregate([
        { $match: { reviewStatus: LIBRARY_REVIEW_STATUS.APPROVED, visibility: { $in: [LIBRARY_VISIBILITY.PUBLIC, LIBRARY_VISIBILITY.MEMBERS] } } },
        { $group: { _id: { type: '$type', visibility: '$visibility' }, n: { $sum: 1 } } },
    ]);
    const stats = { hooks: { public: 0, members: 0 }, structures: { public: 0, members: 0 } };
    for (const row of rows) {
        const bucket = row._id.type === 'hook' ? stats.hooks : row._id.type === 'structure' ? stats.structures : null;
        if (bucket) bucket[row._id.visibility] += row.n;
    }
    stats.hooks.total = stats.hooks.public + stats.hooks.members;
    stats.structures.total = stats.structures.public + stats.structures.members;
    return stats;
}

/** Approved public hooks, the only pool quiz results may draw from. */
export const publicHooks = () =>
    LibraryItem.find({ ...servedFilter(false), type: 'hook' }).sort({ order: 1, _id: 1 }).lean();

export async function recommendedFor(answers = {}, { entitled = false, preferSlug } = {}) {
    const pool = entitled
        ? await LibraryItem.find({ ...servedFilter(true), type: 'hook' }).sort({ order: 1, _id: 1 }).lean()
        : await publicHooks();
    const result = matchHooks(pool, { ...answers, preferSlug });
    return { ...result, items: result.items.map(serializeItem) };
}
