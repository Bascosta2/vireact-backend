import mongoose from 'mongoose';
import { LibraryItem } from '../../model/library-item.model.js';
import {
    LIBRARY_ITEM_TYPES,
    LIBRARY_VISIBILITY,
    LIBRARY_REVIEW_STATUS,
    LIBRARY_PLATFORMS,
    NICHES,
    PROBLEMS,
} from '../../constants/library.js';
import { classifyKbProvenance, isThirdPartyProvenance } from './kb-readonly.js';

const pickEnum = (values, allowed) => (Array.isArray(values) ? [...new Set(values.filter((v) => allowed.includes(v)))] : undefined);

/**
 * Validates one reviewed draft. Returns { item, errors }.
 * Visibility/reviewStatus/featuredFree are only taken when the owner set them.
 */
export function normalizeReviewedItem(raw) {
    const errors = [];
    const slug = typeof raw?.slug === 'string' ? raw.slug.trim() : '';
    if (!/^[a-z0-9-]{3,120}$/.test(slug)) errors.push('slug must be 3-120 chars of a-z, 0-9, -');
    if (!LIBRARY_ITEM_TYPES.includes(raw?.type)) errors.push(`type must be one of ${LIBRARY_ITEM_TYPES.join(', ')}`);
    const displayText = typeof raw?.displayText === 'string' ? raw.displayText.trim() : '';
    if (!displayText) errors.push('displayText is required');
    const ids = Array.isArray(raw?.sourceKbIds) ? raw.sourceKbIds.map(String) : [];
    if (ids.length === 0 || !ids.every((id) => mongoose.Types.ObjectId.isValid(id))) {
        errors.push('sourceKbIds must be a non-empty list of KB ids');
    }
    if (raw?.visibility !== undefined && !Object.values(LIBRARY_VISIBILITY).includes(raw.visibility)) {
        errors.push('visibility is invalid');
    }
    if (raw?.reviewStatus !== undefined && !Object.values(LIBRARY_REVIEW_STATUS).includes(raw.reviewStatus)) {
        errors.push('reviewStatus is invalid');
    }

    const set = {
        type: raw?.type,
        displayText,
        title: typeof raw?.title === 'string' ? raw.title.trim() : undefined,
        body: typeof raw?.body === 'string' ? raw.body : undefined,
        category: typeof raw?.category === 'string' ? raw.category.trim() : undefined,
        niches: pickEnum(raw?.niches, NICHES),
        problemTags: pickEnum(raw?.problemTags, PROBLEMS),
        platforms: pickEnum(raw?.platforms, LIBRARY_PLATFORMS),
        sourceKbIds: ids,
        sourceLabel: typeof raw?.sourceLabel === 'string' ? raw.sourceLabel : undefined,
        order: Number.isFinite(raw?.order) ? raw.order : undefined,
        createdBy: raw?.createdBy === 'admin' ? 'admin' : 'extractor',
    };
    if (raw?.visibility !== undefined) set.visibility = raw.visibility;
    if (raw?.reviewStatus !== undefined) set.reviewStatus = raw.reviewStatus;
    if (typeof raw?.featuredFree === 'boolean') set.featuredFree = raw.featuredFree;
    for (const key of Object.keys(set)) if (set[key] === undefined) delete set[key];

    return { slug, set, confirmThirdParty: raw?.confirmThirdParty === true, errors };
}

/**
 * Plans (and with apply=true, performs) the upsert of reviewed items into
 * library_items. Reads `knowledgebases` only to check that source ids exist and
 * to classify provenance.
 */
export async function importReviewedItems(db, rawItems, { apply = false } = {}) {
    const report = { insert: [], update: [], invalid: [] };
    const kb = db.collection('knowledgebases');

    for (const raw of rawItems) {
        const { slug, set, confirmThirdParty, errors } = normalizeReviewedItem(raw);
        if (errors.length === 0) {
            const objectIds = set.sourceKbIds.map((id) => new mongoose.Types.ObjectId(id));
            const sources = await kb.find({ _id: { $in: objectIds } }, { projection: { embedding: 0, content: 0 } }).toArray();
            if (sources.length !== objectIds.length) errors.push('one or more sourceKbIds do not exist in knowledgebases');
            const thirdParty = sources.some((doc) => isThirdPartyProvenance(classifyKbProvenance(doc)));
            set.thirdPartySource = thirdParty;
            if (thirdParty && set.visibility === LIBRARY_VISIBILITY.PUBLIC && !confirmThirdParty) {
                errors.push('source looks third-party; public needs "confirmThirdParty": true');
            }
            set.sourceKbIds = objectIds;
        }
        if (errors.length) {
            report.invalid.push({ slug: slug || '(missing)', errors });
            continue;
        }

        const exists = await LibraryItem.exists({ slug });
        (exists ? report.update : report.insert).push(slug);
        if (!apply) continue;

        const setOnInsert = {};
        if (set.visibility === undefined) setOnInsert.visibility = LIBRARY_VISIBILITY.PRIVATE;
        if (set.reviewStatus === undefined) setOnInsert.reviewStatus = LIBRARY_REVIEW_STATUS.DRAFT;
        await LibraryItem.updateOne(
            { slug },
            { $set: set, $setOnInsert: { slug, ...setOnInsert } },
            { upsert: true, runValidators: true }
        );
    }
    return report;
}
