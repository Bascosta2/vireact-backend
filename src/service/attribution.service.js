import { User } from '../model/user.model.js';
import { sanitizeAttribution } from '../utils/attribution.js';

/**
 * Stores first-touch attribution only if the user has none yet. The filter
 * makes the write atomic, so concurrent calls cannot overwrite each other.
 * Returns true when a value was written.
 */
export const storeFirstTouchAttribution = async (userId, rawAttribution) => {
    const attribution = sanitizeAttribution(rawAttribution);
    if (!userId || !attribution) return false;

    const result = await User.updateOne(
        { _id: userId, attribution: { $exists: false } },
        { $set: { attribution } }
    );
    return result.modifiedCount === 1;
};
