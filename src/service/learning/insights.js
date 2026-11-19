/**
 * Confirmed findings -> the product (docs/learning-engine/PLAN.md, section 15.1 item 9 and 16.5).
 *
 * Daily: the hit-vs-miss factor report per niche (and 'all'); a factor becomes a LearningInsight only when it
 * passes the sign test on 30+ creator pairs (p < 0.05). When the latest matrix model has a coefficient for the
 * same feature, it is attached (modelEffect) only if it points the same way (two methods agreeing).
 *
 * At analysis time, learnedContextForVideo() gives each analyzer the confirmed findings that matter to it,
 * for the user's niche, next to this video's own measured value. No findings yet = empty string = no change.
 */
import { LearningInsight, LearningModel, SocialVideoAnalysis, VideoFeatures } from '../../model/learning.model.js';
import { Video } from '../../model/video.model.js';
import { User } from '../../model/user.model.js';
import { isNiche } from '../../constants/taxonomy.js';
import { factorReport, RELIABLE_PAIRS, measuredVideoFeatures } from './deep-features.js';
import { featuresFromVideo } from './features.js';
import { MODEL_KIND } from './model/trainer.js';

export const MAX_P = 0.05;

/** Plain names and units, for text the analyzers read. */
export const FEATURE_TEXT = {
    firstCutSecExact: ['first cut', 's'], cutsPerMinExact: ['cuts per minute', ''], cutsInFirst3sExact: ['cuts in the first 3 seconds', ''],
    cutsPerMinFirst10sExact: ['cuts per minute in the first 10 seconds', ''], cutsPerMinAfter10sExact: ['cuts per minute after 10 seconds', ''],
    avgShotSecExact: ['average shot length', 's'], medianShotSecExact: ['typical shot length', 's'], longestShotSecExact: ['longest shot', 's'],
    shortShotShareExact: ['share of shots under 1 second', '%'], firstSpeechSec: ['first spoken word', 's'], speechWpm: ['speaking speed', ' words/min'],
    speechCoverage: ['share of the video with speech', '%'], openingWords: ['words spoken in the first 3 seconds', ''], wordsBeforeFirstCut: ['words before the first cut', ''],
    onScreenTextShare: ['share of scenes with on-screen text', '%'], textShotShare: ['share of shots with on-screen text', '%'],
    textInFirst2s: ['on-screen text in the first 2 seconds', 'yes/no'], textWhileSpeakingShare: ['on-screen text while talking', '%'],
    hookTextAndSpeech: ['an opening with both text and speech', 'yes/no'], toCameraOpening: ['talking to camera in the opening', 'yes/no'],
    silenceShare: ['share of silence', '%'], loudnessLufs: ['loudness', ' LUFS'], hookEndSec: ['hook length', 's'], musicShare: ['share of scenes with music', '%'],
    motionFirst3s: ['motion in the first 3 seconds', ''], motionHookRatio: ['opening motion vs the rest', 'x'], brightness: ['brightness', '/255'],
    cutsOnBeatShare: ['share of cuts on a beat', '%'], tempoBpm: ['music tempo', ' BPM'], hookFaceShare: ['face size in the opening', '% of frame'],
    hookEyeContact: ['eye contact in the opening', 'yes/no'], hookTextOverlay: ['text overlay in the opening', 'yes/no'], durationSec: ['length', 's'],
};

/** Which analyzer cares about which findings. */
const ANALYZER_KEYS = {
    hook: /^(firstCut|cutsInFirst3s|firstSpeech|openingWords|wordsBeforeFirstCut|textInFirst2s|hookTextAndSpeech|toCameraOpening|hookEndSec|motionFirst3s|motionHookRatio|hook[A-Z])/,
    pacing: /(cut|Cut|Shot|shot|speechWpm|silenceShare|motion|durationSec|tempoBpm)/,
    audio: /^(musicShare|loudnessLufs|silenceShare|speechWpm|speechCoverage|tempoBpm|cutsOnBeat|onsetRate)/,
    caption: /^(onScreenTextShare|textShotShare|textInFirst2s|textWhileSpeakingShare|hookTextOverlay|hookTextAndSpeech)/,
};

const fmt = (key, v) => {
    if (v == null) return 'n/a';
    const [, unit] = FEATURE_TEXT[key] ?? ['', ''];
    if (unit === 'yes/no') return v >= 0.5 ? 'yes' : 'no';
    if (unit === '%') return `${Math.round(v * 100)}%`;
    return `${Math.round(v * 10) / 10}${unit}`;
};

/** Recomputes every LearningInsight from the deep analyses and the latest model. */
export const refreshInsights = async ({ now = Date.now() } = {}) => {
    const rows = await SocialVideoAnalysis.find({ role: { $in: ['hit', 'miss'] } }).select('creatorId role outperformance features niche').lean();
    const model = await LearningModel.findOne({ kind: MODEL_KIND }).sort({ version: -1 }).select('coefficients').lean();
    const effect = new Map((model?.coefficients?.top ?? []).map((c) => [c.column, c.beta]));
    const groups = new Map([['all', rows]]);
    for (const r of rows) {
        if (!r.niche) continue;
        if (!groups.has(r.niche)) groups.set(r.niche, []);
        groups.get(r.niche).push(r);
    }
    const ops = [];
    let findings = 0;
    for (const [niche, list] of groups) {
        for (const f of factorReport(list).factors) {
            if (f.pairs < RELIABLE_PAIRS || !(f.p < MAX_P)) continue;
            const direction = f.hitHigherShare >= 0.5 ? 1 : -1;
            const beta = effect.get(f.feature);
            findings += 1;
            ops.push({
                updateOne: {
                    filter: { niche, feature: f.feature },
                    update: { $set: { pairs: f.pairs, hitHigherShare: f.hitHigherShare, p: f.p, medianHit: f.medianHit, medianMiss: f.medianMiss, correlation: f.correlation, modelEffect: Number.isFinite(beta) && Math.sign(beta) === direction ? beta : null, updatedAt: new Date(now) } },
                    upsert: true,
                },
            });
        }
    }
    if (ops.length) await LearningInsight.bulkWrite(ops, { ordered: false });
    await LearningInsight.deleteMany({ updatedAt: { $lt: new Date(now - 60_000) } });
    return { findings, niches: groups.size - 1 };
};

const nicheOf = async (userId) => {
    if (!userId) return null;
    const u = await User.findById(userId).select('creatorProfile.niche onboarding.answers.niche').lean();
    return [u?.creatorProfile?.niche, u?.onboarding?.answers?.niche].find(isNiche) ?? null;
};

/** Text lines for one analyzer (pure; exported for tests). */
export const insightLines = (insights, features = {}, analyzer = 'pacing', { max = 5 } = {}) => {
    const re = ANALYZER_KEYS[analyzer];
    if (!re) return [];
    return insights
        .filter((i) => re.test(i.feature) && FEATURE_TEXT[i.feature])
        .sort((a, b) => Math.abs(b.hitHigherShare - 0.5) - Math.abs(a.hitHigherShare - 0.5))
        .slice(0, max)
        .map((i) => {
            const [name] = FEATURE_TEXT[i.feature];
            const mine = features[i.feature];
            const share = Math.round((i.hitHigherShare >= 0.5 ? i.hitHigherShare : 1 - i.hitHigherShare) * 100);
            const dir = i.hitHigherShare >= 0.5 ? 'more' : 'less';
            const where = i.niche === 'all' ? 'across niches' : `in ${String(i.niche).replace(/_/g, ' ')}`;
            return `- ${name}: ${where}, a creator's stronger videos had ${dir} (typical ${fmt(i.feature, i.medianHit)} vs ${fmt(i.feature, i.medianMiss)} on weaker ones; ${share}% of ${i.pairs} measured creator pairs). This video: ${mine == null ? 'not measured' : fmt(i.feature, typeof mine === 'boolean' ? (mine ? 1 : 0) : mine)}.`;
        });
};

/**
 * The block an analyzer adds to its context. Never throws; '' when there is nothing confirmed.
 */
export const learnedContextForVideo = async (videoId, analyzer) => {
    try {
        if (!videoId || !ANALYZER_KEYS[analyzer]) return '';
        const any = await LearningInsight.estimatedDocumentCount();
        if (!any) return '';
        const video = await Video.findById(videoId).select('uploader_id duration scenes rawTranscript analysis viralityScore sourceDescription postedAt contentProfile mediaMeasure').lean();
        if (!video) return '';
        const niche = await nicheOf(video.uploader_id);
        const insights = await LearningInsight.find({ niche: { $in: niche ? [niche, 'all'] : ['all'] } }).lean();
        // Prefer the niche's own finding over the cross-niche one for the same feature.
        const best = new Map();
        for (const i of insights) if (!best.has(i.feature) || i.niche !== 'all') best.set(i.feature, i);
        const stored = await VideoFeatures.findOne({ subjectType: 'video', subjectId: video._id }).select('features').lean();
        const features = { ...(stored?.features ?? {}), ...featuresFromVideo(video), ...measuredVideoFeatures(video) };
        const lines = insightLines([...best.values()], features, analyzer);
        if (!lines.length) return '';
        return [
            'MEASURED PATTERNS (from real short-form videos: each creator\'s stronger vs weaker videos, so account size is held fixed). Use them only when they apply to this video, as evidence, never as guarantees:',
            ...lines,
        ].join('\n');
    } catch {
        return '';
    }
};
