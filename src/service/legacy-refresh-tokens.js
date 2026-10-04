import { hashRefreshToken, isHashedRefreshToken } from '../utils/refresh-token-hash.js';

export const REFRESH_TOKEN_COLLECTIONS = Object.freeze(['users', 'admins']);

/**
 * Count (and with apply=true, convert) plaintext refresh tokens to hashes.
 * Returns counts only; token values never leave this function.
 * @param {import('mongodb').Db} db
 */
export async function convertLegacyRefreshTokens(db, { apply = false, pepper = process.env.REFRESH_TOKEN_PEPPER } = {}) {
    const results = [];
    for (const name of REFRESH_TOKEN_COLLECTIONS) {
        const col = db.collection(name);
        const filter = { refreshToken: { $type: 'string', $ne: '' } };
        const withToken = await col.countDocuments(filter);
        let plaintext = 0;
        let converted = 0;
        for await (const doc of col.find(filter, { projection: { refreshToken: 1 } })) {
            if (isHashedRefreshToken(doc.refreshToken)) continue;
            plaintext++;
            if (apply) {
                const res = await col.updateOne(
                    { _id: doc._id, refreshToken: doc.refreshToken },
                    { $set: { refreshToken: hashRefreshToken(doc.refreshToken, pepper) } }
                );
                converted += res.modifiedCount;
            }
        }
        results.push({ collection: name, withToken, plaintext, converted });
    }
    return results;
}
