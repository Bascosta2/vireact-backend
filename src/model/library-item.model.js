import mongoose from 'mongoose';
import {
    LIBRARY_ITEM_TYPES,
    LIBRARY_VISIBILITY,
    LIBRARY_REVIEW_STATUS,
    LIBRARY_CREATED_BY,
    LIBRARY_PLATFORMS,
    NICHES,
    PROBLEMS,
} from '../constants/library.js';

/**
 * Display layer over the knowledge base (plan §5.1). Items reference KB docs by id
 * and are never written back to `knowledgebases`, so RAG retrieval is unaffected.
 * Only `reviewStatus: 'approved'` items are ever served; visibility is opt-in per item.
 */
const libraryItemSchema = new mongoose.Schema(
    {
        slug: { type: String, required: true, unique: true, index: true, trim: true },
        type: { type: String, enum: LIBRARY_ITEM_TYPES, required: true, index: true },
        title: { type: String, trim: true },
        displayText: { type: String, required: true },
        body: String,
        category: { type: String, index: true },
        niches: { type: [{ type: String, enum: NICHES }], default: [] },
        problemTags: { type: [{ type: String, enum: PROBLEMS }], default: [] },
        platforms: { type: [{ type: String, enum: LIBRARY_PLATFORMS }], default: () => [...LIBRARY_PLATFORMS] },
        sourceKbIds: {
            type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'KnowledgeBase' }],
            validate: { validator: (ids) => Array.isArray(ids) && ids.length > 0, message: 'sourceKbIds must reference at least one KB doc' },
        },
        sourceLabel: String,
        visibility: {
            type: String,
            enum: Object.values(LIBRARY_VISIBILITY),
            default: LIBRARY_VISIBILITY.PRIVATE,
            index: true,
        },
        featuredFree: { type: Boolean, default: false },
        reviewStatus: {
            type: String,
            enum: Object.values(LIBRARY_REVIEW_STATUS),
            default: LIBRARY_REVIEW_STATUS.DRAFT,
            index: true,
        },
        order: Number,
        createdBy: { type: String, enum: LIBRARY_CREATED_BY },
        /** Set when a KB doc's provenance heuristics flag it as third-party; `public` then needs an explicit override. */
        thirdPartySource: { type: Boolean, default: false },
    },
    { timestamps: true, collection: 'library_items' }
);

libraryItemSchema.index({ reviewStatus: 1, visibility: 1, type: 1, category: 1, order: 1 });

export const LibraryItem = mongoose.model('LibraryItem', libraryItemSchema);
