import fs from 'node:fs';
import dotenv from 'dotenv';

// dotenv never overrides an already-set variable, so files listed first win.
// .env.local is a dev-only overlay and must never apply when the host already runs as production.
const files = [];
if (process.env.NODE_ENV !== 'production' && fs.existsSync('.env.local')) {
  files.push('.env.local');
}
files.push('.env');

dotenv.config({ path: files, quiet: true });
