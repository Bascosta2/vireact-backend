import crypto from 'node:crypto';
import { ScheduledPost, POST_STATUS, TARGET_STATUS } from '../../model/scheduled-post.model.js';
import { User } from '../../model/user.model.js';
import { ConnectedAccount, ACCOUNT_STATUS } from '../../model/connected-account.model.js';
import { getQStashClient } from '../../lib/qstash.js';
import { storage } from '../../lib/storage.js';
import { hasPublishingAccess, isPublishingDryRun } from '../../config/flags.js';
import { accessTokenFor, PROVIDERS } from '../accounts/accounts.service.js';
import { PublishError, dryRunPublisher, permanent, reconnect, transient } from './publishers/index.js';
import { tiktokPublisher } from './publishers/tiktok.js';
import { instagramPublisher } from './publishers/instagram.js';
import { youtubePublisher } from './publishers/youtube.js';
import { facebookPublisher } from './publishers/facebook.js';

/**
 * Publishing engine job. Creating a post queues one QStash message for its scheduledAt (notBefore); the
 * signed webhook POST /api/v1/posts/jobs/run calls runPublishJob(postId).
 *
 * One pass: claim the post with a lease (so two deliveries never publish at once), run every target that
 * is due, save each target's outcome as soon as it is known, then either finish the post or queue the next
 * pass for the earliest retry / status check. Guarantees:
 * - a target that is `published` is never sent again (only pending/publishing targets run);
 * - platform progress (upload session, container id...) is saved before unsafe steps, so a retry resumes;
 * - transient errors retry with backoff (1 min, 5 min, 15 min, 1 h, 3 h), then fail in plain English;
 * - QStash longest delay is capped (PUBLISH_QUEUE_MAX_DELAY_DAYS, default 7): later posts hop until due.
 */

export const PUBLISHERS = Object.freeze({
    tiktok: tiktokPublisher,
    instagram: instagramPublisher,
    youtube: youtubePublisher,
    facebook: facebookPublisher,
});
export const PLATFORM_NAMES = Object.freeze({ tiktok: 'TikTok', instagram: 'Instagram', youtube: 'YouTube', facebook: 'Facebook' });

export const LEASE_MS = 15 * 60 * 1000;
export const DUE_SLACK_MS = 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const BACKOFF_SEC = Object.freeze([60, 300, 900, 3600, 3 * 3600]);
/** How long a platform may keep "processing" before the target is given up. */
export const MAX_WAIT_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE = [TARGET_STATUS.PENDING, TARGET_STATUS.PUBLISHING];

export const backoffSec = (attempts) => BACKOFF_SEC[Math.min(Math.max(attempts, 1), BACKOFF_SEC.length) - 1];

// ---- pure state transitions

/**
 * The target after one step. `outcome` is { type: 'published', externalId, url, state } |
 * { type: 'waiting', state, retryInSec } | { type: 'error', error: PublishError }.
 */
export const applyOutcome = (target, outcome, now = Date.now()) => {
    const t = { ...target, state: { ...(target.state ?? {}) } };
    const name = PLATFORM_NAMES[t.platform] ?? t.platform;
    if (t.status === TARGET_STATUS.PUBLISHED || t.status === TARGET_STATUS.CANCELLED) return t;
    if (outcome.type === 'published') {
        return { ...t, status: TARGET_STATUS.PUBLISHED, externalId: outcome.externalId ?? null, url: outcome.url ?? null, error: null, nextAttemptAt: null, publishedAt: new Date(now), state: outcome.state ?? t.state };
    }
    if (outcome.type === 'waiting') {
        const waitStartedAt = t.state.waitStartedAt ?? now;
        const maxWait = outcome.maxWaitMs ?? MAX_WAIT_MS;
        if (now - waitStartedAt > maxWait) {
            const mins = Math.round(maxWait / 60000);
            const span = mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`;
            return { ...t, status: TARGET_STATUS.FAILED, nextAttemptAt: null, error: `${name} was still processing the video after ${span}. Check ${name} directly; if the post is not there, schedule it again.` };
        }
        return { ...t, status: TARGET_STATUS.PUBLISHING, error: null, nextAttemptAt: new Date(now + Math.max(5, outcome.retryInSec ?? 30) * 1000), state: { ...(outcome.state ?? t.state), waitStartedAt } };
    }
    const e = outcome.error;
    if (e.reauth || !e.retry) return { ...t, status: TARGET_STATUS.FAILED, nextAttemptAt: null, error: e.message };
    const attempts = (t.attempts ?? 0) + 1;
    if (attempts >= MAX_ATTEMPTS) {
        return { ...t, attempts, status: TARGET_STATUS.FAILED, nextAttemptAt: null, error: `${e.message.replace(/ We will (try again|continue|start|check|upload)[^.]*\./, '')} We tried ${attempts} times and stopped. Schedule the post again to retry.`.replace(/\s+/g, ' ').trim() };
    }
    const waitSec = Math.max(backoffSec(attempts), e.retryAfterSec ?? 0);
    return { ...t, attempts, status: TARGET_STATUS.PUBLISHING, error: null, nextAttemptAt: new Date(now + waitSec * 1000), state: e.resetState ? {} : t.state };
};

/** The post's status from its targets; 'publishing' while any target is still active. */
export const aggregateStatus = (targets) => {
    if (targets.some((t) => ACTIVE.includes(t.status))) return POST_STATUS.PUBLISHING;
    const live = targets.filter((t) => t.status !== TARGET_STATUS.CANCELLED);
    const published = live.filter((t) => t.status === TARGET_STATUS.PUBLISHED).length;
    if (!live.length) return POST_STATUS.CANCELLED;
    if (published === live.length) return POST_STATUS.PUBLISHED;
    return published ? POST_STATUS.PARTIALLY_PUBLISHED : POST_STATUS.FAILED;
};

export const isRunnable = (t, now = Date.now()) => ACTIVE.includes(t.status) && (!t.nextAttemptAt || new Date(t.nextAttemptAt).getTime() <= now);

/** Earliest time an active target wants to run again. */
export const nextWakeAt = (targets, now = Date.now()) => {
    const times = targets.filter((t) => ACTIVE.includes(t.status)).map((t) => (t.nextAttemptAt ? new Date(t.nextAttemptAt).getTime() : now));
    return times.length ? Math.max(now, Math.min(...times)) : null;
};

// ---- queue

/** The QStash message for one pass (exported for tests). Delivery is capped at the queue's longest delay. */
export const buildRunMessage = ({ postId, version = 1, at, now = Date.now(), env = process.env }) => {
    const base = String(env.BACKEND_URL ?? '').replace(/\/+$/, '');
    if (!base) throw new Error('BACKEND_URL is required to schedule posts');
    const maxDays = Number(env.PUBLISH_QUEUE_MAX_DELAY_DAYS) > 0 ? Number(env.PUBLISH_QUEUE_MAX_DELAY_DAYS) : 7;
    const deliverAt = Math.min(Math.max(new Date(at).getTime(), now), now + maxDays * DAY_MS);
    const notBefore = Math.floor(deliverAt / 1000);
    return {
        url: `${base}/api/v1/posts/jobs/run`,
        body: { postId: String(postId), version },
        notBefore,
        retries: 3,
        // Two passes that pick the same wake-up time queue one message, so chains never multiply.
        deduplicationId: `post-${postId}-v${version}-${notBefore}`,
    };
};

let publishOverride = null;
/** Tests: capture queued messages instead of calling QStash. Pass null to restore. */
export const setPublishQueueForTests = (fn) => {
    publishOverride = fn;
};

/** Queues a pass. Dry-run without QStash configured runs in this process instead (local testing only). */
export const scheduleRun = async ({ postId, version, at, env = process.env, now = Date.now(), publish } = {}) => {
    const send = publish ?? publishOverride;
    const message = buildRunMessage({ postId, version, at, now, env: send ? { BACKEND_URL: 'http://test.local', ...env } : env });
    if (send) return send(message);
    if (isPublishingDryRun() && !String(env.QSTASH_TOKEN ?? '').trim()) {
        const timer = setTimeout(() => {
            void runPublishJob(String(postId), { version }).catch((e) => console.error('[publish] dry-run pass failed:', e.message));
        }, Math.max(0, message.notBefore * 1000 - now));
        timer.unref?.();
        return `local-${postId}-${message.notBefore}`;
    }
    const result = await getQStashClient().publishJSON(message);
    return typeof result === 'string' ? result : result?.messageId ?? null;
};

/** Best effort: drop a queued message that is no longer needed (the job ignores it anyway). */
export const cancelRun = async (messageId) => {
    if (!messageId || publishOverride || String(messageId).startsWith('local-')) return;
    try { await getQStashClient().messages.delete(messageId); } catch { /* already delivered or gone */ }
};

// ---- storage access for publishers

/** What publishers read: signed link, byte ranges and a stream of the user's video in our bucket. */
export const mediaFor = (post, { storageImpl = storage, fetchImpl = fetch } = {}) => {
    const key = post.media?.key;
    const sizeBytes = Number(post.media?.sizeBytes) || 0;
    const signedUrl = (ttlSec = 3600) => storageImpl.presignDownload(key, { expiresIn: ttlSec });
    const get = async (range) => {
        let res;
        try {
            res = await fetchImpl(await signedUrl(3 * 3600), { headers: { Range: range } });
        } catch {
            throw transient('We could not read your video from storage. We will try again shortly.');
        }
        if (res.status !== 206 && res.status !== 200) throw transient('We could not read your video from storage. We will try again shortly.');
        return res;
    };
    return {
        sizeBytes,
        contentType: post.media?.contentType || 'video/mp4',
        durationSec: post.media?.durationSec ?? null,
        signedUrl,
        async readRange(start, end) {
            const res = await get(`bytes=${start}-${end}`);
            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length !== end - start + 1) throw transient('We could not read your video from storage. We will try again shortly.');
            return buf;
        },
        async openStream(offset = 0) {
            const res = await get(`bytes=${offset}-`);
            return res.body;
        },
    };
};

// ---- persistence (Mongo by default; tests pass an in-memory repo)

/** Every write of a pass is conditioned on its lock token; a pass that lost its lease changes nothing. */
export class LeaseLostError extends Error {
    constructor() {
        super('publishing lease lost');
        this.name = 'LeaseLostError';
    }
}
const mine = (postId, lockToken) => ({ _id: postId, lockToken });
const checked = async (write) => {
    const r = await write;
    if (!r?.matchedCount) throw new LeaseLostError();
    return r;
};

export const mongoRepo = {
    claim: (postId, now, lockToken) => ScheduledPost.findOneAndUpdate(
        {
            _id: postId,
            status: { $in: [POST_STATUS.SCHEDULED, POST_STATUS.PUBLISHING] },
            scheduledAt: { $lte: new Date(now + DUE_SLACK_MS) },
            $or: [{ lockedUntil: null }, { lockedUntil: { $lte: new Date(now) } }],
        },
        { $set: { status: POST_STATUS.PUBLISHING, lockedUntil: new Date(now + LEASE_MS), lockToken } },
        { new: true, lean: true },
    ),
    get: (postId) => ScheduledPost.findById(postId).lean(),
    renew: (postId, lockToken, until) => checked(ScheduledPost.updateOne(mine(postId, lockToken), { $set: { lockedUntil: new Date(until) } })),
    saveTargetState: (postId, lockToken, i, state) => checked(ScheduledPost.updateOne(mine(postId, lockToken), { $set: { [`targets.${i}.state`]: state } })),
    saveTarget: (postId, lockToken, i, t) => checked(ScheduledPost.updateOne(mine(postId, lockToken), {
        $set: Object.fromEntries(['status', 'externalId', 'url', 'error', 'attempts', 'nextAttemptAt', 'state', 'publishedAt'].map((k) => [`targets.${i}.${k}`, t[k] ?? (k === 'state' ? {} : k === 'attempts' ? 0 : null)])),
    })),
    finish: (postId, lockToken, patch) => checked(ScheduledPost.updateOne(mine(postId, lockToken), { $set: { ...patch, lockedUntil: null, lockToken: null } })),
    findAccount: (id) => (id ? ConnectedAccount.findById(id).lean() : null),
    findOwner: (userId) => User.findById(userId).select('email').lean(),
    markReauth: (id) => ConnectedAccount.updateOne({ _id: id }, { $set: { status: ACCOUNT_STATUS.NEEDS_REAUTH } }),
};

const hasScopes = (account, required) => {
    const granted = new Set(account?.tokens?.scopes ?? []);
    return required.every((s) => granted.has(s));
};

/** Account + token for one target, or a PublishError explaining in plain English why not. */
const credentialsFor = async (target, mode, publisher, { repo, accessToken, env, fetchImpl }) => {
    const name = PLATFORM_NAMES[target.platform];
    const account = await repo.findAccount(target.accountId);
    if (!account) throw permanent(`Your ${name} account was disconnected. Connect it again in the Accounts tab, then schedule the post again.`);
    if (account.status === ACCOUNT_STATUS.NEEDS_REAUTH) throw reconnect(name);
    if (!hasScopes(account, publisher.requiredScopes(mode))) {
        throw permanent(`${name} did not give Vireact permission to post. Reconnect ${name} with posting allowed in the Accounts tab.`);
    }
    try {
        return { account, access: await accessToken(account, { env, fetchImpl }) };
    } catch (e) {
        if (e.reauth) throw reconnect(name);
        if (e.statusCode === 404) throw permanent(`${name} connections are not available yet.`);
        throw transient(`We could not refresh your ${name} sign-in. We will try again shortly.`);
    }
};

const TURNED_OFF = 'Scheduled posting was turned off before this post went out, so it was not sent.';

/**
 * One pass over a post. Returns a summary; never throws for platform failures (they are stored on targets).
 * @param {string} postId
 * @param {object} [deps] repo, publishers, providers, accessToken, media, schedule, clock, env, fetchImpl, dryRun,
 *   version, hasAccess, renewEveryMs
 */
export async function runPublishJob(postId, deps = {}) {
    const repo = deps.repo ?? mongoRepo;
    const clock = deps.clock ?? (() => Date.now());
    const env = deps.env ?? process.env;
    const publishers = deps.publishers ?? PUBLISHERS;
    const providers = deps.providers ?? PROVIDERS;
    const accessToken = deps.accessToken ?? accessTokenFor;
    const hasAccess = deps.hasAccess ?? hasPublishingAccess;
    const schedule = deps.schedule ?? ((args) => scheduleRun({ ...args, env }));
    const makeMedia = deps.media ?? ((post) => mediaFor(post, { fetchImpl: deps.mediaFetch ?? fetch }));

    const start = clock();
    const lockToken = crypto.randomUUID();
    const post = await repo.claim(postId, start, lockToken);
    if (!post) {
        const current = await repo.get(postId);
        if (!current) return { skipped: 'missing' };
        if (![POST_STATUS.SCHEDULED, POST_STATUS.PUBLISHING].includes(current.status)) return { skipped: current.status };
        if (current.lockedUntil && new Date(current.lockedUntil).getTime() > start) {
            // Another pass holds the lease; look again just after it expires (covers a pass that died).
            await schedule({ postId, version: current.scheduleVersion, at: new Date(current.lockedUntil).getTime() + 30_000, now: start });
            return { deferred: 'locked' };
        }
        if (deps.version != null && deps.version !== current.scheduleVersion) return { skipped: 'stale' };
        // Not due yet (scheduled beyond the queue's longest delay): hop to the next delivery.
        await schedule({ postId, version: current.scheduleVersion, at: new Date(current.scheduledAt).getTime(), now: start });
        return { deferred: 'not_due' };
    }

    // Keep the lease while long uploads run; a pass that lost it stops at its next write.
    const renewEvery = deps.renewEveryMs ?? Math.floor(LEASE_MS / 3);
    let leaseLost = false;
    const renewTimer = setInterval(() => {
        void repo.renew(postId, lockToken, clock() + LEASE_MS).catch(() => { leaseLost = true; });
    }, renewEvery);
    renewTimer.unref?.();

    try {
        const targets = post.targets.map((t) => ({ ...t, state: { ...(t.state ?? {}) } }));
        // Kill switch: the owner lost access (PUBLISHING_ENABLED off and not in the beta list): send nothing.
        const owner = await repo.findOwner(post.userId);
        if (!hasAccess(owner)) {
            for (let i = 0; i < targets.length; i++) {
                if (![TARGET_STATUS.PENDING, TARGET_STATUS.PUBLISHING].includes(targets[i].status)) continue;
                targets[i] = { ...targets[i], status: TARGET_STATUS.CANCELLED, nextAttemptAt: null, error: TURNED_OFF };
                await repo.saveTarget(postId, lockToken, i, targets[i]);
            }
            const status = aggregateStatus(targets);
            await repo.finish(postId, lockToken, { status, completedAt: new Date(clock()) });
            return { status, turnedOff: true };
        }

        // Test posts stay simulated forever; the flag can also force simulation for every post.
        const dryRun = deps.dryRun ?? (Boolean(post.dryRun) || isPublishingDryRun());
        const media = makeMedia(post);
        const results = [];
        for (let i = 0; i < targets.length; i++) {
            const target = targets[i];
            if (!isRunnable(target, clock())) continue;
            if (leaseLost) throw new LeaseLostError();
            const publisher = dryRun ? dryRunPublisher(target.platform) : publishers[target.platform];
            let outcome;
            let account = null;
            try {
                if (!publisher) throw permanent(`Posting to ${PLATFORM_NAMES[target.platform] ?? target.platform} is not available yet.`);
                let access = null;
                if (!dryRun) ({ account, access } = await credentialsFor(target, post.mode, publisher, { repo, accessToken, env, fetchImpl: deps.fetchImpl }));
                const r = await publisher.step({
                    post, target, account, access, media, env, fetchImpl: deps.fetchImpl ?? fetch, now: clock(), provider: providers[target.platform] ?? null,
                    save: async (state) => { target.state = { ...state, ...(target.state?.waitStartedAt ? { waitStartedAt: target.state.waitStartedAt } : {}) }; await repo.saveTargetState(postId, lockToken, i, target.state); },
                });
                outcome = r.status === 'published' ? { type: 'published', ...r } : { type: 'waiting', ...r };
            } catch (e) {
                if (e instanceof LeaseLostError) throw e;
                if (!(e instanceof PublishError)) console.error(`[publish] ${target.platform} step crashed for ${postId}:`, e.message);
                outcome = { type: 'error', error: e instanceof PublishError ? e : transient(`Something went wrong while posting to ${PLATFORM_NAMES[target.platform] ?? target.platform}. We will try again shortly.`) };
            }
            targets[i] = applyOutcome(target, outcome, clock());
            await repo.saveTarget(postId, lockToken, i, targets[i]);
            if (outcome.type === 'error' && outcome.error.reauth && account?._id) await repo.markReauth(account._id).catch(() => {});
            results.push({ platform: target.platform, status: targets[i].status });
        }

        const status = aggregateStatus(targets);
        if (status === POST_STATUS.PUBLISHING) {
            const at = nextWakeAt(targets, clock());
            let queueMessageId = post.queueMessageId ?? null;
            try {
                queueMessageId = await schedule({ postId, version: post.scheduleVersion, at, now: clock() }) ?? queueMessageId;
            } catch (e) {
                // QStash retries this delivery when we answer with an error; release the lease so it can run.
                await repo.finish(postId, lockToken, { status });
                throw e;
            }
            await repo.finish(postId, lockToken, { status, queueMessageId });
            return { status, results, nextAt: new Date(at) };
        }
        await repo.finish(postId, lockToken, { status, completedAt: new Date(clock()) });
        return { status, results };
    } catch (e) {
        // Another pass owns the post now: it carries on from the saved progress.
        if (e instanceof LeaseLostError) return { skipped: 'lease_lost' };
        throw e;
    } finally {
        clearInterval(renewTimer);
    }
}
