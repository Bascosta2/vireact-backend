/**
 * Deep analysis of public videos, pure side (docs/learning-engine/PLAN.md, sections 5.2 and 6).
 *
 * A deep-analyzed video has three timed sources:
 *   cuts        exact shot changes measured by ffmpeg on the real file (seconds)
 *   scenes      Twelve Labs Pegasus scene list: what is on screen, on-screen text, audio, action, purpose
 *   transcript  Pegasus speech transcript: [{ text, tStart, tEnd }]
 * This file turns them into
 *   - a timeline: one row per real shot with what is said during it and what is on screen,
 *   - features: the same keys a user's upload gets (comparable rows for training) plus exact-cut and
 *     speech/text alignment keys that only measured cuts can give,
 * and holds the sample picker and the hit-vs-miss factor report. No I/O here.
 */
import { sceneFeatures, transcriptFeatures } from './features.js';
import { descriptionFeatures, spokenTranscript, sungTranscript } from './content-read.js';
import { hookFeatures } from './hook-vision.js';

/** Cuts closer together than this are one cut (flash frames, transitions measured twice). */
export const MIN_SHOT_SEC = 0.2;
const round = (x, places = 3) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** places) / 10 ** places);
const num = (x) => (x !== null && x !== '' && Number.isFinite(Number(x)) ? Number(x) : null);
const overlap = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const median = (values) => {
    const s = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!s.length) return null;
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const wordsOf = (text) => String(text ?? '').trim().split(/\s+/).filter(Boolean);

/** Shot boundaries from measured cut times: [{ start, end }] covering 0..duration. */
export const shotsFromCuts = (cuts = [], durationSec = null) => {
    const duration = num(durationSec);
    if (!(duration > 0)) return [];
    const points = [...new Set((Array.isArray(cuts) ? cuts : []).map(num).filter((t) => t != null && t > MIN_SHOT_SEC && t < duration - MIN_SHOT_SEC))]
        .sort((a, b) => a - b);
    const kept = [];
    for (const t of points) if (!kept.length || t - kept.at(-1) >= MIN_SHOT_SEC) kept.push(t);
    const bounds = [0, ...kept, duration];
    const shots = [];
    for (let i = 0; i < bounds.length - 1; i++) shots.push({ start: round(bounds[i]), end: round(bounds[i + 1]) });
    return shots;
};

/** Shots from the Pegasus scene list, for when the file could not be measured (scene times are estimates). */
export const shotsFromScenes = (scenes = []) => (Array.isArray(scenes) ? scenes : [])
    .filter((s) => Number.isFinite(s?.startTime) && Number.isFinite(s?.endTime) && s.endTime > s.startTime)
    .sort((a, b) => a.startTime - b.startTime)
    .map((s) => ({ start: round(s.startTime), end: round(s.endTime) }));

const segmentOf = (s) => ({ start: num(s?.tStart ?? s?.start), end: num(s?.tEnd ?? s?.end), text: String(s?.text ?? s?.value ?? '') });

/**
 * One row per shot: when it starts and ends, the words spoken during it, and what is on screen.
 * Words of a transcript segment are spread evenly over its time span, so a sentence that runs across a
 * cut is split at the cut. Screen content comes from the Pegasus scene that overlaps the shot most.
 * With a content read, lyrics go to `sung` instead of `said`, so they never count as speech.
 */
export const buildTimeline = ({ shots = [], scenes = [], transcript = [], read = null } = {}) => {
    const rows = shots.map((shot, i) => ({ i, start: shot.start, end: shot.end, words: [], sung: [] }));
    if (!rows.length) return [];
    const findShot = (t) => {
        for (let k = rows.length - 1; k >= 0; k--) if (t >= rows[k].start) return k;
        return 0;
    };
    const place = (list, field) => {
        for (const seg of list.map(segmentOf)) {
            const words = wordsOf(seg.text);
            if (!words.length || seg.start == null) continue;
            const end = seg.end != null && seg.end > seg.start ? seg.end : seg.start;
            const step = (end - seg.start) / words.length;
            words.forEach((w, k) => rows[findShot(seg.start + (k + 0.5) * step)][field].push(w));
        }
    };
    place(spokenTranscript(transcript, read), 'words');
    place(sungTranscript(transcript, read), 'sung');
    const timedScenes = (Array.isArray(scenes) ? scenes : []).filter((s) => Number.isFinite(s?.startTime) && Number.isFinite(s?.endTime));
    return rows.map((row) => {
        let best = null;
        let bestOverlap = 0;
        for (const s of timedScenes) {
            const o = overlap(row.start, row.end, s.startTime, Math.max(s.endTime, s.startTime + 0.01));
            if (o > bestOverlap) { best = s; bestOverlap = o; }
        }
        return {
            i: row.i,
            start: row.start,
            end: row.end,
            durationSec: round(row.end - row.start),
            said: row.words.join(' '),
            ...(row.sung.length ? { sung: row.sung.join(' ') } : {}),
            onScreenText: best?.onScreenText ?? '',
            visual: best?.visualDescription ?? '',
            action: best?.primaryAction ?? '',
            audio: best?.audioSummary ?? '',
            tone: best?.emotionalTone ?? '',
            purpose: best?.purpose ?? '',
        };
    });
};

const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && !(typeof v === 'number' && !Number.isFinite(v))));

/**
 * Features of a deep-analyzed video. Pegasus-based keys match featuresFromVideo (user uploads), so
 * both can be trained on together; *Exact keys come from measured cuts and exist only when the file
 * was measured (cutsSource 'ffmpeg').
 */
export const deepFeatures = ({
    durationSec, cutsSource = null, shots = [], scenes = [], transcript = [], timeline = [], silences = [], loudnessLufs = null, hasAudio = null,
    picture = {}, rhythm = {}, hook = {}, read = null,
} = {}) => {
    const duration = num(durationSec);
    const base = {
        durationSec: duration != null ? round(duration, 1) : null,
        ...sceneFeatures(scenes, duration),
        ...transcriptFeatures(spokenTranscript(transcript, read), duration),
        ...descriptionFeatures(read, { scenes, transcript, durationSec: duration }),
    };
    const exact = {};
    if (cutsSource === 'ffmpeg' && duration > 0 && shots.length) {
        const lengths = shots.map((s) => s.end - s.start);
        const cutTimes = shots.slice(1).map((s) => s.start);
        const perMin = (from, to) => {
            const span = Math.min(to, duration) - from;
            return span > 0 ? round((cutTimes.filter((t) => t >= from && t < to).length / span) * 60, 2) : null;
        };
        Object.assign(exact, {
            shotCountExact: shots.length,
            cutsPerMinExact: round((cutTimes.length / duration) * 60, 2),
            avgShotSecExact: round(duration / shots.length),
            medianShotSecExact: round(median(lengths)),
            longestShotSecExact: round(Math.max(...lengths)),
            firstCutSecExact: cutTimes.length ? round(cutTimes[0]) : null,
            cutsInFirst3sExact: cutTimes.filter((t) => t < 3).length,
            cutsPerMinFirst10sExact: perMin(0, 10),
            cutsPerMinAfter10sExact: duration > 15 ? perMin(10, duration) : null,
            shortShotShareExact: round(lengths.filter((l) => l < 1).length / lengths.length),
        });
    }
    const spoken = timeline.filter((r) => r.said);
    const withText = timeline.filter((r) => String(r.onScreenText).trim());
    const opening = timeline.filter((r) => r.start < 3);
    const silent = (Array.isArray(silences) ? silences : []).reduce((sum, s) => sum + Math.max(0, num(s?.end) - num(s?.start)), 0);
    const purposeEnd = (p) => {
        const hits = (Array.isArray(scenes) ? scenes : []).filter((s) => s?.purpose === p && Number.isFinite(s.endTime));
        return hits.length ? round(Math.max(...hits.map((s) => s.endTime))) : null;
    };
    const align = timeline.length ? {
        textShotShare: round(withText.length / timeline.length),
        textWhileSpeakingShare: spoken.length ? round(spoken.filter((r) => String(r.onScreenText).trim()).length / spoken.length) : null,
        wordsBeforeFirstCut: wordsOf(timeline[0].said).length,
        hookTextAndSpeech: opening.length ? opening.some((r) => String(r.onScreenText).trim()) && opening.some((r) => r.said) : null,
    } : {};
    return compact({
        ...base,
        ...exact,
        ...align,
        ...(cutsSource === 'ffmpeg' ? picture : {}),
        ...(cutsSource === 'ffmpeg' ? rhythm : {}),
        ...hook,
        silenceShare: hasAudio && duration > 0 ? round(Math.min(1, silent / duration)) : null,
        loudnessLufs: num(loudnessLufs) != null ? round(num(loudnessLufs), 1) : null,
        hookEndSec: purposeEnd('hook'),
        hasCta: Array.isArray(scenes) && scenes.length ? scenes.some((s) => s?.purpose === 'cta') : null,
        hasPayoff: Array.isArray(scenes) && scenes.length ? scenes.some((s) => s?.purpose === 'payoff') : null,
    });
};

/**
 * Timeline and features of a stored deep analysis (SocialVideoAnalysis), recomputed with a content read.
 * Used when a read arrives after the analysis (the daily job re-reads older analyses).
 */
export const recomputeAnalysis = (doc, read = doc?.contentRead ?? null) => {
    const media = doc?.media ?? {};
    const durationSec = num(media.durationSec);
    const scenes = doc?.scenes ?? [];
    const transcript = doc?.transcript ?? [];
    const shots = doc?.cutsSource === 'ffmpeg' ? shotsFromCuts(doc?.cuts ?? [], durationSec) : shotsFromScenes(scenes);
    const timeline = buildTimeline({ shots, scenes, transcript, read });
    const features = deepFeatures({
        durationSec, cutsSource: doc?.cutsSource ?? null, shots, scenes, transcript, timeline, silences: doc?.silences ?? [],
        loudnessLufs: media.loudnessLufs ?? null, hasAudio: media.hasAudio ?? null, picture: media.picture ?? {}, rhythm: media.rhythm ?? {},
        hook: doc?.hookVision ? hookFeatures(doc.hookVision) : {}, read,
    });
    if (Number.isFinite(doc?.features?.softCutCount)) features.softCutCount = doc.features.softCutCount;
    return { timeline, features };
};

/** Keys that come only from measuring the file (or its hook frames), never from Twelve Labs alone. */
const MEASURED_ONLY = /Exact$|^(textShotShare|textWhileSpeakingShare|wordsBeforeFirstCut|hookTextAndSpeech|silenceShare|loudnessLufs|brightness|brightnessFirst3s|saturation|motion|motionFirst3s|motionHookRatio|motionVariability|onsetRate|tempoBpm|cutsOnBeatShare|cutsOnBeatLift|hook[A-Z]\w*|softCutCount)$/;

/**
 * Measured features of a user's upload (Video.mediaMeasure, user-media.js) lined up with its Twelve Labs
 * scenes and transcript: the same measured keys public videos get. Empty when the upload was not measured.
 */
export const measuredVideoFeatures = (video, mediaMeasure = video?.mediaMeasure) => {
    const m = mediaMeasure;
    if (!m || !(m.durationSec > 0)) return {};
    const shots = shotsFromCuts(m.cuts ?? [], m.durationSec);
    const transcript = video.rawTranscript ?? [];
    const scenes = video.scenes ?? [];
    const read = video.contentRead ?? null;
    const all = deepFeatures({
        durationSec: m.durationSec, cutsSource: 'ffmpeg', shots, scenes, transcript,
        timeline: buildTimeline({ shots, scenes, transcript, read }), silences: m.silences ?? [], loudnessLufs: m.loudnessLufs,
        hasAudio: m.hasAudio, picture: m.picture ?? {}, rhythm: m.rhythm ?? {}, hook: m.hook ?? {}, read,
    });
    const out = Object.fromEntries(Object.entries(all).filter(([k]) => MEASURED_ONLY.test(k)));
    if (Number.isFinite(m.hardCuts)) out.softCutCount = Math.max(0, (m.cuts?.length ?? 0) - m.hardCuts);
    return out;
};

// ---- WebVTT captions (TikTok auto-captions from the provider)

const vttTime = (s) => {
    const m = String(s).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/);
    if (!m) return null;
    return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
};

/** WebVTT / SRT text -> [{ text, tStart, tEnd }]. Never throws. */
export const parseCaptions = (raw) => {
    const out = [];
    const blocks = String(raw ?? '').replace(/\r/g, '').split(/\n{2,}/);
    for (const block of blocks) {
        const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
        const k = lines.findIndex((l) => l.includes('-->'));
        if (k < 0) continue;
        const [a, b] = lines[k].split('-->').map((x) => x.trim().split(/\s+/)[0]);
        const tStart = vttTime(a);
        const tEnd = vttTime(b);
        const text = lines.slice(k + 1).join(' ').replace(/<[^>]+>/g, '').trim();
        if (tStart == null || !text) continue;
        out.push({ text: text.slice(0, 500), tStart: round(tStart), tEnd: round(tEnd != null && tEnd >= tStart ? tEnd : tStart) });
        if (out.length >= 500) break;
    }
    return out.sort((x, y) => x.tStart - y.tStart);
};

// ---- choosing which videos to analyze

/** Pairs need at least this gap: the hit did ~2x+ the miss (log ratio 0.69). */
export const MIN_PAIR_GAP = Math.log(2);
/**
 * Above 50x a creator's usual, a result is mostly luck (a lottery hit). Such videos are not used as a pair's
 * hit; a small share of picks studies them separately as role 'viral'. Training caps the label here too.
 */
export const OUTLIER_LOG = Math.log(50);
export const VIRAL_SHARE = 0.1;
const lnRatio = (views, baseline) => Math.log((views + 1) / (baseline + 1));

/**
 * Hit-and-miss pairs from the same creators: the clearest evidence of what the video itself did,
 * since creator, audience and account size are held fixed.
 *
 * groups: [{ creatorId, niche, baseline, analyzed (count so far), videos: [{ id, views, durationSec }] }]
 * nicheDone: { niche: pairs analyzed so far } — niches with the least evidence are served first.
 * The hit is the creator's best video below the outlier line (lottery hits are kept out of pairs), so each
 * later run naturally moves to the 2nd, 3rd ... best and worst. Up to VIRAL_SHARE of picks are outliers.
 * Returns [{ id, creatorId, role: 'hit'|'miss'|'viral', outperformance, niche }], at most `limit` items.
 */
export const pickPairs = (groups = [], { limit = 60, maxDurationSec = 180, nicheDone = {} } = {}) => {
    const candidates = [];
    const virals = [];
    for (const g of groups) {
        if (!Number.isFinite(g?.baseline) || g.baseline < 0) continue;
        const vids = (g.videos ?? []).filter((v) => Number.isFinite(v?.views) && (v.durationSec == null || v.durationSec <= maxDurationSec));
        const scored = vids.map((v) => ({ ...v, outperformance: lnRatio(v.views, g.baseline) })).sort((a, b) => b.outperformance - a.outperformance);
        const viral = scored.find((v) => v.outperformance > OUTLIER_LOG);
        if (viral) virals.push({ g, v: viral });
        const usable = scored.filter((v) => v.outperformance <= OUTLIER_LOG);
        if (usable.length < 2) continue;
        const hit = usable[0];
        const miss = usable.at(-1);
        if (hit.outperformance - miss.outperformance < MIN_PAIR_GAP) continue;
        candidates.push({ g, hit, miss });
    }
    candidates.sort((a, b) => (a.g.analyzed ?? 0) - (b.g.analyzed ?? 0) || (b.hit.outperformance - b.miss.outperformance) - (a.hit.outperformance - a.miss.outperformance));
    const byNiche = new Map();
    for (const c of candidates) {
        const key = c.g.niche ?? 'unknown';
        if (!byNiche.has(key)) byNiche.set(key, []);
        byNiche.get(key).push(c);
    }
    const out = [];
    const queues = [...byNiche.entries()].sort((a, b) => (nicheDone[a[0]] ?? 0) - (nicheDone[b[0]] ?? 0)).map(([, q]) => q);
    const viralSlots = Math.min(virals.length, Math.floor(limit * VIRAL_SHARE));
    const pairLimit = limit - viralSlots;
    while (out.length + 2 <= pairLimit && queues.some((q) => q.length)) {
        for (const q of queues) {
            if (out.length + 2 > pairLimit) break;
            const c = q.shift();
            if (!c) continue;
            for (const [v, role] of [[c.hit, 'hit'], [c.miss, 'miss']]) {
                out.push({ id: v.id, creatorId: c.g.creatorId, role, outperformance: round(v.outperformance), niche: c.g.niche ?? null });
            }
        }
    }
    virals.sort((a, b) => (a.g.analyzed ?? 0) - (b.g.analyzed ?? 0));
    for (const { g, v } of virals.slice(0, Math.min(viralSlots, limit - out.length))) {
        out.push({ id: v.id, creatorId: g.creatorId, role: 'viral', outperformance: round(v.outperformance), niche: g.niche ?? null });
    }
    return out;
};

// ---- what separates hits from misses

/** Two-sided sign-test p-value (exact binomial, p = 0.5). */
export const signTestP = (wins, n) => {
    if (!(n > 0)) return null;
    const k = Math.min(wins, n - wins);
    let logC = 0;
    let tail = 0;
    for (let i = 0; i <= k; i++) {
        if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
        tail += Math.exp(logC - n * Math.LN2);
    }
    return Math.min(1, 2 * tail);
};

const asNumber = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : num(v));

/** Spearman rank correlation of two equal-length arrays (average ranks for ties). */
export const spearman = (xs, ys) => {
    const n = xs.length;
    if (n < 3) return null;
    const rank = (arr) => {
        const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
        const r = new Array(n);
        for (let i = 0; i < n;) {
            let j = i;
            while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
            for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
            i = j + 1;
        }
        return r;
    };
    const rx = rank(xs);
    const ry = rank(ys);
    const mean = (n - 1) / 2;
    let sxy = 0; let sxx = 0; let syy = 0;
    for (let i = 0; i < n; i++) {
        sxy += (rx[i] - mean) * (ry[i] - mean);
        sxx += (rx[i] - mean) ** 2;
        syy += (ry[i] - mean) ** 2;
    }
    return sxx && syy ? round(sxy / Math.sqrt(sxx * syy)) : null;
};

/** Below this many creator pairs a factor is shown as early; from this many it is reported as a finding. */
export const RELIABLE_PAIRS = 30;
const MIN_PAIRS = 5;

/**
 * For every feature: across creators with an analyzed hit and miss, how often the hit had the higher
 * value (sign test), the typical value in hits vs misses, and the rank correlation with outperformance
 * over all analyzed videos. Sorted by how consistently the feature separates hits from misses.
 * rows: [{ creatorId, role, outperformance, features }]
 */
export const factorReport = (rows = []) => {
    const usable = rows.filter((r) => r?.features && Number.isFinite(r.outperformance));
    const keys = [...new Set(usable.flatMap((r) => Object.keys(r.features)))].filter((k) => usable.some((r) => asNumber(r.features[k]) != null));
    const byCreator = new Map();
    for (const r of usable) {
        const key = String(r.creatorId);
        if (!byCreator.has(key)) byCreator.set(key, { hit: [], miss: [] });
        if (r.role === 'hit' || r.role === 'miss') byCreator.get(key)[r.role].push(r);
    }
    const meanOf = (list, k) => {
        const vals = list.map((r) => asNumber(r.features[k])).filter((v) => v != null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    };
    const factors = keys.map((k) => {
        let wins = 0; let losses = 0;
        for (const { hit, miss } of byCreator.values()) {
            const h = meanOf(hit, k);
            const m = meanOf(miss, k);
            if (h == null || m == null || h === m) continue;
            if (h > m) wins += 1; else losses += 1;
        }
        const pairs = wins + losses;
        const all = usable.map((r) => [asNumber(r.features[k]), r.outperformance]).filter(([v]) => v != null);
        const hits = usable.filter((r) => r.role === 'hit').map((r) => asNumber(r.features[k])).filter((v) => v != null);
        const misses = usable.filter((r) => r.role === 'miss').map((r) => asNumber(r.features[k])).filter((v) => v != null);
        return {
            feature: k,
            pairs,
            hitHigherShare: pairs ? round(wins / pairs, 2) : null,
            p: pairs ? round(signTestP(wins, pairs), 4) : null,
            medianHit: round(median(hits)),
            medianMiss: round(median(misses)),
            correlation: spearman(all.map((a) => a[0]), all.map((a) => a[1])),
            videos: all.length,
            status: pairs >= RELIABLE_PAIRS ? 'reliable' : pairs >= MIN_PAIRS ? 'early' : 'too_few',
        };
    });
    factors.sort((a, b) => (b.status !== 'too_few') - (a.status !== 'too_few') || Math.abs((b.hitHigherShare ?? 0.5) - 0.5) - Math.abs((a.hitHigherShare ?? 0.5) - 0.5));
    return { creatorsWithPairs: [...byCreator.values()].filter((c) => c.hit.length && c.miss.length).length, videos: usable.length, factors };
};
