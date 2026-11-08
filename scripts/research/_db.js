/** Shared DB connection for the research scripts: the same production guard as the app. */
import '../../src/config/load-env.js';
import mongoose from 'mongoose';
import { assertSafeDatabase } from '../../src/config/env-guards.js';
import { DB_URL, DB_NAME } from '../../src/config/index.js';

export const connectDb = async () => {
    assertSafeDatabase();
    if (!DB_URL) throw new Error('DB_URL is not set (.env.local)');
    await mongoose.connect(DB_URL, { dbName: DB_NAME, autoIndex: false, autoCreate: false });
    console.log(`Database: ${mongoose.connection.db.databaseName}`);
};

export const disconnectDb = () => mongoose.disconnect();

export const args = process.argv.slice(2);
export const flag = (name) => args.includes(name);
export const value = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
