import { ApiResponse } from '../utils/ApiResponse.js';
import { ApiError } from '../utils/ApiError.js';
import { resolveAccess } from '../service/access.service.js';
import { listItems, getItemBySlug, libraryStats, recommendedFor } from '../service/library.service.js';
import { NICHES, PROBLEMS, LIBRARY_PLATFORMS } from '../constants/library.js';

export const getLibraryItems = async (req, res, next) => {
    try {
        const { entitled } = await resolveAccess(req.user);
        const data = await listItems(req.query, { entitled });
        res.status(200).json(ApiResponse.success(200, 'Library items', { ...data, entitled }));
    } catch (error) {
        next(error);
    }
};

export const getLibraryItem = async (req, res, next) => {
    try {
        const { entitled } = await resolveAccess(req.user);
        const item = await getItemBySlug(req.params.slug, { entitled });
        if (!item) throw new ApiError(404, 'Item not found');
        res.status(200).json(ApiResponse.success(200, 'Library item', { item }));
    } catch (error) {
        next(error);
    }
};

export const getLibraryStats = async (req, res, next) => {
    try {
        res.status(200).json(ApiResponse.success(200, 'Library stats', await libraryStats()));
    } catch (error) {
        next(error);
    }
};

export const getRecommended = async (req, res, next) => {
    try {
        const { entitled } = await resolveAccess(req.user);
        const pick = (value, allowed) => (allowed.includes(value) ? value : undefined);
        const answers = {
            problem: pick(req.query.problem, PROBLEMS),
            niche: pick(req.query.niche, NICHES),
            platform: pick(req.query.platform, [...LIBRARY_PLATFORMS, 'all']),
        };
        const result = await recommendedFor(answers, { entitled });
        res.status(200).json(ApiResponse.success(200, 'Recommended hooks', result));
    } catch (error) {
        next(error);
    }
};
