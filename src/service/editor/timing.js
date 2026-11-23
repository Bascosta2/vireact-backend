/**
 * Turns an edit plan's keep-segments (source seconds) into a frame-exact output timeline, and maps
 * words, zooms, overlays and sound effects onto it. Pure functions, no I/O.
 *
 * Claude chooses *what* to keep; this module decides the exact frames: cut edges snap to word
 * boundaries or pauses so a cut never clips a syllable.
 */

export const FPS = 30;
export const MIN_PIECE_SEC = 0.15;
export const SNAP_TOLERANCE_SEC = 0.15;
const LEAD_PAD = 0.06;
const EDGE_EPS = 0.01;
/** Transcripts end words early and phrase-final consonants are quiet: keep a little more after a word. */
const TAIL_PAD = 0.12;

const round = (n) => Math.round(n * 1000) / 1000;

const nearest = (t, options, tol) => {
    let best = null;
    let bestDist = tol;
    for (const o of options) {
        const d = Math.abs(o - t);
        if (d <= bestDist) {
            best = o;
            bestDist = d;
        }
    }
    return best;
};

/**
 * Snap a piece's edges: a start moves to just before the nearest word start (or the end of a pause),
 * an end to just after the nearest word end (or the start of a pause).
 */
export function snapPiece(piece, { words = [], silences = [], durationSec }, tol = SNAP_TOLERANCE_SEC) {
    // Padded edges never reach into the neighbouring word.
    const startAt = (i) => Math.max(words[i].start - LEAD_PAD, i > 0 ? words[i - 1].end + 0.01 : -Infinity);
    const endAt = (i) => Math.min(words[i].end + TAIL_PAD, i < words.length - 1 ? words[i + 1].start - 0.01 : Infinity);
    // Inside a word by more than a hair: transcript times carry float noise (34.880001 vs a cut at 34.88).
    const inside = (t) => words.findIndex((w) => t > w.start + EDGE_EPS && t < w.end - EDGE_EPS);

    const snapStart = (t) => {
        const i = inside(t);
        // A start inside a word always keeps the whole word: a clipped or missing word is the worst
        // cut there is, and transcript timings are too rough to tell which half the speaker meant.
        if (i >= 0) return startAt(i);
        const options = [...words.map((_, k) => startAt(k)), ...silences.map((s) => s.end - LEAD_PAD)];
        return nearest(t, options, tol) ?? t;
    };
    const snapEnd = (t) => {
        const i = inside(t);
        if (i >= 0) return endAt(i);
        const options = [...words.map((_, k) => endAt(k)), ...silences.map((s) => s.start + TAIL_PAD)];
        return nearest(t, options, tol) ?? t;
    };

    const max = Number(durationSec) || Infinity;
    return { ...piece, start: round(Math.max(0, snapStart(piece.start))), end: round(Math.min(max, snapEnd(piece.end))) };
}

/** Remove `cuts` (ranges) from a segment; returns the remaining pieces in order. */
export function subtractRanges(segment, cuts) {
    let pieces = [{ start: segment.start, end: segment.end }];
    for (const c of [...cuts].sort((a, b) => a.start - b.start)) {
        const next = [];
        for (const p of pieces) {
            if (c.end <= p.start || c.start >= p.end) {
                next.push(p);
                continue;
            }
            if (c.start > p.start) next.push({ start: p.start, end: c.start });
            if (c.end < p.end) next.push({ start: c.end, end: p.end });
        }
        pieces = next;
    }
    return pieces;
}

/**
 * Ordered keep-segments minus accepted cut candidates, snapped. Each piece keeps its segment id.
 * @param {Array<{id:string,start:number,end:number}>} segments ordered as they should play
 * @param {Array<{start:number,end:number}>} cuts accepted candidates
 */
export function buildPieces(segments, cuts, media) {
    const out = [];
    for (const seg of segments) {
        const parts = subtractRanges(seg, cuts)
            .map((p) => snapPiece(p, media))
            .filter((p) => p.end - p.start >= MIN_PIECE_SEC);
        parts.forEach((p, k) => out.push({ id: parts.length > 1 ? `${seg.id}.${k + 1}` : seg.id, segId: seg.id, start: p.start, end: p.end }));
    }
    return out;
}

/**
 * Frame-exact output timeline. Durations are rounded to whole frames per piece so the sum never
 * drifts from what the renderer plays.
 */
export function buildTimeline(pieces, fps = FPS) {
    let outFrame = 0;
    const timeline = pieces.map((p) => {
        const srcStartFrame = Math.round(p.start * fps);
        const durationFrames = Math.max(1, Math.round((p.end - p.start) * fps));
        const item = {
            id: p.id,
            segId: p.segId,
            srcStart: p.start,
            srcEnd: p.end,
            srcStartFrame,
            durationFrames,
            outStartFrame: outFrame,
            outStart: round(outFrame / fps),
            outEnd: round((outFrame + durationFrames) / fps),
        };
        outFrame += durationFrames;
        return item;
    });
    return { fps, timeline, durationFrames: outFrame, durationSec: round(outFrame / fps) };
}

/** Output time for a source time, or null when that moment was cut. */
export function srcToOut(t, timeline) {
    for (const p of timeline) {
        if (t >= p.srcStart && t < p.srcEnd) return round(p.outStart + (t - p.srcStart));
    }
    return null;
}

const pieceAt = (t, timeline) => timeline.find((p) => t >= p.srcStart && t < p.srcEnd) || null;

const pageChars = (page) => page.reduce((n, w) => n + w.text.length, 0) + page.length - 1;

/**
 * Split a run of words that belong together into pages of 2-3 words that each fit on one line.
 * Of all the ways to split the run it picks the one with the fewest single-word pages, then the
 * fewest pages, then the most even widths (4 words → 2 + 2, 7 → 3 + 2 + 2). A word is left on
 * its own only when it cannot share a line with either neighbour.
 */
function splitRun(run, maxWords, maxChars) {
    const n = run.length;
    if (n <= 1) return [run];
    const ALONE = 10; // a single-word page costs more than any number of extra pages it could save
    // best[i]: the cheapest way to split words i..n-1, and the size of its first page.
    const best = new Array(n + 1).fill(null);
    best[n] = { cost: 0, size: 0 };
    for (let i = n - 1; i >= 0; i -= 1) {
        // Larger pages are tried first, so ties go to the split that starts with the fuller page.
        for (let size = Math.min(maxWords, n - i); size >= 1; size -= 1) {
            const chars = pageChars(run.slice(i, i + size));
            if (size > 1 && chars > maxChars) continue;
            const cost = best[i + size].cost + 1 + (size === 1 ? ALONE : 0) + chars * chars * 0.001;
            if (!best[i] || cost < best[i].cost - 1e-9) best[i] = { cost, size };
        }
    }
    const pages = [];
    for (let i = 0; i < n; i += best[i].size) pages.push(run.slice(i, i + best[i].size));
    return pages;
}

/**
 * Word-level captions on the output timeline, grouped into short pages (2-3 words, one line) that
 * break on sentence ends, long pauses and cuts.
 * @param {Array<{w:string,start:number,end:number}>} words
 * @param {{emphasis?:Set<number>, textOverrides?:Record<string,string>, maxWords?:number, maxChars?:number}} opts
 */
/**
 * `hold: false` (editing skills) never holds a line into the pause before the next one: a line runs from
 * its first word's start to its last word's end, that end capped at `capWordSec` after the word starts,
 * plus `tailSec`. `transform` rewrites each word's text (casual case). Words with no letter or digit
 * (stray punctuation from the transcript) are dropped.
 */
export function captionPages(words, timeline, { emphasis = new Set(), textOverrides = {}, maxWords = 3, maxChars = 16, maxGap = 0.6, hold = true, capWordSec = null, tailSec = 0, transform = null } = {}) {
    const placed = [];
    words.forEach((w, i) => {
        const mid = (w.start + w.end) / 2;
        const piece = pieceAt(mid, timeline);
        if (!piece) return;
        const s = Math.max(w.start, piece.srcStart);
        const e = Math.min(w.end, piece.srcEnd);
        const override = textOverrides[i];
        const base = String(override ?? w.w).trim();
        const text = override == null && transform ? transform(base) : base;
        if (!text || !/[\p{L}\p{N}]/u.test(text)) return;
        placed.push({
            i,
            text,
            start: round(piece.outStart + (s - piece.srcStart)),
            end: round(piece.outStart + (e - piece.srcStart)),
            emphasis: emphasis.has(i),
            pieceId: piece.id,
        });
    });
    placed.sort((a, b) => a.start - b.start);

    // Runs: words with no pause, cut or sentence end between them.
    const runs = [];
    for (const w of placed) {
        const run = runs[runs.length - 1];
        const prev = run?.[run.length - 1];
        const breakHere = !prev
            || w.start - prev.end > maxGap
            || (prev.pieceId !== w.pieceId && w.start - prev.end > 0.05)
            || /[.!?]$/.test(prev.text)
            // A comma ends the page unless that would leave one word on its own.
            || (/[,;:]$/.test(prev.text) && run.length >= 2);
        if (breakHere) runs.push([w]);
        else run.push(w);
    }
    const pages = runs.flatMap((run) => splitRun(run, maxWords, maxChars)).map((pageWords) => ({ words: pageWords }));
    return pages.map((p, k) => {
        const start = p.words[0].start;
        const last = p.words[p.words.length - 1];
        const lastEnd = last.end;
        const nextStart = pages[k + 1]?.words[0].start;
        let end;
        if (hold) {
            // Hold the page until the next one if the gap is short, so captions don't flicker.
            end = nextStart != null && nextStart - lastEnd < 0.3 ? nextStart : lastEnd;
        } else {
            end = (capWordSec != null ? Math.min(lastEnd, last.start + capWordSec) : lastEnd) + tailSec;
            if (nextStart != null) end = Math.min(end, nextStart);
            end = Math.max(end, start + 0.05);
        }
        return { start, end: round(end), words: p.words.map(({ pieceId, ...w }) => w) };
    });
}

/** Map a point event (zoom start, sound effect) to output time; null if the moment was cut. */
export function mapPoint(at, timeline) {
    return srcToOut(at, timeline);
}

/** Map a ranged event; the end is clipped to the piece the start lands in. Null if the start was cut. */
export function mapRange(start, end, timeline) {
    const piece = pieceAt(start, timeline);
    if (!piece) return null;
    const outStart = piece.outStart + (start - piece.srcStart);
    const clippedEnd = Math.min(end, piece.srcEnd);
    return { start: round(outStart), end: round(piece.outStart + (clippedEnd - piece.srcStart)) };
}
