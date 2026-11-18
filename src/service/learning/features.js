/**
 * The shared description of a video (docs/learning-engine/PLAN.md, section 5.2). Pure functions.
 *
 * One extractor per source, all producing the same flat keys, so a user's upload, an admin viral example
 * and a collected public video can be compared and trained on together. Numbers come from stored data
 * (scenes, transcript timings, scores); AI labels (niche, format, hook) live outside `features`.
 *
 * Bump FEATURE_VERSION whenever a feature's meaning or computation changes. The trainer only mixes rows
 * with the same version, and the daily job re-extracts older rows.
 */
import { contentSignals } from '../view-signals.js';
import { formatFromStrategy, hookFromStrategy } from '../../constants/taxonomy.js';

export const FEATURE_VERSION = 1;

const MUSIC = /\bmusic\b|\bsong\b|\bbeat\b|\bsoundtrack\b|\binstrumental\b|\bmelody\b/i;
const TO_CAMERA = /(talk|speak)(s|ing)? (directly )?(to|into) (the )?camera|address(es|ing) the (camera|viewer)|close[- ]up of (a |the |his |her )?(face|person|man|woman)|looks? (directly )?(at|into) the camera/i;
const ZOOM = /\bzoom(s|ed|ing)?( in| out)?\b|punch[- ]in/i;

const num = (x) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : null);
const round = (x, places = 3) => (x == null ? null : Math.round(x * 10 ** places) / 10 ** places);
const share = (items, test) => (items.length ? items.filter(test).length / items.length : null);
const words = (text) => String(text ?? '').trim().split(/\s+/).filter(Boolean).length;
const hashtagsIn = (text) => (String(text ?? '').match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.slice(1).toLowerCase());

/** Drop null / non-finite numbers so missing stays missing (the model treats it as unknown). */
const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && !(typeof v === 'number' && !Number.isFinite(v))));

/** Cut speed, text, music, zooms and opening from timed scenes. */
export const sceneFeatures = (scenes = [], durationSec = null) => {
    const timed = (Array.isArray(scenes) ? scenes : [])
        .filter((s) => Number.isFinite(s?.startTime) && Number.isFinite(s?.endTime) && s.endTime > s.startTime)
        .sort((a, b) => a.startTime - b.startTime);
    if (!timed.length) return {};
    const span = timed.at(-1).endTime - timed[0].startTime;
    const duration = num(durationSec) > 0 ? num(durationSec) : span;
    const lengths = timed.map((s) => s.endTime - s.startTime);
    const opening = timed.filter((s) => s.startTime < 2);
    return compact({
        sceneCount: timed.length,
        avgShotSec: timed.length >= 3 && duration > 0 ? round(duration / timed.length) : null,
        longestShotSec: round(Math.max(...lengths)),
        cutsPerMin: timed.length >= 3 && duration > 0 ? round(((timed.length - 1) / duration) * 60) : null,
        firstCutSec: timed.length >= 2 ? round(timed[0].endTime - timed[0].startTime) : null,
        onScreenTextShare: round(share(timed, (s) => String(s.onScreenText ?? '').trim().length > 0)),
        textInFirst2s: opening.length ? opening.some((s) => String(s.onScreenText ?? '').trim().length > 0) : null,
        musicShare: round(share(timed, (s) => MUSIC.test(String(s.audioSummary ?? '')))),
        zoomShare: round(share(timed, (s) => ZOOM.test(`${s.visualDescription ?? ''} ${s.primaryAction ?? ''}`))),
        toCameraOpening: opening.length ? opening.some((s) => TO_CAMERA.test(`${s.visualDescription ?? ''} ${s.primaryAction ?? ''}`)) : null,
    });
};

/** Stored segments are { text, tStart, tEnd }; Twelve Labs returns { value, start, end }. Accept both. */
const toSegment = (s) => ({ start: num(s?.tStart ?? s?.start), end: num(s?.tEnd ?? s?.end), value: String(s?.text ?? s?.value ?? '') });

/** Speech speed, coverage and how soon someone speaks, from timed transcript segments. */
export const transcriptFeatures = (segments = [], durationSec = null) => {
    const timed = (Array.isArray(segments) ? segments : [])
        .map(toSegment)
        .filter((s) => s.start != null && s.end != null && s.end > s.start && s.value.trim())
        .sort((a, b) => a.start - b.start);
    const duration = num(durationSec);
    if (!timed.length) return duration > 0 ? { speechCoverage: 0 } : {};
    const spoken = timed.reduce((sum, s) => sum + (s.end - s.start), 0);
    const totalWords = timed.reduce((sum, s) => sum + words(s.value), 0);
    return compact({
        firstSpeechSec: round(timed[0].start),
        speechWpm: duration > 0 ? round((totalWords / duration) * 60, 1) : null,
        speechCoverage: duration > 0 ? round(Math.min(1, spoken / duration)) : null,
        openingWords: words(timed.filter((s) => s.start < 3).map((s) => s.value).join(' ')),
    });
};

const scoreOf = (analysis, name) => {
    const entry = (Array.isArray(analysis) ? analysis : []).find((a) => a?.feature === name);
    return num(entry?.score);
};

const postTiming = (postedAt) => {
    const d = postedAt ? new Date(postedAt) : null;
    if (!d || !Number.isFinite(d.getTime())) return {};
    return { postHourUtc: d.getUTCHours(), postWeekdayUtc: d.getUTCDay() };
};

const captionFeatures = (caption) => {
    if (caption == null || caption === '') return {};
    const text = String(caption);
    return { captionChars: text.length, hashtagCount: hashtagsIn(text).length };
};

/** A user's analyzed upload (Video document or lean object). */
export const featuresFromVideo = (video) => {
    const duration = num(video?.duration);
    const signals = contentSignals(video);
    return compact({
        durationSec: duration != null ? round(duration, 1) : null,
        ...sceneFeatures(video?.scenes, duration),
        ...transcriptFeatures(video?.rawTranscript, duration),
        sfxShare: round(signals.sfxShare),
        framingIssues: Array.isArray(video?.scenes) && video.scenes.length ? signals.framingIssues : null,
        hookScore: scoreOf(video?.analysis, 'hook'),
        pacingScore: scoreOf(video?.analysis, 'pacing'),
        audioScore: scoreOf(video?.analysis, 'audio'),
        captionScore: scoreOf(video?.analysis, 'caption'),
        viralityScore: num(video?.viralityScore),
        ...captionFeatures(video?.sourceDescription),
        ...postTiming(video?.postedAt),
        strategyFormat: formatFromStrategy(video?.contentProfile?.format),
        strategyHook: hookFromStrategy(video?.contentProfile?.hookType),
    });
};

const PRESENCE = { none: 0, low: 0.33, light: 0.33, some: 0.5, medium: 0.66, moderate: 0.66, high: 1, heavy: 1 };
const presence = (value) => {
    const key = String(value ?? '').toLowerCase().trim().split(/\s+/)[0];
    return Object.hasOwn(PRESENCE, key) ? PRESENCE[key] : null;
};

/** An admin-ingested viral example (VideoPerformanceDataset). editProfile values win where both exist. */
export const featuresFromDataset = (doc) => {
    const p = doc?.editProfile ?? {};
    const duration = num(p.durationSec) ?? num(doc?.durationSeconds);
    const fromScenes = sceneFeatures(doc?.scenes, duration);
    const signals = contentSignals({ scenes: doc?.scenes, duration, analysis: doc?.analysis });
    return compact({
        durationSec: duration != null ? round(duration, 1) : null,
        ...fromScenes,
        avgShotSec: num(p.avgShotSec) ?? fromScenes.avgShotSec,
        cutsPerMin: num(p.cutsPerMin) ?? fromScenes.cutsPerMin,
        speechWpm: num(p.speechWpm),
        pauseRatio: num(p.pauseRatio),
        zoomsPerMin: num(p.zoomsPerMin),
        musicLevel: presence(p.musicPresence),
        sfxLevel: presence(p.sfxUse),
        captionDensityLevel: presence(p.captionDensity),
        sfxShare: round(signals.sfxShare),
        hookScore: num(doc?.hookScore),
        pacingScore: num(doc?.pacingScore),
        audioScore: num(doc?.audioScore),
        captionScore: num(doc?.captionScore),
        viralityScore: num(doc?.viralityScore),
        ...postTiming(doc?.postedAt),
    });
};

/** A collected public video before deep analysis: only what the provider gives. */
export const featuresFromSocial = (doc) => compact({
    durationSec: num(doc?.durationSec),
    ...captionFeatures(doc?.caption),
    hashtagCount: Array.isArray(doc?.hashtags) && doc.hashtags.length ? doc.hashtags.length : captionFeatures(doc?.caption).hashtagCount ?? null,
    originalSound: doc?.soundTitle ? /original sound|son original|sonido original|som original/i.test(doc.soundTitle) : null,
    ...postTiming(doc?.postedAt),
});

export const extractHashtags = hashtagsIn;
