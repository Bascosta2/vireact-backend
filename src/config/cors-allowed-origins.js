import { NODE_ENV } from './index.js';

/**
 * Single source of truth for browser CORS origins (must match errorHandler).
 * Production: apex + www only. Dev: local frontends.
 */
export function getAllowedCorsOrigins() {
    return NODE_ENV === 'production'
        ? ['https://vireact.io', 'https://www.vireact.io']
        : [
              'http://localhost:3000',
              'http://localhost:5173',
              'http://localhost:5174',
              'http://192.168.1.112:5173',
          ];
}
