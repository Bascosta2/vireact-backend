/**
 * Error tracking and operational alerts.
 *
 * - Sentry: active only when SENTRY_DSN is set (inert otherwise, no network calls).
 * - Email alerts: when OPS_ALERT_EMAIL is set, every failed analysis/upload emails the owner through
 *   Resend (already configured), throttled so an outage cannot flood the inbox.
 * - Daily summary: uploads, completions, failures and the most common errors for the last 24 hours,
 *   logged every day and emailed when OPS_ALERT_EMAIL is set. Also served at GET /api/v1/admin/analysis-stats.
 * - Error log (error-log.service.js): every captured error is stored, grouped by kind; the first time a
 *   new kind of error appears, the owner is emailed (OPS_ALERT_EMAIL). GET /api/v1/admin/errors.
 */
import resend from '../lib/resend.js';
import { RESEND_FROM_EMAIL } from '../config/index.js';
import { Video } from '../model/video.model.js';
import { ANALYSIS_STATUS, UPLOAD_STATUS } from '../constants.js';
import { recordError, onNewError, getErrorReport } from './error-log.service.js';

let sentry = null;

/** Start Sentry if SENTRY_DSN is configured. Safe to call more than once. */
export const initErrorTracking = async () => {
    const dsn = process.env.SENTRY_DSN?.trim();
    if (!dsn || sentry) return Boolean(sentry);
    try {
        const Sentry = await import('@sentry/node');
        Sentry.init({
            dsn,
            environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
            tracesSampleRate: 0,
            sendDefaultPii: false,
        });
        sentry = Sentry;
        console.log('[Monitoring] Sentry error tracking is on');
    } catch (error) {
        console.warn(`[Monitoring] Sentry could not start: ${error.message}`);
    }
    return Boolean(sentry);
};

const RECORD_SOURCES = new Set(['server', 'client', 'upload', 'analysis', 'recovery', 'process']);

/**
 * Report an error: stored in the error log (always) and sent to Sentry (when SENTRY_DSN is set).
 * `context.source` (or `context.stage`) says where it came from; default "server". Never throws.
 */
export const captureError = (error, context = {}) => {
    const err = error instanceof Error ? error : new Error(String(error));
    const source = RECORD_SOURCES.has(context.source) ? context.source : RECORD_SOURCES.has(context.stage) ? context.stage : 'server';
    void recordError({
        source,
        message: err.message || 'Unknown error',
        stack: err.stack,
        route: context.route,
        status: context.status,
        userId: context.userId,
        videoId: context.videoId,
    });
    if (!sentry) return;
    try {
        sentry.withScope((scope) => {
            for (const [key, value] of Object.entries(context)) {
                if (value !== undefined && value !== null) scope.setTag(key, String(value).slice(0, 200));
            }
            sentry.captureException(error instanceof Error ? error : new Error(String(error)));
        });
    } catch {
        /* never let monitoring break the request */
    }
};

const ALERT_LIMIT_PER_HOUR = 20;
const ALERT_SAME_VIDEO_COOLDOWN_MS = 30 * 60 * 1000;
const sentAlerts = []; // timestamps in the last hour
const lastAlertByVideo = new Map();

const escapeHtml = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Decide whether an alert may be sent now (throttle). Pure apart from the in-memory log. */
export const shouldSendAlert = (videoId, now = Date.now()) => {
    while (sentAlerts.length && now - sentAlerts[0] > 60 * 60 * 1000) sentAlerts.shift();
    if (sentAlerts.length >= ALERT_LIMIT_PER_HOUR) return false;
    const key = String(videoId || 'none');
    const last = lastAlertByVideo.get(key);
    if (last && now - last < ALERT_SAME_VIDEO_COOLDOWN_MS) return false;
    sentAlerts.push(now);
    lastAlertByVideo.set(key, now);
    return true;
};

const alertNewKindOfError = async (event) => {
    const to = process.env.OPS_ALERT_EMAIL?.trim();
    if (!to || !shouldSendAlert(`new:${event.fingerprint}`)) return;
    try {
        await resend.emails.send({
            from: RESEND_FROM_EMAIL,
            to,
            subject: `Vireact: new ${event.source} error`,
            html: `<p>A kind of error not seen before just happened.</p>
<p><b>Where:</b> ${escapeHtml(event.source)} ${escapeHtml(event.route || event.url || '')}</p>
<p><b>Error:</b> ${escapeHtml(String(event.message).slice(0, 1000))}</p>
<pre>${escapeHtml(String(event.stack || '').split('\n').slice(0, 8).join('\n'))}</pre>
<p>All errors: GET /api/v1/admin/errors (x-admin-key). Time: ${new Date().toISOString()}</p>`,
        });
    } catch (sendError) {
        console.warn(`[Monitoring] New-error email failed: ${sendError.message}`);
    }
};
onNewError(alertNewKindOfError);

/**
 * A user-visible failure: send to Sentry and (throttled) email the owner.
 * @param {{ stage: 'upload'|'analysis'|'recovery', videoId?: string, userId?: string, error: unknown }} details
 */
export const alertFailure = async ({ stage, videoId, userId, error }) => {
    const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
    captureError(error instanceof Error ? error : new Error(message), { stage, videoId, userId });

    const to = process.env.OPS_ALERT_EMAIL?.trim();
    if (!to || !shouldSendAlert(videoId)) return;
    try {
        await resend.emails.send({
            from: RESEND_FROM_EMAIL,
            to,
            subject: `Vireact ${stage} failed${videoId ? ` (video ${videoId})` : ''}`,
            html: `<p><b>Stage:</b> ${escapeHtml(stage)}</p>
<p><b>Video:</b> ${escapeHtml(videoId || 'n/a')}<br><b>User:</b> ${escapeHtml(userId || 'n/a')}</p>
<p><b>Error:</b> ${escapeHtml(message.slice(0, 1500))}</p>
<p>Time: ${new Date().toISOString()}</p>`,
        });
    } catch (sendError) {
        console.warn(`[Monitoring] Alert email failed: ${sendError.message}`);
    }
};

/**
 * Counts for videos created since `since`.
 * @returns {Promise<{ since: string, uploads: number, completed: number, failed: number, inProgress: number, uploadFailed: number, topErrors: Array<{ error: string, count: number }> }>}
 */
export const getAnalysisStats = async ({ since = new Date(Date.now() - 24 * 60 * 60 * 1000) } = {}) => {
    const match = { createdAt: { $gte: since } };
    const [byStatus, topErrors, uploadFailed] = await Promise.all([
        Video.aggregate([{ $match: match }, { $group: { _id: '$analysisStatus', count: { $sum: 1 } } }]),
        Video.aggregate([
            { $match: { ...match, analysisStatus: ANALYSIS_STATUS.FAILED, lastError: { $type: 'string' } } },
            { $group: { _id: { $substrCP: ['$lastError', 0, 160] }, count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 5 },
        ]),
        Video.countDocuments({ ...match, uploadStatus: UPLOAD_STATUS.FAILED }),
    ]);
    const count = (status) => byStatus.find((row) => row._id === status)?.count ?? 0;
    const uploads = byStatus.reduce((sum, row) => sum + row.count, 0);
    return {
        since: since.toISOString(),
        uploads,
        completed: count(ANALYSIS_STATUS.COMPLETED),
        failed: count(ANALYSIS_STATUS.FAILED),
        inProgress: count(ANALYSIS_STATUS.PENDING) + count(ANALYSIS_STATUS.QUEUED) + count(ANALYSIS_STATUS.PROCESSING),
        uploadFailed,
        topErrors: topErrors.map((row) => ({ error: row._id, count: row.count })),
    };
};

/** Log the last 24 hours and email it when OPS_ALERT_EMAIL is set. */
export const sendDailySummary = async () => {
    try {
        const stats = await getAnalysisStats();
        const errorReport = await getErrorReport({ limit: 5 }).catch(() => null);
        if (errorReport) stats.errors = { total: errorReport.total, bySource: errorReport.bySource, top: errorReport.top.map((e) => ({ source: e.source, message: e.message, count: e.count, affectedUsers: e.affectedUsers })) };
        console.log(`[Monitoring] Last 24h: ${JSON.stringify(stats)}`);
        const to = process.env.OPS_ALERT_EMAIL?.trim();
        if (!to) return stats;
        const errors = stats.topErrors.length
            ? `<ul>${stats.topErrors.map((e) => `<li>${e.count} x ${escapeHtml(e.error)}</li>`).join('')}</ul>`
            : '<p>No failures.</p>';
        await resend.emails.send({
            from: RESEND_FROM_EMAIL,
            to,
            subject: `Vireact daily: ${stats.completed} done, ${stats.failed} failed, ${stats.uploads} uploads`,
            html: `<p>Last 24 hours</p><ul><li>Uploads: ${stats.uploads}</li><li>Completed: ${stats.completed}</li><li>Failed analyses: ${stats.failed}</li><li>Failed uploads: ${stats.uploadFailed}</li><li>Still in progress: ${stats.inProgress}</li></ul><p>Most common errors</p>${errors}${stats.errors ? `<p>Errors caught by the safety net: ${stats.errors.total} (${escapeHtml(JSON.stringify(stats.errors.bySource))})</p><ul>${stats.errors.top.map((e) => `<li>${e.count} x [${escapeHtml(e.source)}] ${escapeHtml(e.message)} (${e.affectedUsers} users)</li>`).join('')}</ul>` : ''}`,
        });
        return stats;
    } catch (error) {
        console.warn(`[Monitoring] Daily summary failed: ${error.message}`);
        return null;
    }
};
