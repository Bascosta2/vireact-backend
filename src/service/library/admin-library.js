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
import { classifyKbProvenance, isThirdPartyProvenance, findKbDocById } from './kb-readonly.js';
import { slugify } from './extract-hooks-pdf.js';

const pickEnum = (values, allowed) => [...new Set(values.filter((v) => allowed.includes(v)))];

/**
 * Validates an admin edit against the current item. Returns { set, errors }.
 * Public on a third-party-sourced item needs `confirmThirdParty: true`.
 */
export function buildAdminPatch(current, body = {}) {
    const errors = [];
    const set = {};
    for (const key of ['title', 'displayText', 'body', 'category']) {
        if (body[key] === undefined) continue;
        if (typeof body[key] !== 'string') errors.push(`${key} must be a string`);
        else set[key] = key === 'body' ? body[key] : body[key].trim();
    }
    if (set.displayText !== undefined && !set.displayText) errors.push('displayText cannot be empty');
    for (const [key, allowed] of [['niches', NICHES], ['problemTags', PROBLEMS], ['platforms', LIBRARY_PLATFORMS]]) {
        if (body[key] === undefined) continue;
        if (!Array.isArray(body[key])) errors.push(`${key} must be an array`);
        else set[key] = pickEnum(body[key], allowed);
    }
    if (body.visibility !== undefined) {
        if (!Object.values(LIBRARY_VISIBILITY).includes(body.visibility)) errors.push('visibility is invalid');
        else set.visibility = body.visibility;
    }
    if (body.reviewStatus !== undefined) {
        if (!Object.values(LIBRARY_REVIEW_STATUS).includes(body.reviewStatus)) errors.push('reviewStatus is invalid');
        else set.reviewStatus = body.reviewStatus;
    }
    if (body.featuredFree !== undefined) {
        if (typeof body.featuredFree !== 'boolean') errors.push('featuredFree must be a boolean');
        else set.featuredFree = body.featuredFree;
    }
    if (body.order !== undefined) {
        if (body.order !== null && !Number.isFinite(body.order)) errors.push('order must be a number');
        else set.order = body.order;
    }
    if (set.visibility === LIBRARY_VISIBILITY.PUBLIC && current?.thirdPartySource && body.confirmThirdParty !== true) {
        errors.push('This item comes from third-party KB content. Only mark public content you own (confirmThirdParty required).');
    }
    return { set, errors };
}

export async function adminListItems({ status, type, visibility } = {}) {
    const filter = {};
    if (Object.values(LIBRARY_REVIEW_STATUS).includes(status)) filter.reviewStatus = status;
    if (LIBRARY_ITEM_TYPES.includes(type)) filter.type = type;
    if (Object.values(LIBRARY_VISIBILITY).includes(visibility)) filter.visibility = visibility;
    return LibraryItem.find(filter).sort({ type: 1, order: 1, _id: 1 }).limit(1000).lean();
}

/**
 * Creates a private draft from one KB doc. Reads the KB doc by id only; the
 * excerpt is a starting point the admin edits before approving.
 */
export async function createDraftFromKb(db, kbId, { type = 'hook', title, displayText } = {}) {
    if (!mongoose.Types.ObjectId.isValid(kbId)) return { error: 'Invalid KB id', status: 400 };
    if (!LIBRARY_ITEM_TYPES.includes(type)) return { error: 'type is invalid', status: 400 };
    const objectId = new mongoose.Types.ObjectId(kbId);
    const doc = await findKbDocById(db, objectId);
    if (!doc) return { error: 'KB document not found', status: 404 };

    const provenance = classifyKbProvenance(doc);
    const text = (typeof displayText === 'string' && displayText.trim()) || String(doc.content || '').trim().slice(0, 600);
    if (!text) return { error: 'KB document has no content', status: 422 };

    const base = slugify(title || text.slice(0, 60)) || 'kb-item';
    let slug = `${base}-${String(kbId).slice(-6)}`;
    for (let n = 2; await LibraryItem.exists({ slug }); n += 1) slug = `${base}-${String(kbId).slice(-6)}-${n}`;

    const item = await LibraryItem.create({
        slug,
        type,
        title: typeof title === 'string' ? title.trim() : undefined,
        displayText: text,
        category: doc.metadata?.topic || undefined,
        sourceKbIds: [objectId],
        sourceLabel: doc.metadata?.source || undefined,
        visibility: LIBRARY_VISIBILITY.PRIVATE,
        reviewStatus: LIBRARY_REVIEW_STATUS.DRAFT,
        createdBy: 'admin',
        thirdPartySource: isThirdPartyProvenance(provenance),
    });
    return { item: item.toObject(), provenance };
}
