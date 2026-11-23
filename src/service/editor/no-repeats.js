/**
 * The last guard before an edit plays: nothing is heard twice.
 *
 * Plans can repeat speech in three ways:
 *   1. the same footage twice: two pieces whose source ranges overlap (segments that touch, then each
 *      snapped outward to the same word);
 *   2. a retake: the creator said a line, then said it again (raw takes are full of these, sometimes a
 *      minute apart), and the plan kept both;
 *   3. a moved line: the hook was pulled to the front and the body still contains it where it was said.
 * This pass finds each case on the output timeline and removes one copy, so the viewer never hears a
 * line again. Pure; run on the snapped pieces, in play order.
 */
import { norm } from './cut-candidates.js';
import { snapPiece, MIN_PIECE_SEC } from './timing.js';

/** Runs shorter than this are ordinary repetition ("no, no", "and then"). */
export const MIN_REPEAT_WORDS = 4;
/** A 4-word repeat counts only when the second copy starts after a pause (a restart). From 5 words, always. */
const SURE_REPEAT_WORDS = 5;
const RESTART_PAUSE_SEC = 0.25;
/** Retakes this close together: everything from the first attempt up to the restart goes. */
const RESTART_WINDOW_SEC = 15;
const EDGE = 0.02;
const SLIVER_SEC = 0.6;

const r3 = (n) => Math.round(n * 1000) / 1000;

/** Kept words in play order: words whose middle lies inside a piece. */
const keptWords = (pieces, words) => {
    const out = [];
    pieces.forEach((p, pi) => {
        words.forEach((w, wi) => {
            const mid = (w.start + w.end) / 2;
            if (mid >= p.start && mid < p.end) out.push({ wi, pi, start: w.start, end: w.end, n: norm(w.w) });
        });
    });
    return out;
};

/** Remove [a, b] (source seconds) from piece `pi` only. New edges snap to word boundaries but never back into [a, b]. */
const cutFromPiece = (pieces, pi, a, b, media) => {
    const p = pieces[pi];
    const parts = [];
    if (a - p.start >= MIN_PIECE_SEC) parts.push({ ...p, end: r3(Math.min(snapPiece({ ...p, end: a }, media).end, a + EDGE)) });
    if (p.end - b >= MIN_PIECE_SEC) parts.push({ ...p, start: r3(Math.max(snapPiece({ ...p, start: b }, media).start, b - EDGE)) });
    return [...pieces.slice(0, pi), ...parts.filter((x) => x.end - x.start >= MIN_PIECE_SEC), ...pieces.slice(pi + 1)];
};

/** Trim later-played pieces so no source moment plays twice. */
const removeSourceOverlaps = (pieces, removed) => {
    let out = [...pieces];
    for (let j = 1; j < out.length; j += 1) {
        for (let i = 0; i < j; i += 1) {
            const a = out[i];
            const b = out[j];
            if (!b || b.start >= a.end - 0.005 || b.end <= a.start + 0.005) continue;
            // b replays part of a: keep only what b adds before or after a.
            const keep = [];
            if (a.start - b.start >= MIN_PIECE_SEC) keep.push({ ...b, end: a.start });
            if (b.end - a.end >= MIN_PIECE_SEC) keep.push({ ...b, start: a.end });
            removed.push({ reason: 'same_footage', start: r3(Math.max(a.start, b.start)), end: r3(Math.min(a.end, b.end)) });
            out = [...out.slice(0, j), ...keep, ...out.slice(j + 1)];
            j = Math.max(0, j - 1);
            break;
        }
    }
    return out;
};

/** The first repeated run of words, or null: { a, b, len } as indexes into the kept-word list (a plays first). */
const findRepeat = (kept, words) => {
    const n = kept.length;
    for (let a = 0; a < n; a += 1) {
        if (!kept[a].n) continue;
        for (let b = a + 1; b < n; b += 1) {
            if (kept[b].n !== kept[a].n) continue;
            let len = 0;
            while (b + len < n && a + len < b && kept[a + len].n && kept[a + len].n === kept[b + len].n) len += 1;
            if (len < MIN_REPEAT_WORDS) continue;
            const prev = words[kept[b].wi - 1];
            const pauseBefore = prev ? kept[b].start - prev.end : Infinity;
            if (len >= SURE_REPEAT_WORDS || pauseBefore >= RESTART_PAUSE_SEC) return { a, b, len };
        }
    }
    return null;
};

/**
 * @param {Array<{id,segId,start,end}>} pieces snapped pieces in play order
 * @param {{words:Array<{w,start,end}>, silences?:Array, durationSec?:number}} media
 * @param {{roles?: Record<string,string>}} [opts] segment id -> role ('hook' copies are the ones kept)
 * @returns {{pieces: Array, removed: Array<{reason:string,start:number,end:number,text?:string}>}}
 */
export function removeRepeats(pieces, media, { roles = {} } = {}) {
    const words = media?.words ?? [];
    const removed = [];
    let out = removeSourceOverlaps(pieces, removed);
    for (let pass = 0; pass < 40; pass += 1) {
        const kept = keptWords(out, words);
        const rep = findRepeat(kept, words);
        if (!rep) break;
        const first = kept.slice(rep.a, rep.a + rep.len);
        const second = kept.slice(rep.b, rep.b + rep.len);
        const firstHook = roles[out[first[0].pi].segId] === 'hook';
        const secondHook = roles[out[second[0].pi].segId] === 'hook';
        // Keep the hook's copy; otherwise keep the take said last (a creator's final take is the one they meant).
        const dropFirst = secondHook ? true : firstHook ? false : first[0].start < second[0].start;
        const drop = dropFirst ? first : second;
        const keep = dropFirst ? second : first;
        // The dropped copy may span pieces: cut its words out of each piece it is in (last piece first,
        // so indexes stay valid).
        const byPiece = new Map();
        for (const w of drop) {
            const r = byPiece.get(w.pi) ?? { a: w.start, b: w.end };
            byPiece.set(w.pi, { a: Math.min(r.a, w.start), b: Math.max(r.b, w.end) });
        }
        // A restart: the abandoned attempt runs from its first word up to the restart; all of it goes.
        if (dropFirst && keep[0].pi === drop[0].pi && keep[0].start > drop[0].start && keep[0].start - drop[0].start <= RESTART_WINDOW_SEC) {
            const r = byPiece.get(drop[0].pi);
            byPiece.set(drop[0].pi, { a: r.a, b: Math.max(r.b, keep[0].start - 0.01) });
        }
        removed.push({ reason: dropFirst && keep[0].start > drop[0].start ? 'retake' : 'repeated_line', start: r3(drop[0].start), end: r3(drop[drop.length - 1].end), text: drop.map((w) => words[w.wi].w).join(' ') });
        const before = JSON.stringify(out);
        for (const [pi, r] of [...byPiece.entries()].sort((x, y) => y[0] - x[0])) {
            const piece = out[pi];
            out = cutFromPiece(out, pi, Math.max(piece.start, r.a - EDGE), Math.min(piece.end, r.b + EDGE), media);
        }
        if (JSON.stringify(out) === before) break; // nothing could be cut: stop rather than loop
        out = removeSourceOverlaps(out, removed);
    }
    // Slivers: a piece with no word in it, shorter than this, is leftover silence between two cuts and
    // plays as a stutter. (Only when the video has speech at all.)
    if (words.length) {
        out = out.filter((p) => p.end - p.start >= SLIVER_SEC || words.some((w) => (w.start + w.end) / 2 >= p.start && (w.start + w.end) / 2 < p.end));
    }
    // Ids stay unique after splits.
    const seen = new Map();
    out = out.map((p) => {
        const k = (seen.get(p.id) ?? 0) + 1;
        seen.set(p.id, k);
        return k > 1 ? { ...p, id: `${p.id}~${k}` } : p;
    });
    return { pieces: out, removed };
}
