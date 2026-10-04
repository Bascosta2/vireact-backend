import '../../src/config/load-env.js';
import mongoose from 'mongoose';
import { assertSafeDatabase } from '../../src/config/env-guards.js';

/** Throwaway database on the dev cluster; dropped by disconnectTestDb(). Never prod, never knowledgebases. */
export const TEST_DB_NAME = 'vireact_test';

export async function connectTestDb() {
    assertSafeDatabase({ ...process.env, DB_NAME: TEST_DB_NAME });
    if (!process.env.DB_URL) throw new Error('DB_URL is not set (.env.local)');
    await mongoose.connect(process.env.DB_URL, { dbName: TEST_DB_NAME, autoIndex: false, autoCreate: false });
    if (mongoose.connection.db.databaseName !== TEST_DB_NAME) {
        throw new Error(`Connected to unexpected database ${mongoose.connection.db.databaseName}`);
    }
    return mongoose.connection.db;
}

export async function disconnectTestDb() {
    if (mongoose.connection.readyState === 1 && mongoose.connection.db.databaseName === TEST_DB_NAME) {
        await mongoose.connection.db.dropDatabase();
    }
    await mongoose.disconnect();
}

export const fakeRes = () => {
    const res = { statusCode: 200, cookies: {}, cleared: [], body: undefined };
    res.status = (code) => { res.statusCode = code; return res; };
    res.cookie = (name, value) => { res.cookies[name] = value; return res; };
    res.clearCookie = (name) => { res.cleared.push(name); return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
};
