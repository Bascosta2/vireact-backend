/**
 * Sound trends (docs/learning-engine/PLAN.md, sections 5.6 and 15.1 item 7). Plain counting, no AI.
 *
 * For every non-original sound seen in collected public videos: how many videos used it in the last 14 days
 * vs the 14 before, and how those videos did against their creators' usual (median outperformance).
 * Stage: emerging -> rising -> peak -> fading. Our sample is ~1,800 videos a day across all niches, so only
 * sounds used several times show up; this is a signal, not TikTok's full picture.
 */
import { SocialCreator, SocialVideo, SoundTrend } from '../../model/learning.model.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** "original sound" in the languages TikTok shows it in: a creator's own audio is never a trend. */
const ORIGINAL = /original sound|son original|sonido original|som original|originalton|suono originale|origineel geluid|oryginalny dźwięk|orijinal ses|suara asli|âm thanh gốc|เสียงต้นฉบับ|оригинальный звук|оригінальний звук|الصوت الأصلي|오리지널 사운드|オリジナル楽曲|オリジナル音源|原声|原聲|मूल ध्वनि/i;
const median = (xs) => {
    const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
    if (!s.length) return null;
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const isOriginalSound = (title) => !title || ORIGINAL.test(String(title));

/** Lifecycle stage from recent use and how its videos perform, or null with too little use. */
export const soundStage = ({ last14 = 0, prior14 = 0, medianOutperformance = null } = {}) => {
    if (last14 + prior14 < 3) return null;
    const good = Number.isFinite(medianOutperformance) && medianOutperformance > 0;
    if (prior14 <= 1 && last14 >= 3) return good ? 'emerging' : 'rising';
    if (last14 >= prior14 * 1.5) return good ? 'rising' : 'peak';
    if (last14 >= prior14 * 0.67) return good ? 'peak' : 'fading';
    return 'fading';
};

/**
 * Uses of each sound by collected videos posted in the 14 days before `at` (excluding the video itself):
 * a model feature "how trendy was this sound when the video was posted".
 * index: Map soundId -> sorted post times (ms).
 */
export const usesBefore = (index, soundId, at, { days = 14 } = {}) => {
    const times = index.get(soundId);
    if (!times || !Number.isFinite(at)) return 0;
    let n = 0;
    for (const t of times) if (t < at && t >= at - days * DAY_MS) n += 1;
    return n;
};

/** soundId -> sorted post times, for usesBefore. */
export const buildSoundIndex = (videos = []) => {
    const index = new Map();
    for (const v of videos) {
        if (!v?.soundId || isOriginalSound(v.soundTitle)) continue;
        const t = new Date(v.postedAt).getTime();
        if (!Number.isFinite(t)) continue;
        if (!index.has(v.soundId)) index.set(v.soundId, []);
        index.get(v.soundId).push(t);
    }
    for (const list of index.values()) list.sort((a, b) => a - b);
    return index;
};

/** Recomputes SoundTrend for sounds used in the last 56 days. Returns counts by stage. */
export const refreshSoundTrends = async ({ now = Date.now() } = {}) => {
    const videos = await SocialVideo.find({ soundId: { $ne: null }, postedAt: { $gte: new Date(now - 56 * DAY_MS) } })
        .select('soundId soundTitle postedAt latest.views creatorId').lean();
    const creators = new Map((await SocialCreator.find({ _id: { $in: [...new Set(videos.map((v) => String(v.creatorId)).filter((x) => x !== 'null'))] }, baselineViews: { $ne: null } })
        .select('baselineViews').lean()).map((c) => [String(c._id), c.baselineViews]));
    const bySound = new Map();
    for (const v of videos) {
        if (isOriginalSound(v.soundTitle)) continue;
        if (!bySound.has(v.soundId)) bySound.set(v.soundId, { title: v.soundTitle, rows: [] });
        bySound.get(v.soundId).rows.push(v);
    }
    const counts = { sounds: 0, emerging: 0, rising: 0, peak: 0, fading: 0 };
    const ops = [];
    for (const [soundId, { title, rows }] of bySound) {
        const t = (v) => new Date(v.postedAt).getTime();
        const last14 = rows.filter((v) => t(v) >= now - 14 * DAY_MS).length;
        const prior14 = rows.filter((v) => t(v) < now - 14 * DAY_MS && t(v) >= now - 28 * DAY_MS).length;
        const outs = rows
            .map((v) => {
                const b = creators.get(String(v.creatorId));
                return Number.isFinite(b) && Number.isFinite(v.latest?.views) && t(v) <= now - 7 * DAY_MS ? Math.log((v.latest.views + 1) / (b + 1)) : null;
            })
            .filter(Number.isFinite);
        const medianOutperformance = median(outs);
        const stage = soundStage({ last14, prior14, medianOutperformance });
        if (!stage) continue;
        counts.sounds += 1;
        counts[stage] += 1;
        ops.push({
            updateOne: {
                filter: { soundId },
                update: { $set: { title: title ?? null, last14, prior14, uses56: rows.length, medianOutperformance, measured: outs.length, stage, updatedAt: new Date(now) } },
                upsert: true,
            },
        });
    }
    if (ops.length) await SoundTrend.bulkWrite(ops, { ordered: false });
    await SoundTrend.deleteMany({ updatedAt: { $lt: new Date(now - 7 * DAY_MS) } });
    return counts;
};
