export const ATTRIBUTION_FIELDS = [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'referrer',
    'landing_path',
];

const MAX_FIELD_LENGTH = 200;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

const cleanString = (value) => {
    if (typeof value !== 'string') return undefined;
    const cleaned = value.replace(CONTROL_CHARS, '').trim().slice(0, MAX_FIELD_LENGTH);
    return cleaned || undefined;
};

/**
 * Whitelists first-touch attribution sent by the client. Unknown keys and
 * non-string values are dropped. Returns null when nothing usable remains.
 */
export const sanitizeAttribution = (input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

    const result = {};
    for (const field of ATTRIBUTION_FIELDS) {
        const value = cleanString(input[field]);
        if (value !== undefined) result[field] = value;
    }
    if (result.landing_path && !result.landing_path.startsWith('/')) {
        delete result.landing_path;
    }
    if (Object.keys(result).length === 0) return null;

    const capturedAt = typeof input.captured_at === 'string' ? new Date(input.captured_at) : null;
    result.captured_at =
        capturedAt && !Number.isNaN(capturedAt.getTime()) && capturedAt.getTime() <= Date.now()
            ? capturedAt
            : new Date();
    return result;
};

/** Flat, PII-free event properties derived from a stored attribution. */
export const attributionEventProperties = (attribution) => {
    if (!attribution) return {};
    const props = {};
    for (const field of ATTRIBUTION_FIELDS) {
        if (attribution[field]) props[field] = attribution[field];
    }
    return props;
};
