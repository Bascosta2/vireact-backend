import { CAPTION_PRESETS } from './edl.js';
import { FPS, buildPieces, buildTimeline, captionPages, mapPoint, mapRange } from './timing.js';

/**
 * Combine Claude's plan with the creator's review-screen changes into the exact props the Remotion
 * composition plays (in-browser preview and the final render use the same props). Pure.
 */

export const OUTPUT = Object.freeze({ width: 1080, height: 1920, fps: FPS });
const MAX_TEXT = 60;

const f = (sec) => Math.max(0, Math.round(sec * FPS));
const bool = (v) => v === true;
const idList = (v, max = 200) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x.length <= 40))].slice(0, max) : []);
const intList = (v, max = 200) => (Array.isArray(v) ? [...new Set(v.filter((x) => Number.isInteger(x) && x >= 0))].slice(0, max) : []);

/**
 * Keep only known keys with the right types, so a PATCH can never store junk.
 * @param {object} input body from the client
 * @param {{wordCount:number, trackIds:Set<string>}} ctx
 */
export function sanitizeEdits(input = {}, { wordCount = 0, trackIds = new Set() } = {}) {
    const out = {};
    if ('disabledSegments' in input) out.disabledSegments = idList(input.disabledSegments);
    if ('restoredCandidates' in input) out.restoredCandidates = idList(input.restoredCandidates, 1000);
    if ('disabledZooms' in input) out.disabledZooms = intList(input.disabledZooms);
    for (const k of ['keepOriginalOrder', 'captionsOff', 'hookOverlayOff', 'zoomsOff', 'overlaysOff', 'sfxOff']) {
        if (k in input) out[k] = bool(input[k]);
    }
    if (CAPTION_PRESETS.includes(input.captionPreset)) out.captionPreset = input.captionPreset;
    if (typeof input.hookText === 'string') out.hookText = input.hookText.trim().slice(0, MAX_TEXT);
    if (input.captionText && typeof input.captionText === 'object') {
        out.captionText = {};
        for (const [k, v] of Object.entries(input.captionText).slice(0, 500)) {
            const i = Number(k);
            if (Number.isInteger(i) && i >= 0 && i < wordCount && typeof v === 'string') out.captionText[i] = v.trim().slice(0, 40);
        }
    }
    if ('musicTrackId' in input) {
        const id = input.musicTrackId;
        if (id === null || id === 'none') out.musicTrackId = null;
        else if (typeof id === 'string' && trackIds.has(id)) out.musicTrackId = id;
    }
    if ('musicVolume' in input && Number.isFinite(Number(input.musicVolume))) out.musicVolume = Math.min(0.6, Math.max(0, Number(input.musicVolume)));
    if (input.framingMode === 'fill' || input.framingMode === 'fit_blur') out.framingMode = input.framingMode;
    return out;
}

/** Merge speech into output-frame ranges so music can duck under the voice. */
const speechRanges = (pages) => {
    const ranges = [];
    for (const w of pages.flatMap((p) => p.words)) {
        const s = f(w.start);
        const e = f(w.end);
        const last = ranges[ranges.length - 1];
        if (last && s - last.endFrame <= f(0.35)) last.endFrame = Math.max(last.endFrame, e);
        else ranges.push({ startFrame: s, endFrame: e });
    }
    return ranges;
};

/**
 * @param {object} plan validated EDL
 * @param {object} edits sanitized creator changes
 * @param {{words:Array, silences:Array, durationSec:number, cutCandidates:Array}} media
 */
export function buildRenderProps(plan, edits = {}, media = {}) {
    const words = media.words ?? [];
    const disabled = new Set(edits.disabledSegments ?? []);
    let segments = plan.segments.filter((s) => !disabled.has(s.id));
    if (edits.keepOriginalOrder) segments = [...segments].sort((a, b) => a.start - b.start);

    const restored = new Set(edits.restoredCandidates ?? []);
    const candidates = new Map((media.cutCandidates ?? []).map((c) => [c.id, c]));
    const cuts = plan.acceptedCandidateIds.filter((id) => !restored.has(id)).map((id) => candidates.get(id)).filter(Boolean);

    const pieces = buildPieces(segments, cuts, { words, silences: media.silences ?? [], durationSec: media.durationSec });
    const { timeline, durationFrames } = buildTimeline(pieces, FPS);

    const preset = edits.captionPreset ?? plan.captions.preset;
    const pages = captionPages(words, timeline, { emphasis: new Set(plan.captions.emphasisWordIdx), textOverrides: edits.captionText ?? {} });
    const captions = edits.captionsOff
        ? null
        : {
            preset,
            pages: pages.map((p) => ({
                startFrame: f(p.start),
                endFrame: Math.max(f(p.end), f(p.start) + 1),
                words: p.words.map((w) => ({ text: w.text, startFrame: f(w.start), endFrame: Math.max(f(w.end), f(w.start) + 1), emphasis: w.emphasis, i: w.i })),
            })),
        };

    const hookText = edits.hookText ?? plan.hookOverlay.text;
    const hook = !edits.hookOverlayOff && plan.hookOverlay.enabled && hookText
        ? { text: hookText, startFrame: 0, durationFrames: Math.min(durationFrames, f(plan.hookOverlay.durationSec)) }
        : null;

    const offZooms = new Set(edits.disabledZooms ?? []);
    const zooms = edits.zoomsOff ? [] : plan.zooms
        .map((z, index) => ({ ...z, index }))
        .filter((z) => !offZooms.has(z.index))
        .map((z) => {
            const range = mapRange(z.at, z.at + z.duration, timeline);
            return range ? { index: z.index, startFrame: f(range.start), durationFrames: Math.max(1, f(range.end) - f(range.start)), scale: z.scale, focusX: z.focusX, focusY: z.focusY } : null;
        })
        .filter(Boolean);

    const overlays = edits.overlaysOff ? [] : plan.textOverlays
        .map((o) => {
            const range = mapRange(o.start, o.end, timeline);
            return range ? { startFrame: f(range.start), durationFrames: Math.max(1, f(range.end) - f(range.start)), text: o.text, position: o.position } : null;
        })
        .filter(Boolean);

    const sfx = edits.sfxOff ? [] : plan.sfx
        .map((s) => {
            const t = mapPoint(s.at, timeline);
            return t == null ? null : { type: s.type, frame: f(t) };
        })
        .filter(Boolean);

    const trackId = 'musicTrackId' in edits ? edits.musicTrackId : plan.music.trackId;
    const music = trackId ? { trackId, volume: edits.musicVolume ?? plan.music.volume, duck: speechRanges(pages) } : null;

    return {
        ...OUTPUT,
        durationInFrames: Math.max(1, durationFrames),
        timeline: timeline.map((p) => ({ id: p.id, segId: p.segId, srcStart: p.srcStart, srcEnd: p.srcEnd, outStartFrame: p.outStartFrame, durationFrames: p.durationFrames })),
        captions,
        hook,
        zooms,
        overlays,
        sfx,
        music,
        framing: { mode: edits.framingMode ?? plan.framing.mode, focusX: plan.framing.focusX },
    };
}
