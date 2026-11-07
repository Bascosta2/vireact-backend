import { ApiError } from '../utils/ApiError.js';
import { ApiResponse } from '../utils/ApiResponse.js';
import { getHookRewriteLimits, isLifecycleEmailsEnabled } from '../config/flags.js';
import { OPENAI_API_KEY } from '../config/index.js';
import { ROLES } from '../constants.js';
import { NICHES, PROBLEMS } from '../constants/library.js';
import { QUIZ_OPTIONS } from '../constants/funnel-quiz.js';
import { resolveAccess } from '../service/access.service.js';
import { rewriteHook, MAX_HOOK_LINE_LENGTH } from '../service/hook-rewriter.service.js';
import { withAiContext, newTraceId } from '../lib/ai-tracking.js';
import {
    createSession,
    findSession,
    canAccessSession,
    updateAnswers,
    completeSession,
    buildResults,
    captureEmail,
    hashIp,
    claimDailyQuota,
    releaseDailyQuota,
    claimSessionRewrite,
    releaseSessionRewrite,
} from '../service/funnel.service.js';

const clientIp = (req) => req.ip || req.socket?.remoteAddress || '';
const callerUserId = (req) => (req.user && req.user.role === ROLES.USER ? req.user._id : undefined);

/** 404 for unknown ids and for sessions linked to someone else. */
const loadSession = async (req) => {
    const session = await findSession(req.params.id);
    if (!session || !canAccessSession(session, req.user)) throw new ApiError(404, 'Session not found');
    return session;
};

export const postSession = async (req, res, next) => {
    try {
        const session = await createSession({
            attribution: req.body?.attribution,
            entryItemSlug: req.body?.entryItemSlug,
            ip: clientIp(req),
            userId: callerUserId(req),
        });
        res.status(201).json(ApiResponse.success(201, 'Session started', { sessionId: session._id }));
    } catch (error) {
        next(error);
    }
};

export const patchSession = async (req, res, next) => {
    try {
        const session = await loadSession(req);
        const result = await updateAnswers(session, { answers: req.body?.answers, step: req.body?.step });
        if (result.errors) throw new ApiError(400, result.errors.join('; '));
        res.status(200).json(ApiResponse.success(200, 'Session updated', { answers: result.session.answers }));
    } catch (error) {
        next(error);
    }
};

export const postComplete = async (req, res, next) => {
    try {
        const session = await loadSession(req);
        const result = await completeSession(session);
        if (result.error) throw new ApiError(400, result.error);
        res.status(200).json(ApiResponse.success(200, 'Quiz completed', await buildResults(result.session)));
    } catch (error) {
        next(error);
    }
};

export const getResults = async (req, res, next) => {
    try {
        const session = await loadSession(req);
        const results = await buildResults(session);
        if (!results) throw new ApiError(409, 'Quiz not completed');
        res.status(200).json(ApiResponse.success(200, 'Results', results));
    } catch (error) {
        next(error);
    }
};

export const postEmail = async (req, res, next) => {
    try {
        if (!isLifecycleEmailsEnabled()) throw new ApiError(404, 'Not found');
        const session = await loadSession(req);
        if (!session.recommendedPlan) throw new ApiError(409, 'Quiz not completed');
        const result = await captureEmail(session, req.body?.email);
        if (result.error) throw new ApiError(400, result.error);
        res.status(200).json(ApiResponse.success(200, 'Email saved', { emailCaptured: true }));
    } catch (error) {
        next(error);
    }
};

/**
 * Plan §6.6. Entitled users: daily per-user quota. Everyone else: one rewrite per
 * quiz session and a daily per-IP cap. Quota is refunded when generation fails.
 */
export const postHookRewrite = async (req, res, next) => {
    const refunds = [];
    try {
        const hookLine = typeof req.body?.hookLine === 'string' ? req.body.hookLine.trim() : '';
        if (hookLine.length < 3 || hookLine.length > MAX_HOOK_LINE_LENGTH) {
            throw new ApiError(400, `hookLine must be 3-${MAX_HOOK_LINE_LENGTH} characters`);
        }
        if (!OPENAI_API_KEY) throw new ApiError(503, 'Hook rewriter is unavailable');

        const limits = getHookRewriteLimits();
        const { entitled } = await resolveAccess(req.user);
        const session = req.body?.sessionId ? await findSession(req.body.sessionId) : null;
        if (session && !canAccessSession(session, req.user)) throw new ApiError(404, 'Session not found');

        if (entitled && req.user) {
            const key = `user:${req.user._id}`;
            if (!(await claimDailyQuota(key, limits.entitledPerDay))) throw new ApiError(429, 'Daily rewrite limit reached');
            refunds.push(() => releaseDailyQuota(key));
        } else {
            if (!session) throw new ApiError(400, 'Take the quiz to unlock a free rewrite');
            const key = `ip:${hashIp(clientIp(req))}`;
            if (!(await claimDailyQuota(key, limits.anonPerIpPerDay))) throw new ApiError(429, 'Daily rewrite limit reached');
            refunds.push(() => releaseDailyQuota(key));
            if (!(await claimSessionRewrite(session._id, limits.perSession))) {
                throw new ApiError(429, 'Free rewrite already used. Sign up for more.');
            }
            refunds.push(() => releaseSessionRewrite(session._id));
        }

        const pick = (value, allowed) => (allowed.includes(value) ? value : undefined);
        const answers = session?.answers || {};
        // Signed-in users by id; anonymous quiz takers by funnel session id (aliased to the user on signup).
        const aiDistinctId = req.user?._id || req.body?.sessionId || undefined;
        const result = await withAiContext({ feature: 'hook_rewrite', userId: req.user?._id, distinctId: aiDistinctId, traceId: newTraceId('hook') }, () => rewriteHook({
            hookLine,
            niche: pick(req.body?.niche, NICHES) || answers.niche,
            platform: pick(req.body?.platform, QUIZ_OPTIONS.platform) || answers.platform,
            problem: pick(req.body?.problem, PROBLEMS) || answers.problem,
        }));
        refunds.length = 0;
        res.status(200).json(ApiResponse.success(200, 'Rewrites ready', result));
    } catch (error) {
        await Promise.allSettled(refunds.map((refund) => refund()));
        if (error?.code === 'REWRITE_FAILED') return next(new ApiError(502, 'Could not produce a rewrite. Please try again.'));
        if (!(error instanceof ApiError)) console.error('[funnel] hook rewrite failed:', error.message);
        next(error);
    }
};
