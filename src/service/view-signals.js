/**
 * What in the edit itself moves views up or down, read from the stored analysis.
 *
 * Short-form reach is driven by early retention: fast cuts, sound design and a clear hook keep people
 * watching; slow shots, framing problems and unclear content lose them in the first seconds. The overall
 * virality score already blends these, but it compresses them; this "edit energy" factor makes the
 * difference between a punchy edit and a flat one show up clearly in the predicted views.
 *
 * Inputs (all optional; missing ones count as neutral):
 *   - feature scores 0-100 from video.analysis: pacing, audio, hook, caption
 *   - video.scenes: average scene length (a proxy for cut speed), scenes whose audio mentions sound
 *     effects, and scenes whose visuals mention framing problems (off-center, cut off, out of frame)
 */

const SFX = /sound effects?|\bsfx\b|whoosh|swoosh|\bding\b|\bpop(s|ping)?\b|\bboom\b|riser|swipe sound|click sound|transition sound|impact sound|record scratch|cash register|bell sound/i;
const FRAMING = /off[- ]?cent(er|re)d?|not cent(er|re)d|uncent(er|re)d|partially (out of|outside the) frame|out of frame|cut off at the|awkward(ly)? framed|poor(ly)? framed|bad framing|tilted (frame|camera)|shaky (camera|footage)/i;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

const featureScore = (analysis, name) => {
    const entry = (Array.isArray(analysis) ? analysis : []).find((a) => a?.feature === name);
    const n = Number(entry?.score);
    return Number.isFinite(n) ? clamp(n, 0, 100) : null;
};

/** Signals for a stored video (or any object with analysis / scenes / duration). */
export const contentSignals = (video) => {
    const scenes = Array.isArray(video?.scenes) ? video.scenes : [];
    const timed = scenes.filter((s) => Number.isFinite(s?.startTime) && Number.isFinite(s?.endTime) && s.endTime > s.startTime);
    const span = timed.length ? Math.max(...timed.map((s) => s.endTime)) - Math.min(...timed.map((s) => s.startTime)) : 0;
    const duration = Number(video?.duration) > 0 ? Number(video.duration) : span;
    return {
        pacing: featureScore(video?.analysis, 'pacing'),
        audio: featureScore(video?.analysis, 'audio'),
        hook: featureScore(video?.analysis, 'hook'),
        caption: featureScore(video?.analysis, 'caption'),
        // Average scene length only when there are enough scenes to say anything.
        avgSceneSec: timed.length >= 3 && duration > 0 ? duration / timed.length : null,
        sfxShare: scenes.length >= 2 ? scenes.filter((s) => SFX.test(String(s?.audioSummary ?? ''))).length / scenes.length : null,
        framingIssues: scenes.filter((s) => FRAMING.test(`${s?.visualDescription ?? ''} ${s?.primaryAction ?? ''}`)).length,
    };
};

const centred = (score) => (score == null ? 0 : (score - 60) / 20);

/**
 * Multiplier on predicted views from the edit (about 0.45x to 2.2x), with the reasons for it.
 * `boosts` / `drags` are short phrases for the report ("fast cuts", "slow cuts").
 */
export const editEnergy = (signals = {}) => {
    const boosts = [];
    const drags = [];
    let z = 0.45 * centred(signals.pacing) + 0.25 * centred(signals.audio) + 0.2 * centred(signals.hook) + 0.1 * centred(signals.caption);

    if (signals.pacing != null && signals.pacing >= 72) boosts.push('tight pacing');
    if (signals.pacing != null && signals.pacing < 45) drags.push('slow pacing');
    if (signals.hook != null && signals.hook < 45) drags.push('weak hook');
    if (signals.caption != null && signals.caption < 40) drags.push('hard to follow');

    const shot = signals.avgSceneSec;
    if (shot != null) {
        if (shot <= 2) { z += 0.6; boosts.push('fast cuts'); }
        else if (shot <= 3) { z += 0.3; boosts.push('quick cuts'); }
        else if (shot >= 7) { z -= 0.6; drags.push('slow cuts'); }
        else if (shot >= 5) { z -= 0.3; drags.push('long shots'); }
    }
    if (signals.sfxShare != null) {
        if (signals.sfxShare >= 0.3) { z += 0.4; boosts.push('sound effects'); }
        else if (signals.sfxShare >= 0.15) { z += 0.2; boosts.push('some sound effects'); }
    }
    if (signals.framingIssues > 0) {
        z -= Math.min(0.6, 0.3 * signals.framingIssues);
        drags.push('off-center framing');
    }

    const multiplier = Math.exp(0.32 * clamp(z, -2.5, 2.5));
    return { multiplier: Math.round(multiplier * 1000) / 1000, boosts, drags };
};
