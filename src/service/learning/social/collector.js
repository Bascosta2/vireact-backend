/**
 * Daily public-data collection (docs/learning-engine/PLAN.md, sections 3, 4 and 6). No AI tokens.
 *
 * Order, all inside one record budget (LEARNING_DAILY_RECORDS):
 *   1. re-check  tracked videos due for another reading (1 day to 6 months after posting, see
 *                CHECK_AGES_DAYS) -> growth curves, late bloomers; the most overdue go first
 *   2. discover  search queries for today's slice of the niche tree -> new videos and creators
 *   3. backfill  each new creator's recent videos, hits AND misses -> their baseline (the key to
 *                learning what the video itself did, not the account size)
 *   4. baselines median 7-day views of each touched creator's settled videos
 * Every reading becomes an OutcomeSnapshot (source "provider"); every new video gets VideoFeatures.
 */
import { NICHE_TREE } from '../../../constants/taxonomy.js';
import { SocialCreator, SocialVideo, OutcomeSnapshot, VideoFeatures } from '../../../model/learning.model.js';
import { FEATURE_VERSION, featuresFromSocial } from '../features.js';
import { ageHoursAt, median } from '../labels.js';
import { cleanVideo, cleanCreator, cleanStats, usedOf } from './providers.js';

/**
 * Days after posting at which a tracked video's numbers are read again. Videos keep growing for months
 * on TikTok and Instagram, so tracking runs to 6 months; the gaps widen as growth slows.
 */
export const CHECK_AGES_DAYS = Object.freeze([1, 3, 7, 14, 30, 60, 90, 180]);
export const CHECK_AGES_HOURS = Object.freeze(CHECK_AGES_DAYS.map((d) => d * 24));
/** Videos found by search while younger than this are always tracked: they give whole growth curves. */
export const YOUNG_DAYS = 14;
/**
 * Share of every other video (mostly creator back-catalogs) that is tracked too, picked by a stable hash
 * of its id. Every re-read costs one record, so this keeps re-checks inside the budget. Back-catalog
 * videos already arrive weeks or months old, so their first reading is a long-run number anyway.
 */
export const TRACK_SHARE = 0.1;
export const BACKFILL_VIDEOS = 30;
export const SEARCH_LIMIT = 30;
/** Share of the day's budget per step; unused budget rolls to the next step. */
export const BUDGET_SPLIT = Object.freeze({ recheck: 0.35, discover: 0.25, backfill: 0.4 });
/** Provider calls in flight at once. Provider jobs can take minutes; database writes stay sequential. */
export const CONCURRENCY = 10;
const STATS_BATCH = 20;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Better search phrases where the sub-niche key reads badly. */
const QUERY_OVERRIDES = {
    grwm: 'get ready with me', mukbang_asmr: 'mukbang', day_in_life: 'day in my life', memes_edits: 'meme edit',
    stream_clips: 'stream highlights', desk_setups: 'desk setup', diy_crafts: 'diy craft', photo_video: 'photography tips',
    wellness_mental_health: 'mental health tips', routines_productivity: 'morning routine', life_skills: 'life hacks',
    investing_crypto: 'investing tips', side_hustles: 'side hustle', skills_training: 'training drills',
};
export const queryFor = (subNiche) => QUERY_OVERRIDES[subNiche] ?? subNiche.replace(/_/g, ' ');

/**
 * Today's discovery queries: every niche gets `perNiche` sub-niches, rotating by day so the whole tree is
 * covered every few days. `weights` (niche -> multiplier, from the Sunday audit) can give a niche more.
 */
export const buildCollectionPlan = ({ now = Date.now(), perNiche = 1, weights = {} } = {}) => {
    const day = Math.floor(now / DAY_MS);
    const queries = [];
    for (const [niche, subs] of Object.entries(NICHE_TREE)) {
        if (niche === 'other') continue;
        const n = Math.max(0, Math.round(perNiche * (weights[niche] ?? 1)));
        for (let i = 0; i < Math.min(n, subs.length); i++) {
            const sub = subs[(day * perNiche + i) % subs.length];
            queries.push({ niche, subNiche: sub, query: queryFor(sub) });
        }
    }
    return queries;
};

/**
 * When to read a video's numbers next, or null when its schedule is done (or post time unknown).
 * A check that ran late skips the ages it missed: the reading keeps its real age either way.
 */
export const nextCheckAt = (postedAt, now = Date.now()) => {
    const posted = postedAt ? new Date(postedAt).getTime() : NaN;
    if (!Number.isFinite(posted)) return null;
    for (const age of CHECK_AGES_HOURS) {
        const at = posted + age * HOUR_MS;
        if (at > now + HOUR_MS) return new Date(at);
    }
    return null;
};

/** Stable 0..1 value from an id, so the same video is always in or out of the tracked sample. */
export const sampleValue = (externalId) => {
    let h = 2166136261;
    for (const ch of String(externalId)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return (h >>> 0) / 4294967296;
};

/** Whether a newly found video gets re-checked over time. */
export const isTracked = ({ externalId, postedAt, via }, { now = Date.now(), trackShare = TRACK_SHARE } = {}) => {
    const posted = postedAt ? new Date(postedAt).getTime() : NaN;
    if (!Number.isFinite(posted)) return false;
    if (via === 'search' && now - posted < YOUNG_DAYS * DAY_MS) return true;
    return sampleValue(externalId) < trackShare;
};

/** First check time for a newly found video: null when it is not tracked. */
export const firstCheckAt = (video, opts = {}) => (isTracked(video, opts) ? nextCheckAt(video.postedAt, opts.now ?? Date.now()) : null);

const dayKey = (now) => new Date(now).toISOString().slice(0, 10);

const creatorKeyOf = (platform, externalId) => (externalId ? `social:${platform}:${externalId}` : null);

const writeOutcome = async ({ video, stats, platform, providerName, now, followers = null }) => {
    if (stats.views == null) return;
    await OutcomeSnapshot.updateOne(
        { subjectType: 'social', subjectId: video._id, sourceRef: `${providerName}:${dayKey(now)}` },
        {
            $set: {
                creatorKey: creatorKeyOf(platform, video.creatorExternalId), platform, capturedAt: new Date(now),
                ageHours: ageHoursAt(video.postedAt, now), views: stats.views, likes: stats.likes ?? null,
                comments: stats.comments ?? null, shares: stats.shares ?? null, saves: stats.saves ?? null,
                followers, source: 'provider',
            },
        },
        { upsert: true },
    );
};

const upsertCreator = async (raw, { platform, providerName, nicheHint, now }) => {
    const c = cleanCreator(raw);
    if (!c) return null;
    const set = { handle: c.handle, provider: providerName };
    if (c.followers != null) Object.assign(set, { followers: c.followers, followersAt: new Date(now) });
    return SocialCreator.findOneAndUpdate(
        { platform, externalId: c.externalId },
        { $set: set, $setOnInsert: { niche: nicheHint ?? null } },
        { upsert: true, new: true },
    );
};

/** Upserts one video (+ its reading and features). Returns { doc, isNew } or null when invalid. */
const upsertVideo = async (raw, { platform, providerName, via, query, nicheHint, creatorDoc, now, trackShare = TRACK_SHARE }) => {
    const v = cleanVideo(raw);
    if (!v) return null;
    const existing = await SocialVideo.findOne({ platform, externalId: v.externalId }).select('_id').lean();
    const latest = v.views != null ? { views: v.views, likes: v.likes, comments: v.comments, shares: v.shares, saves: v.saves, at: new Date(now) } : undefined;
    const doc = await SocialVideo.findOneAndUpdate(
        { platform, externalId: v.externalId },
        {
            $set: {
                creatorExternalId: v.creatorExternalId ?? creatorDoc?.externalId ?? null,
                creatorId: creatorDoc?._id ?? null,
                url: v.url, caption: v.caption, hashtags: v.hashtags, soundId: v.soundId, soundTitle: v.soundTitle,
                durationSec: v.durationSec, postedAt: v.postedAt, region: v.region, language: v.language,
                ...(latest ? { latest, lastCheckedAt: new Date(now) } : {}),
            },
            $setOnInsert: { provider: providerName, discoveredVia: via, query: query ?? null, nicheHint: nicheHint ?? null, nextCheckAt: firstCheckAt({ externalId: v.externalId, postedAt: v.postedAt, via }, { now, trackShare }) },
            ...(latest ? { $inc: { checks: 1 } } : {}),
        },
        { upsert: true, new: true },
    );
    await writeOutcome({ video: doc, stats: v, platform, providerName, now, followers: creatorDoc?.followers ?? null });
    if (!existing) {
        await VideoFeatures.updateOne(
            { subjectType: 'social', subjectId: doc._id },
            {
                $set: {
                    creatorKey: creatorKeyOf(platform, doc.creatorExternalId), platform, featureVersion: FEATURE_VERSION,
                    features: featuresFromSocial(doc), followers: creatorDoc?.followers ?? null, postedAt: doc.postedAt, extractedAt: new Date(now),
                },
                $setOnInsert: { niche: nicheHint ?? null },
            },
            { upsert: true },
        );
    }
    return { doc, isNew: !existing };
};

/** Median views of a creator's videos that are at least 7 days old (their latest reading). */
export const refreshBaseline = async (creatorId, now = Date.now()) => {
    const videos = await SocialVideo.find({ creatorId, 'latest.views': { $ne: null }, postedAt: { $lte: new Date(now - 7 * DAY_MS) } })
        .select('latest.views').limit(100).lean();
    const views = videos.map((v) => v.latest?.views).filter(Number.isFinite);
    const update = views.length >= 3
        ? { baselineViews: median(views), baselineN: views.length, baselineAt: new Date(now) }
        : { baselineN: views.length, baselineAt: new Date(now) };
    await SocialCreator.updateOne({ _id: creatorId }, { $set: update });
    return update;
};

/**
 * One collection run. `provider` from getProvider(); `budget` = records allowed today.
 * Never throws for a single failed call: it is counted in `errors` and the run continues.
 */
export const runCollection = async ({ provider, budget, platform = 'tiktok', region = 'US', now = Date.now(), plan = buildCollectionPlan({ now }), trackShare = TRACK_SHARE, log = () => {} }) => {
    const out = { used: 0, rechecked: 0, discovered: 0, newCreators: 0, backfilled: 0, baselines: 0, errors: 0 };
    if (!provider) return { ...out, skipped: 'no provider configured' };
    const providerName = provider.name;
    const left = () => budget - out.used;
    const call = async (label, fn) => {
        try {
            const result = await fn();
            out.used += usedOf(result);
            return result;
        } catch (error) {
            out.errors += 1;
            log(`${label} failed: ${error.message}`);
            return null;
        }
    };
    const touchedCreators = new Set();
    /**
     * Keeps up to CONCURRENCY provider calls in flight; a new one starts as soon as any finishes and
     * `canStart(inFlight)` still allows it (budget). Saves run one at a time, in finishing order.
     */
    const pool = (items, { canStart, fetch, save }) => new Promise((resolve) => {
        let next = 0;
        let inFlight = 0;
        let saving = Promise.resolve();
        const launch = () => {
            while (inFlight < CONCURRENCY && next < items.length && canStart(inFlight)) {
                const item = items[next++];
                inFlight += 1;
                fetch(item)
                    .then((result) => {
                        saving = saving.then(() => save(item, result)).catch((error) => {
                            out.errors += 1;
                            log(`save failed: ${error.message}`);
                        });
                        return saving;
                    })
                    .finally(() => {
                        inFlight -= 1;
                        launch();
                    });
            }
            if (inFlight === 0) saving.then(resolve);
        };
        launch();
    });

    // 1. re-check
    const recheckCap = Math.floor(budget * BUDGET_SPLIT.recheck);
    const due = await SocialVideo.find({ platform, nextCheckAt: { $ne: null, $lte: new Date(now) } })
        .sort({ nextCheckAt: 1 }).limit(Math.max(0, recheckCap)).lean();
    const batches = [];
    for (let i = 0; i < due.length; i += STATS_BATCH) batches.push(due.slice(i, i + STATS_BATCH));
    await pool(batches, {
        canStart: (inFlight) => recheckCap - out.used - inFlight * STATS_BATCH > 0,
        fetch: (batch) => call('videoStats', () => provider.videoStats({
            ids: batch.map((v) => v.externalId),
            videos: batch.map((v) => ({ externalId: v.externalId, url: v.url ?? null })),
        })),
        save: async (batch, result) => {
            const byId = new Map((result?.stats ?? []).map(cleanStats).filter(Boolean).map((s) => [s.externalId, s]));
            for (const v of batch) {
                const s = byId.get(v.externalId);
                const update = { nextCheckAt: nextCheckAt(v.postedAt, now) };
                if (s) {
                    Object.assign(update, { latest: { ...s, at: new Date(now) }, lastCheckedAt: new Date(now) });
                    await writeOutcome({ video: v, stats: s, platform, providerName, now });
                    out.rechecked += 1;
                    if (v.creatorId) touchedCreators.add(String(v.creatorId));
                }
                await SocialVideo.updateOne({ _id: v._id }, { $set: update, ...(s ? { $inc: { checks: 1 } } : {}) });
            }
        },
    });

    // 2. discover
    const discoverCap = Math.min(budget, out.used + Math.floor(budget * BUDGET_SPLIT.discover));
    await pool(plan, {
        canStart: (inFlight) => discoverCap - out.used - inFlight * SEARCH_LIMIT > 0,
        fetch: (q) => call(`search "${q.query}"`, () => provider.searchVideos({ query: q.query, region, limit: SEARCH_LIMIT })),
        save: async (q, result) => {
            if (!result) return;
            const creators = new Map();
            for (const raw of result.creators ?? []) {
                const before = await SocialCreator.exists({ platform, externalId: cleanCreator(raw)?.externalId ?? '' });
                const doc = await upsertCreator(raw, { platform, providerName, nicheHint: q.niche, now });
                if (doc) {
                    creators.set(doc.externalId, doc);
                    if (!before) out.newCreators += 1;
                }
            }
            for (const raw of result.videos ?? []) {
                const creatorExternalId = cleanVideo(raw)?.creatorExternalId;
                let creatorDoc = creators.get(creatorExternalId) ?? null;
                if (!creatorDoc && creatorExternalId) {
                    // The provider listed the video without its creator: track the creator by id anyway.
                    const before = await SocialCreator.exists({ platform, externalId: creatorExternalId });
                    creatorDoc = await upsertCreator({ externalId: creatorExternalId }, { platform, providerName, nicheHint: q.niche, now });
                    if (creatorDoc) {
                        creators.set(creatorExternalId, creatorDoc);
                        if (!before) out.newCreators += 1;
                    }
                }
                const saved = await upsertVideo(raw, { platform, providerName, via: 'search', query: q.query, nicheHint: q.niche, creatorDoc, now, trackShare });
                if (saved?.isNew) out.discovered += 1;
            }
        },
    });

    // 3. backfill creators we have not backfilled yet (newest first)
    const pending = await SocialCreator.find({ platform, backfilledAt: null }).sort({ createdAt: -1 }).limit(200);
    await pool(pending, {
        canStart: (inFlight) => left() - (inFlight + 1) * BACKFILL_VIDEOS >= 0,
        fetch: (creator) => call(`creatorVideos ${creator.externalId}`, () => provider.creatorVideos({ externalId: creator.externalId, handle: creator.handle, limit: BACKFILL_VIDEOS })),
        save: async (creator, result) => {
            if (!result) return;
            let doc = creator;
            if (result.creator) doc = (await upsertCreator(result.creator, { platform, providerName, nicheHint: creator.niche, now })) ?? creator;
            for (const raw of result.videos ?? []) {
                const saved = await upsertVideo(raw, { platform, providerName, via: 'creator_backfill', nicheHint: creator.niche, creatorDoc: doc, now, trackShare });
                if (saved?.isNew) out.backfilled += 1;
            }
            await SocialCreator.updateOne({ _id: creator._id }, { $set: { backfilledAt: new Date(now) } });
            touchedCreators.add(String(creator._id));
        },
    });

    // 4. baselines
    for (const creatorId of touchedCreators) {
        await refreshBaseline(creatorId, now);
        out.baselines += 1;
    }
    log(`collection: ${JSON.stringify(out)}`);
    return out;
};
