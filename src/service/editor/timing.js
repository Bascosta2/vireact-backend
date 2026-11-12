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
const LEAD_PAD = 0.04;
const TAIL_PAD = 0.06;

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
    const inside = (t) => words.findIndex((w) => t > w.start && t < w.end);

    const snapStart = (t) => {
        const i = inside(t);
        // A start inside a word keeps the word if the cut is in its first half, otherwise drops it.
        if (i >= 0) return t <= (words[i].start + words[i].end) / 2 ? startAt(i) : words[i].end + 0.01;
        const options = [...words.map((_, k) => startAt(k)), ...silences.map((s) => s.end - LEAD_PAD)];
        return nearest(t, options, tol) ?? t;
    };
    const snapEnd = (t) => {
        const i = inside(t);
        if (i >= 0) return t >= (words[i].start + words[i].end) / 2 ? endAt(i) : words[i].start - 0.01;
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

/**
 * Word-level captions on the output timeline, grouped into short pages (2-4 words) that break on
 * punctuation, long pauses and cuts.
 * @param {Array<{w:string,start:number,end:number}>} words
 * @param {{emphasis?:Set<number>, textOverrides?:Record<string,string>, maxWords?:number, maxChars?:number}} opts
 */
export function captionPages(words, timeline, { emphasis = new Set(), textOverrides = {}, maxWords = 4, maxChars = 24, maxGap = 0.6 } = {}) {
    const placed = [];
    words.forEach((w, i) => {
        const mid = (w.start + w.end) / 2;
        const piece = pieceAt(mid, timeline);
        if (!piece) return;
        const s = Math.max(w.start, piece.srcStart);
        const e = Math.min(w.end, piece.srcEnd);
        const text = String(textOverrides[i] ?? w.w).trim();
        if (!text) return;
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

    const pages = [];
    let cur = null;
    for (const w of placed) {
        const prev = cur?.words[cur.words.length - 1];
        const chars = cur ? cur.words.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length : 0;
        const breakHere = !cur
            || cur.words.length >= maxWords
            || chars > maxChars
            || w.start - prev.end > maxGap
            || prev.pieceId !== w.pieceId && w.start - prev.end > 0.05
            || /[.!?,;:]$/.test(prev.text);
        if (breakHere) {
            cur = { words: [] };
            pages.push(cur);
        }
        cur.words.push(w);
    }
    return pages.map((p, k) => {
        const start = p.words[0].start;
        const lastEnd = p.words[p.words.length - 1].end;
        const nextStart = pages[k + 1]?.words[0].start;
        // Hold the page until the next one if the gap is short, so captions don't flicker.
        const end = nextStart != null && nextStart - lastEnd < 0.3 ? nextStart : lastEnd;
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
