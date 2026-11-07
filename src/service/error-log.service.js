/**
 * Safety net: every error users could hit is recorded, grouped and (for new kinds) alerted.
 *
 * Sources: server 5xx (error handler), browser errors (POST /api/v1/client-errors), failed uploads and
 * analyses (alertFailure), and process-level crashes. Errors are grouped by a fingerprint (source +
 * route + normalized message) per day, so a repeating error is one row with a count.
 *
 * Works with no external service. Sentry (SENTRY_DSN) and email alerts (OPS_ALERT_EMAIL) are extras.
 * Never throws: monitoring must not break the request that failed.
 */
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { ErrorEvent } from '../model/error-event.model.js';

const MAX_MESSAGE = 500;
const MAX_STACK = 4000;
const MAX_IDS = 20;

/**
 * Strip the parts of a message that change between occurrences (ids, numbers, quoted values, URLs),
 * so the same bug groups together.
 */
export const normalizeMessage = (message) =>
    String(message ?? '')
        .replace(/https?:\/\/\S+/g, '<url>')
        .replace(/\b[0-9a-f]{24}\b/gi, '<id>')
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
        .replace(/(["'`])(?:(?!\1).){1,120}\1/g, '<str>')
        .replace(/\d+(?:\.\d+)?/g, '<n>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);

/** Route with ids collapsed: "/api/v1/videos/6731.../feedback" -> "/api/v1/videos/:id/feedback". */
export const normalizeRoute = (route) =>
    String(route ?? '')
        .split('?')[0]
        .replace(/\/[0-9a-f]{24}(?=\/|$)/gi, '/:id')
        .replace(/\/\d+(?=\/|$)/g, '/:n')
        .slice(0, 200);

export const fingerprintFor = ({ source, route, message }) =>
    crypto.createHash('sha1').update(`${source}|${normalizeRoute(route)}|${normalizeMessage(message)}`).digest('hex').slice(0, 20);

const today = (now) => new Date(now).toISOString().slice(0, 10);
const clip = (value, max) => String(value ?? '').slice(0, max);

let alertNewError = null;
/** Called with the event when a fingerprint is seen for the first time (set by ops-monitoring). */
export const onNewError = (fn) => {
    alertNewError = fn;
};

/**
 * Record one error occurrence.
 * @param {{ source: string, message: string, stack?: string, route?: string, status?: number,
 *           url?: string, userAgent?: string, release?: string, userId?: unknown, videoId?: unknown }} event
 * @returns {Promise<{ fingerprint: string, isNew: boolean } | null>}
 */
export const recordError = async (event, { model = ErrorEvent, now = Date.now(), retried = false } = {}) => {
    try {
        if (!event?.message) return null;
        // Without a database connection (tests, boot failures) only the log line remains.
        if (model === ErrorEvent && mongoose.connection.readyState !== 1) return null;
        const fingerprint = fingerprintFor(event);
        const at = new Date(now);
        const push = {};
        if (event.userId) push.userIds = { $each: [String(event.userId)], $slice: -MAX_IDS };
        if (event.videoId) push.videoIds = { $each: [String(event.videoId)], $slice: -MAX_IDS };
        const update = {
            $inc: { count: 1 },
            $set: { lastSeenAt: at },
            $setOnInsert: {
                source: event.source,
                message: clip(event.message, MAX_MESSAGE),
                stack: clip(event.stack, MAX_STACK),
                route: normalizeRoute(event.route),
                status: Number.isFinite(event.status) ? event.status : null,
                url: clip(event.url, 300),
                userAgent: clip(event.userAgent, 300),
                release: clip(event.release, 60),
                firstSeenAt: at,
            },
        };
        if (Object.keys(push).length) update.$push = push;
        const before = await model.findOneAndUpdate({ fingerprint, day: today(now) }, update, { upsert: true, new: false, lean: true });
        // New today: was it also seen on an earlier day? Only a never-seen fingerprint counts as new.
        let isNew = false;
        if (!before) {
            isNew = !(await model.exists({ fingerprint, day: { $ne: today(now) } }));
            if (isNew && alertNewError) {
                Promise.resolve(alertNewError({ ...event, fingerprint })).catch(() => {});
            }
        }
        return { fingerprint, isNew };
    } catch (error) {
        // Two first occurrences at the same moment: one upsert loses the unique-index race. Retry once.
        if (error?.code === 11000 && !retried) return recordError(event, { model, now, retried: true });
        console.warn(`[ErrorLog] Could not record error: ${error.message}`);
        return null;
    }
};

/**
 * Grouped errors since `since`, most frequent first.
 * @returns {Promise<{ total: number, bySource: Record<string, number>, top: object[] }>}
 */
export const getErrorReport = async ({ since = new Date(Date.now() - 24 * 60 * 60 * 1000), source, limit = 50 } = {}) => {
    const match = { lastSeenAt: { $gte: since } };
    if (source) match.source = source;
    const [top, bySource] = await Promise.all([
        ErrorEvent.aggregate([
            { $match: match },
            {
                $group: {
                    _id: '$fingerprint',
                    count: { $sum: '$count' },
                    source: { $first: '$source' },
                    message: { $first: '$message' },
                    route: { $first: '$route' },
                    status: { $first: '$status' },
                    url: { $first: '$url' },
                    stack: { $first: '$stack' },
                    users: { $addToSet: '$userIds' },
                    firstSeenAt: { $min: '$firstSeenAt' },
                    lastSeenAt: { $max: '$lastSeenAt' },
                },
            },
            { $sort: { count: -1, lastSeenAt: -1 } },
            { $limit: Math.min(200, Math.max(1, limit)) },
        ]),
        ErrorEvent.aggregate([{ $match: match }, { $group: { _id: '$source', count: { $sum: '$count' } } }]),
    ]);
    const counts = Object.fromEntries(bySource.map((row) => [row._id, row.count]));
    return {
        since: since.toISOString(),
        total: Object.values(counts).reduce((a, b) => a + b, 0),
        bySource: counts,
        top: top.map(({ _id, users, stack, ...row }) => ({
            fingerprint: _id,
            ...row,
            affectedUsers: new Set(users.flat()).size,
            stack: stack ? stack.split('\n').slice(0, 6).join('\n') : '',
        })),
    };
};
