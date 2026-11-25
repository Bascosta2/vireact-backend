import jwt from 'jsonwebtoken';
import '../config/load-env.js';

/**
 * Signing and verifying the app's access and refresh tokens.
 * - One algorithm only (HS256, what jsonwebtoken signs with by default), so a token can never pick its own
 *   algorithm (no "none", no RS/HS confusion).
 * - Every token carries `typ` ('access' | 'refresh'), so a 30-day refresh token can never be used as an
 *   access token, and the other way round.
 *
 * Transition: tokens issued before `typ` existed are still accepted. Their type is told apart by the secret
 * that verifies them (access and refresh secrets differ in production) and, in case the two secrets are the
 * same (REFRESH_TOKEN_SECRET falls back to ACCESS_TOKEN_SECRET when unset), by their lifetime: access tokens
 * lived 30 minutes, refresh tokens 30 days. Old access tokens are gone 30 minutes after deploy and old
 * refresh tokens within 30 days; after that the legacy branch in verifyToken can be removed.
 */
// TODO(2026-12-26 at the earliest, 30 days after merge): drop legacyTypeOf and require `typ` on every token.

export const JWT_ALGORITHM = 'HS256';

export const TOKEN_TYPE = Object.freeze({ ACCESS: 'access', REFRESH: 'refresh' });

/** A token without `typ` that lives at most this long is a legacy access token; longer is a legacy refresh token. */
export const LEGACY_ACCESS_MAX_LIFETIME_SECONDS = 60 * 60;

/**
 * Secrets are read when used (same values and same fallback as ACCESS_TOKEN_SECRET / REFRESH_TOKEN_SECRET in
 * config/index.js), so tests can set them without a reload.
 */
const secretFor = (type) => (type === TOKEN_TYPE.REFRESH
    ? process.env.REFRESH_TOKEN_SECRET || process.env.ACCESS_TOKEN_SECRET
    : process.env.ACCESS_TOKEN_SECRET);

const legacyTypeOf = (decoded) => {
    if (typeof decoded?.exp !== 'number' || typeof decoded?.iat !== 'number') return null;
    return decoded.exp - decoded.iat <= LEGACY_ACCESS_MAX_LIFETIME_SECONDS ? TOKEN_TYPE.ACCESS : TOKEN_TYPE.REFRESH;
};

/** Sign an access or refresh token. `typ` is always set from `type`, never from the payload. */
export const signToken = (type, payload, expiresIn) => {
    if (type !== TOKEN_TYPE.ACCESS && type !== TOKEN_TYPE.REFRESH) {
        throw new Error(`Unknown token type: ${type}`);
    }
    return jwt.sign({ ...payload, typ: type }, secretFor(type), { algorithm: JWT_ALGORITHM, expiresIn });
};

/**
 * Verify a token of the expected type and return its payload. Throws jsonwebtoken's own errors
 * (JsonWebTokenError, TokenExpiredError), so existing 401 handling keeps working.
 * `options` are passed to jwt.verify (e.g. { ignoreExpiration: true }); the algorithm cannot be overridden.
 */
export const verifyToken = (token, type, options = {}) => {
    const decoded = jwt.verify(token, secretFor(type), { ...options, algorithms: [JWT_ALGORITHM] });
    const actualType = decoded?.typ === undefined ? legacyTypeOf(decoded) : decoded.typ;
    if (actualType !== type) {
        throw new jwt.JsonWebTokenError('invalid token type');
    }
    return decoded;
};

export const verifyAccessToken = (token, options) => verifyToken(token, TOKEN_TYPE.ACCESS, options);

export const verifyRefreshToken = (token, options) => verifyToken(token, TOKEN_TYPE.REFRESH, options);
