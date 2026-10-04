/**
 * One-time conversion of legacy plaintext refresh tokens to hashes.
 *
 *   node scripts/hash-legacy-refresh-tokens.js            # dry run (default): counts only
 *   node scripts/hash-legacy-refresh-tokens.js --apply    # rewrite plaintext tokens as hashes
 *
 * Sessions keep working: refreshTokenMatches() verifies hashed tokens. Set
 * REFRESH_TOKEN_PEPPER first so tokens are written as peppered h1: hashes.
 * Prints counts only, never token values. The database-name guard applies
 * outside NODE_ENV=production.
 */
import '../src/config/load-env.js';
import mongoose from 'mongoose';
import { assertSafeDatabase } from '../src/config/env-guards.js';
import { DB_URL, DB_NAME } from '../src/config/index.js';
import { convertLegacyRefreshTokens } from '../src/service/legacy-refresh-tokens.js';

const apply = process.argv.includes('--apply');

assertSafeDatabase();
await mongoose.connect(DB_URL, { dbName: DB_NAME, autoIndex: false, autoCreate: false });
try {
    const db = mongoose.connection.db;
    console.log(`Database: ${db.databaseName}  mode: ${apply ? 'APPLY' : 'dry run'}  pepper: ${process.env.REFRESH_TOKEN_PEPPER ? 'set (h1)' : 'unset (h0)'}`);
    for (const r of await convertLegacyRefreshTokens(db, { apply })) {
        console.log(`${r.collection}: ${r.withToken} with a refresh token, ${r.plaintext} plaintext${apply ? `, ${r.converted} converted` : ''}`);
    }
    if (!apply) console.log('Dry run only. Re-run with --apply to convert.');
} finally {
    await mongoose.disconnect();
}
