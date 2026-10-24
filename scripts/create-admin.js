/**
 * Creates an Admin account. Replaces the removed public admin signup.
 *
 *   node scripts/create-admin.js --email ops@example.com [--name "Ops"]           # dry run (default)
 *   node scripts/create-admin.js --email ops@example.com [--name "Ops"] --apply   # create the admin
 *
 * The password is prompted for (twice, input hidden) and never echoed or logged.
 * The database-name guard applies outside NODE_ENV=production.
 */
import '../src/config/load-env.js';
import readline from 'node:readline';
import mongoose from 'mongoose';
import { assertSafeDatabase } from '../src/config/env-guards.js';
import { DB_URL, DB_NAME } from '../src/config/index.js';
import { Admin } from '../src/model/admin.model.js';
import { signupAdminService } from '../src/service/auth.service.js';
import { argValue, validateAdminInput } from '../src/service/admin-account.js';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const email = (argValue(argv, '--email') || '').trim().toLowerCase();
const name = (argValue(argv, '--name') || email.split('@')[0] || '').trim();

const askHidden = (question) =>
    new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        rl._writeToOutput = (text) => {
            if (text.includes(question)) rl.output.write(question);
        };
        rl.question(question, (answer) => {
            rl.close();
            process.stdout.write('\n');
            resolve(answer);
        });
    });

assertSafeDatabase();

const password = await askHidden('Admin password: ');
const confirm = await askHidden('Confirm password: ');
const problems = validateAdminInput({ email, password, confirm });
if (problems.length > 0) {
    console.error(`Not created: ${problems.join('; ')}.`);
    process.exit(1);
}

await mongoose.connect(DB_URL, { dbName: DB_NAME, autoIndex: false, autoCreate: false });
try {
    const db = mongoose.connection.db;
    console.log(`Database: ${db.databaseName}  mode: ${apply ? 'APPLY' : 'dry run'}`);
    if (await Admin.exists({ email })) {
        console.error(`An admin with email ${email} already exists. Nothing changed.`);
        process.exitCode = 1;
    } else if (!apply) {
        console.log(`Dry run: would create admin "${name}" <${email}>. Re-run with --apply to create it.`);
    } else {
        const admin = await signupAdminService(name, email, password);
        console.log(`Created admin ${admin._id} <${email}>.`);
    }
} finally {
    await mongoose.disconnect();
}
