/**
 * Startup safety guards for non-production runs.
 *
 * Production and dev databases share one Atlas host, so the database guard
 * compares database NAMES, never hosts. It checks both DB_NAME (Mongoose
 * dbName) and the database in the DB_URL path (used by connect-mongo and the
 * diagnostic scripts), because either one can reach production on its own.
 */

export const DEFAULT_PROD_DB_NAME_PATTERN = '^prod$';

const isTrue = (v) => String(v ?? '').trim().toLowerCase() === 'true';

/** Database name in a mongodb:// or mongodb+srv:// URI path, or null. */
export function databaseNameFromUri(uri) {
    if (!uri || typeof uri !== 'string') return null;
    const match = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/);
    const name = match ? decodeURIComponent(match[1]).trim() : '';
    return name || null;
}

/** Throws when a non-production process would connect to a production database name. */
export function assertSafeDatabase(env = process.env) {
    if (env.NODE_ENV === 'production') return;
    if (isTrue(env.ALLOW_PROD_DB_IN_DEV)) return;

    let pattern;
    try {
        pattern = new RegExp(env.PROD_DB_NAME_PATTERN || DEFAULT_PROD_DB_NAME_PATTERN);
    } catch {
        throw new Error('PROD_DB_NAME_PATTERN is not a valid regular expression.');
    }

    const candidates = [
        ['DB_NAME', env.DB_NAME?.trim() || null],
        ['DB_URL database', databaseNameFromUri(env.DB_URL)],
        ['MONGODB_URI database', databaseNameFromUri(env.MONGODB_URI)],
    ].filter(([, name]) => name);

    const blocked = candidates.filter(([, name]) => pattern.test(name));
    if (blocked.length > 0) {
        const where = blocked.map(([source, name]) => `${source}="${name}"`).join(', ');
        throw new Error(
            `Refusing to start: ${where} matches PROD_DB_NAME_PATTERN while NODE_ENV=${env.NODE_ENV || '(unset)'}. ` +
            'Point .env.local at a dev database (e.g. vireact_dev) or set ALLOW_PROD_DB_IN_DEV=true deliberately.'
        );
    }
}

/** Throws when a non-production process holds a Stripe key that is not test-mode. */
export function assertSafeStripeKey(env = process.env) {
    if (env.NODE_ENV === 'production') return;
    const key = (env.STRIPE_SECRET_KEY || '').trim();
    if (!key) return;
    if (!key.startsWith('sk_test_') && !key.startsWith('rk_test_')) {
        throw new Error(
            `Refusing to start: STRIPE_SECRET_KEY is not a test-mode key (prefix "${key.slice(0, 7)}") while NODE_ENV=${env.NODE_ENV || '(unset)'}. ` +
            'Use an sk_test_ key in .env.local.'
        );
    }
}

/** Loggable host fragment: first 4 characters of the first label only, e.g. "clus***". */
export function redactHost(host) {
    if (!host || typeof host !== 'string') return 'unknown';
    const label = host.split('.')[0] || '';
    return `${label.slice(0, 4)}***`;
}

export function runStartupGuards(env = process.env) {
    assertSafeDatabase(env);
    assertSafeStripeKey(env);
}
