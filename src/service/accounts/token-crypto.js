import crypto from 'node:crypto';

/**
 * Platform tokens at rest: AES-256-GCM with a 32-byte key from ACCOUNTS_TOKEN_KEY (base64 or hex).
 * Stored form: "v1:<iv b64>:<tag b64>:<ciphertext b64>". Without a valid key, connecting is unavailable.
 * Generate a key: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 */

const PREFIX = 'v1';

export const tokenKey = (env = process.env) => {
    const raw = String(env.ACCOUNTS_TOKEN_KEY ?? '').trim();
    if (!raw) return null;
    const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    return buf.length === 32 ? buf : null;
};

export const isTokenKeyConfigured = (env = process.env) => tokenKey(env) !== null;

export const encryptToken = (plain, key = tokenKey()) => {
    if (plain == null || plain === '') return null;
    if (!key) throw new Error('ACCOUNTS_TOKEN_KEY is not set (32 bytes, base64 or hex)');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return [PREFIX, iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
};

export const decryptToken = (stored, key = tokenKey()) => {
    if (!stored) return null;
    if (!key) throw new Error('ACCOUNTS_TOKEN_KEY is not set (32 bytes, base64 or hex)');
    const [prefix, iv, tag, body] = String(stored).split(':');
    if (prefix !== PREFIX || !iv || !tag || body == null) throw new Error('unreadable token');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
};
