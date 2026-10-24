import mongoose from 'mongoose';
import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { LibraryItem } from '../model/library-item.model.js';
import { adminListItems, buildAdminPatch, createDraftFromKb } from '../service/library/admin-library.js';
import { searchKb } from '../service/library/kb-readonly.js';

export const listLibraryItemsAdmin = async (req, res, next) => {
    try {
        const items = await adminListItems(req.query);
        res.status(200).json(ApiResponse.success(200, 'Library items', { items }));
    } catch (error) {
        next(error);
    }
};

export const patchLibraryItemAdmin = async (req, res, next) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) throw new ApiError(400, 'Invalid item id');
        const current = await LibraryItem.findById(req.params.id).lean();
        if (!current) throw new ApiError(404, 'Item not found');
        const { set, errors } = buildAdminPatch(current, req.body || {});
        if (errors.length) throw new ApiError(400, errors.join('; '));
        const item = await LibraryItem.findByIdAndUpdate(req.params.id, { $set: set }, { new: true, runValidators: true }).lean();
        res.status(200).json(ApiResponse.success(200, 'Library item updated', { item }));
    } catch (error) {
        next(error);
    }
};

export const createLibraryItemFromKb = async (req, res, next) => {
    try {
        const result = await createDraftFromKb(mongoose.connection.db, req.params.kbId, req.body || {});
        if (result.error) throw new ApiError(result.status, result.error);
        res.status(201).json(ApiResponse.success(201, 'Draft created', result));
    } catch (error) {
        next(error);
    }
};

export const searchKnowledgeBaseAdmin = async (req, res, next) => {
    try {
        const results = await searchKb(mongoose.connection.db, req.query.q, { limit: 25 });
        res.status(200).json(ApiResponse.success(200, 'KB search', { results }));
    } catch (error) {
        next(error);
    }
};
