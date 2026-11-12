/**
 * Deterministic cut candidates for the video editor. Claude decides which to accept; it never has
 * to find frame-accurate cut points itself. Everything here is pure (no I/O) and unit-tested.
 *
 * Inputs use source seconds:
 *   words:    [{ w, start, end }]  word-level transcript, in order
 *   silences: [{ start, end }]     from ffmpeg silencedetect (may be empty)
 */

const FILLER_WORDS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'ahh', 'hmm', 'mm', 'mhm']);
const FILLER_PHRASES = [['you', 'know'], ['i', 'mean']];
/** "like"/"so"/"basically" are fillers only when the speaker pauses around them. */
const SOFT_FILLERS = new Set(['like', 'so', 'basically', 'actually', 'literally', 'okay', 'ok']);

const SOFT_FILLER_GAP = 0.18;
const PAD = 0.05;
const RETAKE_MIN_WORDS = 2;
const RETAKE_WINDOW_SEC = 8;
const RETAKE_MIN_GAP_SEC = 0.25;

export const norm = (w) => String(w || '').toLowerCase().replace(/[^a-z0-9']/g, '');

const round = (n) => Math.round(n * 1000) / 1000;

/** Word gaps longer than `min`, used when silencedetect found nothing (music under speech). */
export const gapsFromWords = (words, min) => {
    const gaps = [];
    for (let i = 1; i < words.length; i += 1) {
        const start = words[i - 1].end;
        const end = words[i].start;
        if (end - start >= min) gaps.push({ start, end });
    }
    return gaps;
};

/**
 * Find a retake: the speaker starts a phrase, stops, and starts it again. The first attempt (from its
 * first word up to the restart) is the candidate. Requires at least RETAKE_MIN_WORDS matching words
 * and a pause before the restart, so ordinary repetition ("very very") is left alone.
 */
const findRetakes = (words) => {
    const out = [];
    const n = words.map((x) => norm(x.w));
    let i = 0;
    while (i < words.length) {
        let found = null;
        for (let j = i + RETAKE_MIN_WORDS; j < words.length && words[j].start - words[i].start <= RETAKE_WINDOW_SEC; j += 1) {
            let k = 0;
            while (j + k < words.length && i + k < j && n[i + k] && n[i + k] === n[j + k]) k += 1;
            const pause = words[j].start - words[j - 1].end;
            if (k >= RETAKE_MIN_WORDS && pause >= RETAKE_MIN_GAP_SEC) {
                found = j;
                break;
            }
        }
        if (found != null) {
            out.push({ start: words[i].start, end: words[found].start, wordIdx: range(i, found) });
            i = found;
        } else {
            i += 1;
        }
    }
    return out;
};

const range = (a, b) => Array.from({ length: b - a }, (_, k) => a + k);

/**
 * @returns {Array<{id:string, kind:'dead_start'|'dead_end'|'silence'|'filler'|'retake', start:number, end:number, text?:string, wordIdx?:number[]}>}
 */
export function buildCutCandidates({ words = [], silences = [], durationSec, minSilence = 0.35 } = {}) {
    const duration = Number(durationSec) || 0;
    const list = [];
    const add = (c) => {
        const start = Math.max(0, round(c.start));
        const end = Math.min(duration || Infinity, round(c.end));
        if (end - start >= 0.12) list.push({ ...c, start, end });
    };

    if (words.length === 0) {
        if (duration > 0) for (const s of silences) if (s.end - s.start >= minSilence) add({ kind: 'silence', start: s.start + PAD, end: s.end - PAD });
        return withIds(list);
    }

    const first = words[0];
    const last = words[words.length - 1];
    if (first.start > 0.5) add({ kind: 'dead_start', start: 0, end: first.start - 0.1 });
    if (duration && duration - last.end > 0.6) add({ kind: 'dead_end', start: last.end + 0.25, end: duration });

    // Pauses inside speech. Prefer silencedetect; fall back to word gaps.
    const pauses = (silences.length ? silences : gapsFromWords(words, minSilence))
        .filter((s) => s.end - s.start >= minSilence && s.start >= first.start && s.end <= last.end);
    for (const s of pauses) add({ kind: 'silence', start: s.start + PAD, end: s.end - PAD });

    // Filler words and phrases.
    const n = words.map((x) => norm(x.w));
    for (let i = 0; i < words.length; i += 1) {
        const before = i > 0 ? words[i].start - words[i - 1].end : Infinity;
        const after = i < words.length - 1 ? words[i + 1].start - words[i].end : Infinity;
        if (FILLER_WORDS.has(n[i]) || (SOFT_FILLERS.has(n[i]) && before >= SOFT_FILLER_GAP && after >= SOFT_FILLER_GAP)) {
            add({ kind: 'filler', start: words[i].start - 0.02, end: words[i].end + 0.02, text: words[i].w, wordIdx: [i] });
            continue;
        }
        for (const phrase of FILLER_PHRASES) {
            if (phrase.every((p, k) => n[i + k] === p) && before >= SOFT_FILLER_GAP) {
                const endIdx = i + phrase.length - 1;
                add({ kind: 'filler', start: words[i].start - 0.02, end: words[endIdx].end + 0.02, text: words.slice(i, endIdx + 1).map((x) => x.w).join(' '), wordIdx: range(i, endIdx + 1) });
            }
        }
    }

    for (const r of findRetakes(words)) {
        add({ kind: 'retake', start: r.start, end: r.end, text: r.wordIdx.map((k) => words[k].w).join(' '), wordIdx: r.wordIdx });
    }

    return withIds(list.sort((a, b) => a.start - b.start || a.end - b.end));
}

const withIds = (list) => list.map((c, k) => ({ id: `c${k + 1}`, ...c }));

/** Seconds removed if every candidate were accepted (overlaps counted once). */
export function candidateSeconds(candidates) {
    const sorted = [...candidates].sort((a, b) => a.start - b.start);
    let total = 0;
    let curStart = null;
    let curEnd = null;
    for (const c of sorted) {
        if (curEnd == null || c.start > curEnd) {
            if (curEnd != null) total += curEnd - curStart;
            curStart = c.start;
            curEnd = c.end;
        } else {
            curEnd = Math.max(curEnd, c.end);
        }
    }
    if (curEnd != null) total += curEnd - curStart;
    return round(total);
}
