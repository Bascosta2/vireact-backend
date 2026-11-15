import { VISUALS, captionPreset, normalizeGraphic } from './edl.js';
import { FPS, buildPieces, buildTimeline, captionPages, mapPoint, mapRange } from './timing.js';

/**
 * Combine Claude's plan with the creator's review-screen changes into the exact props the Remotion
 * composition plays (in-browser preview and the final render use the same props). Pure.
 *
 * Besides placing what the plan asks for, this adds the parts that should never depend on the model
 * remembering them: a transition at every jump between segments, alternating jump-cut zooms inside a
 * segment, and a sound design pass that gives every transition, graphic and effect its sound.
 */

export const OUTPUT = Object.freeze({ width: 1080, height: 1920, fps: FPS });
const MAX_TEXT = 60;

export const ACCENT_HEX = Object.freeze({ yellow: '#FFD43B', green: '#3DDC84', pink: '#FF4FA3', orange: '#FF8A1F', blue: '#4DA3FF', red: '#FF4D4D' });

/**
 * Sounds for each automatic event. Every event has a pool and takes the next sound in it each time,
 * so three pills in a row pop, bubble and blip instead of repeating one sound. Illustrations bring
 * their own sound (VISUALS in edl.js).
 */
export const SFX_FOR_GRAPHIC = Object.freeze({
    slam: ['boom', 'impact', 'kick', 'thud'],
    pill: ['pop', 'bubble', 'blip', 'snap'],
    headline: ['swoosh', 'swish', 'sweep_up'],
    lower_third: ['swoosh', 'page', 'swish'],
    counter: ['typing'],
    list: ['pop', 'tap', 'blip'],
    callout: ['pop', 'snap', 'blip'],
    cta: ['notify', 'chime', 'success'],
});
export const SFX_FOR_TRANSITION = Object.freeze({ punch: ['swoosh', 'swish', 'thud'], whip: ['whoosh', 'whip', 'sweep_down'], flash: ['hit', 'shutter', 'impact'], glitch: ['glitch', 'static', 'zap'] });
export const SFX_FOR_EFFECT = Object.freeze({ shake: ['hit', 'thud', 'impact'], flash: ['shutter', 'zap'] });
const SFX_FOR_ZOOM = ['swoosh', 'swish', 'sweep_up'];
const SFX_FOR_COUNT_END = ['ding', 'coin', 'chime'];
const SFX_FOR_LIST_ITEM = ['tap', 'tick', 'pop'];
const SFX_FOR_LIST_END = ['ding', 'chime'];
/** The rush of air just before a slam lands. */
const SFX_BEFORE_SLAM = ['whoosh', 'sweep_down', 'swish'];
/** The soft lead-in just before an illustration appears. */
const SFX_BEFORE_VISUAL = ['swish', 'sweep_up', 'whip', 'swoosh'];
/** A money counter lands on the till; the coin stands in when the till has just played. */
const SFX_FOR_MONEY = ['cash', 'coin'];

/** How loud each sound plays (0-1). */
export const SFX_VOLUME = Object.freeze({
    whoosh: 0.55, swoosh: 0.45, swish: 0.4, whip: 0.5, sweep_up: 0.45, sweep_down: 0.45, reverse: 0.5, riser: 0.5, launch: 0.55,
    boom: 0.7, hit: 0.65, thud: 0.6, impact: 0.7, bass_drop: 0.7, kick: 0.6, snap: 0.5, clap: 0.5,
    pop: 0.6, click: 0.5, tick: 0.45, tap: 0.5, blip: 0.45, bubble: 0.5, drip: 0.5, typing: 0.4, page: 0.45, shutter: 0.55,
    ding: 0.5, chime: 0.45, bell: 0.45, sparkle: 0.45, shimmer: 0.4, notify: 0.5, success: 0.5, coin: 0.5, cash: 0.55, power_up: 0.45,
    suspense: 0.45, glitch: 0.5, static: 0.4, zap: 0.5, error: 0.5, alert: 0.5, power_down: 0.45, pulse: 0.5, heartbeat: 0.6,
});

/** Hands out the next sound of a pool per kind of event (in order, so the result is repeatable). */
const soundRotation = () => {
    const used = new Map();
    return (key, pool) => {
        const n = used.get(key) ?? 0;
        used.set(key, n + 1);
        return pool[n % pool.length];
    };
};
/** Two sounds never start closer than this; the more important one wins. */
const SFX_MIN_GAP_FRAMES = 5;
/** An automatic sound with no alternative is dropped when the same sound played this recently. */
const SFX_REPEAT_FRAMES = 90;

/** Graphic timings the composition uses, so sounds land on the animation. */
export const COUNTER_SEC = 1.1;
export const LIST_FIRST_SEC = 0.35;
export const LIST_STEP_SEC = 0.45;

const JUMP_ZOOM = 1.08;
/** Graphics drawn in the top area, where the hook card sits during the first seconds. */
const TOP_GRAPHICS = new Set(['pill', 'headline', 'counter', 'list', 'visual']);
/** Graphics drawn in the strip under the captions. */
const LOW_GRAPHICS = new Set(['lower_third', 'cta']);
/** The shortest time an illustration may stay on screen. */
const VISUAL_MIN_SEC = 0.9;
/** Captions show 2-3 words on one line; the tall "impact" look shows 2. Widths match the composition's font sizes. */
const CAPTION_PAGE = Object.freeze({ default: { maxWords: 3, maxChars: 16 }, impact: { maxWords: 2, maxChars: 14 } });
const HOOK_MIN_SEC = 1;

const f = (sec) => Math.max(0, Math.round(sec * FPS));
const bool = (v) => v === true;
const idList = (v, max = 200) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x.length <= 40))].slice(0, max) : []);
const intList = (v, max = 200) => (Array.isArray(v) ? [...new Set(v.filter((x) => Number.isInteger(x) && x >= 0))].slice(0, max) : []);

export const EDIT_FLAGS = ['keepOriginalOrder', 'captionsOff', 'hookOverlayOff', 'zoomsOff', 'overlaysOff', 'sfxOff', 'transitionsOff', 'effectsOff'];

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
    for (const k of EDIT_FLAGS) {
        if (k in input) out[k] = bool(input[k]);
    }
    const preset = captionPreset(input.captionPreset, null);
    if (preset) out.captionPreset = preset;
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

/** Plans saved before graphics existed: their text overlays become pill graphics, the rest gets defaults. */
const withDefaults = (plan) => ({
    ...plan,
    graphics: plan.graphics ?? (plan.textOverlays ?? []).map((o) => normalizeGraphic({ type: 'pill', start: o.start, end: o.end, text: o.text })),
    transitions: plan.transitions ?? { style: 'punch', jumpCutZoom: true },
    effects: plan.effects ?? [],
    look: plan.look ?? { grade: 'vivid', accent: 'yellow', progressBar: true, motion: true },
});

/**
 * Keep sounds from piling up: sorted by importance, a sound is dropped when a more important one
 * already starts within SFX_MIN_GAP_FRAMES. Then, in time order, a sound that would repeat the one
 * just before it switches to another from its `pool`; with no pool, an automatic sound (priority
 * under 3) close behind the same sound is dropped. List items (`series`) repeat on purpose.
 * Returned in time order.
 */
export function arrangeSfx(events, durationInFrames) {
    const kept = [];
    for (const e of [...events].sort((a, b) => b.priority - a.priority || a.frame - b.frame)) {
        if (e.frame < 0 || e.frame >= durationInFrames) continue;
        if (kept.some((k) => Math.abs(k.frame - e.frame) < SFX_MIN_GAP_FRAMES)) continue;
        kept.push(e);
    }
    kept.sort((a, b) => a.frame - b.frame);
    const out = [];
    kept.forEach((e, k) => {
        const prev = out[out.length - 1];
        if (!prev || prev.type !== e.type || (prev.series && e.series)) return out.push(e);
        const after = kept[k + 1]?.type;
        const other = e.pool?.find((t) => t !== prev.type && t !== after) ?? e.pool?.find((t) => t !== prev.type);
        if (other) return out.push({ ...e, type: other, volume: e.ownVolume ? e.volume : SFX_VOLUME[other] ?? e.volume });
        if (e.frame - prev.frame >= SFX_REPEAT_FRAMES) return out.push(e);
        if (e.priority < 3) return null;
        if (prev.priority < 3) out.pop();
        return out.push(e);
    });
    return out.map(({ type, frame, volume }) => ({ type, frame, volume }));
}

/**
 * @param {object} plan validated EDL
 * @param {object} edits sanitized creator changes
 * @param {{words:Array, silences:Array, durationSec:number, cutCandidates:Array}} media
 */
export function buildRenderProps(rawPlan, edits = {}, media = {}) {
    const plan = withDefaults(rawPlan);
    const words = media.words ?? [];
    const disabled = new Set(edits.disabledSegments ?? []);
    let segments = plan.segments.filter((s) => !disabled.has(s.id));
    if (edits.keepOriginalOrder) segments = [...segments].sort((a, b) => a.start - b.start);

    const restored = new Set(edits.restoredCandidates ?? []);
    const candidates = new Map((media.cutCandidates ?? []).map((c) => [c.id, c]));
    const cuts = plan.acceptedCandidateIds.filter((id) => !restored.has(id)).map((id) => candidates.get(id)).filter(Boolean);

    const pieces = buildPieces(segments, cuts, { words, silences: media.silences ?? [], durationSec: media.durationSec });
    const { timeline, durationFrames } = buildTimeline(pieces, FPS);
    const total = Math.max(1, durationFrames);
    const sfxEvents = [];
    // `pool` lists the sounds that could stand in for this one if it would repeat the sound before it.
    const sound = (type, frame, priority, volume, pool = null, series = false) =>
        sfxEvents.push({ type, frame, priority, volume: volume ?? SFX_VOLUME[type], ownVolume: volume != null, pool, series });
    const next = soundRotation();
    /** The next sound from a pool, in rotation. */
    const rotate = (key, pool, frame, priority, volume) => sound(next(key, pool), frame, priority, volume, pool);

    // Jump cuts: inside one segment, alternate a slight zoom so each removed pause reads as a cut.
    const transitionsOn = !edits.transitionsOff;
    let run = 0;
    const timelineOut = timeline.map((p, k) => {
        const sameSegment = k > 0 && timeline[k - 1].segId === p.segId;
        run = sameSegment ? run + 1 : 0;
        const baseScale = transitionsOn && plan.transitions.jumpCutZoom && run % 2 === 1 ? JUMP_ZOOM : 1;
        return { id: p.id, segId: p.segId, srcStart: p.srcStart, srcEnd: p.srcEnd, outStartFrame: p.outStartFrame, durationFrames: p.durationFrames, baseScale };
    });

    // A transition at every jump between segments.
    const transitions = [];
    if (transitionsOn && plan.transitions.style !== 'none') {
        for (let k = 1; k < timeline.length; k += 1) {
            if (timeline[k].segId === timeline[k - 1].segId) continue;
            transitions.push({ type: plan.transitions.style, frame: timeline[k].outStartFrame });
            rotate('transition', SFX_FOR_TRANSITION[plan.transitions.style], Math.max(0, timeline[k].outStartFrame - 3), 1);
        }
    }

    const preset = captionPreset(edits.captionPreset ?? plan.captions.preset);
    const pages = captionPages(words, timeline, { emphasis: new Set(plan.captions.emphasisWordIdx), textOverrides: edits.captionText ?? {}, ...(CAPTION_PAGE[preset] ?? CAPTION_PAGE.default) });
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

    // Graphics keep their planned length on screen even when they run across a cut.
    const plannedGraphics = edits.overlaysOff ? [] : plan.graphics
        .map((g) => {
            const t = mapPoint(g.start, timeline);
            if (t == null) return null;
            const startFrame = f(t);
            const durationFrames = Math.max(1, Math.min(total - startFrame, f(g.end - g.start)));
            if (durationFrames <= 3) return null;
            const placed = { type: g.type, startFrame, durationFrames, text: g.text, subtext: g.subtext, items: g.items, focusX: g.focusX, focusY: g.focusY };
            return g.type === 'visual' ? { ...placed, visual: g.visual } : placed;
        })
        .filter(Boolean);
    // An illustration needs about a second to register. One that the next top graphic would
    // replace sooner than that is left out rather than flashed. Checked from the end, so an
    // illustration is only measured against a graphic that is really shown.
    const flashed = new Set();
    let nextTop = null;
    for (const g of plannedGraphics.filter((x) => TOP_GRAPHICS.has(x.type)).sort((a, b) => b.startFrame - a.startFrame)) {
        if (g.type === 'visual' && nextTop && nextTop.startFrame - g.startFrame < f(VISUAL_MIN_SEC)) flashed.add(g);
        else nextTop = g;
    }
    const placedGraphics = plannedGraphics.filter((g) => !flashed.has(g));
    const minShown = (g, sec) => f(g.type === 'visual' ? VISUAL_MIN_SEC : sec);

    // The hook card and top graphics share the top of the screen: the card ends when the first top
    // graphic starts (but shows for at least HOOK_MIN_SEC), and graphics inside that second wait for it.
    const hookText = edits.hookText ?? plan.hookOverlay.text;
    let hook = null;
    if (!edits.hookOverlayOff && plan.hookOverlay.enabled && hookText) {
        const firstTop = Math.min(Infinity, ...placedGraphics.filter((g) => TOP_GRAPHICS.has(g.type)).map((g) => g.startFrame));
        const planned = Math.min(total, f(plan.hookOverlay.durationSec));
        hook = { text: hookText, startFrame: 0, durationFrames: Math.max(Math.min(planned, f(HOOK_MIN_SEC)), Math.min(planned, firstTop)) };
        sound('hit', 0, 2);
    }

    const offZooms = new Set(edits.disabledZooms ?? []);
    const zooms = edits.zoomsOff ? [] : plan.zooms
        .map((z, index) => ({ ...z, index }))
        .filter((z) => !offZooms.has(z.index))
        .map((z) => {
            const range = mapRange(z.at, z.at + z.duration, timeline);
            return range ? { index: z.index, startFrame: f(range.start), durationFrames: Math.max(1, f(range.end) - f(range.start)), scale: z.scale, focusX: z.focusX, focusY: z.focusY } : null;
        })
        .filter(Boolean);
    for (const z of zooms) if (z.scale >= 1.12) rotate('zoom', SFX_FOR_ZOOM, z.startFrame, 0, 0.3);

    // Graphics that share a place on screen take turns: one ends (with its exit) when the next one starts.
    for (const slot of [TOP_GRAPHICS, LOW_GRAPHICS]) {
        const sharing = placedGraphics.filter((g) => slot.has(g.type)).sort((a, b) => a.startFrame - b.startFrame);
        for (let k = 0; k < sharing.length - 1; k += 1) {
            const room = sharing[k + 1].startFrame - sharing[k].startFrame;
            if (sharing[k].durationFrames > room) sharing[k].durationFrames = Math.max(1, room);
        }
    }
    const shownGraphics = placedGraphics
        .filter((g) => g.durationFrames >= minShown(g, 0.4))
        .map((g) => {
            if (!hook || g.startFrame >= hook.durationFrames || !TOP_GRAPHICS.has(g.type)) return g;
            const shift = hook.durationFrames - g.startFrame;
            return g.durationFrames - shift >= minShown(g, 0.5) ? { ...g, startFrame: hook.durationFrames, durationFrames: g.durationFrames - shift } : null;
        })
        .filter(Boolean);
    // A slam is drawn in the top area too. When the hook card or a top graphic is there at the same
    // time it moves under the captions (`low`); if that strip is taken as well it is left out.
    const together = (a, b) => a.startFrame < b.startFrame + b.durationFrames && b.startFrame < a.startFrame + a.durationFrames;
    const graphics = shownGraphics
        .map((g) => {
            if (g.type !== 'slam') return g;
            const topTaken = (hook && together(g, hook)) || shownGraphics.some((o) => TOP_GRAPHICS.has(o.type) && together(g, o));
            if (!topTaken) return g;
            return shownGraphics.some((o) => LOW_GRAPHICS.has(o.type) && together(g, o)) ? null : { ...g, low: true };
        })
        .filter(Boolean);
    // Sounds are handed out in the order the graphics appear, so the rotation follows the video.
    for (const g of [...graphics].sort((a, b) => a.startFrame - b.startFrame)) {
        if (g.type === 'visual') {
            sound(VISUALS[g.visual]?.sfx ?? 'pop', g.startFrame, 2);
            rotate('before_visual', SFX_BEFORE_VISUAL, Math.max(0, g.startFrame - 6), 0, 0.3);
            continue;
        }
        rotate(g.type, SFX_FOR_GRAPHIC[g.type], g.startFrame, 2);
        if (g.type === 'counter') {
            // Money lands with a cash register; other numbers rotate through the bright tones.
            const money = /[$€£]/.test(g.text);
            const landing = money ? 'cash' : next('count_end', SFX_FOR_COUNT_END);
            sound(landing, g.startFrame + Math.min(f(COUNTER_SEC), Math.round(g.durationFrames * 0.7)), 2, undefined, money ? SFX_FOR_MONEY : SFX_FOR_COUNT_END);
        }
        if (g.type === 'list') {
            const item = next('list_item', SFX_FOR_LIST_ITEM);
            const last = next('list_end', SFX_FOR_LIST_END);
            // The items of one list tick with the same sound on purpose (`series`), then the last one rings.
            g.items.forEach((_, k) => sound(k === g.items.length - 1 ? last : item, g.startFrame + f(LIST_FIRST_SEC + k * LIST_STEP_SEC), 2, 0.45, null, true));
        }
        if (g.type === 'slam') rotate('before_slam', SFX_BEFORE_SLAM, Math.max(0, g.startFrame - 6), 0, 0.35);
    }

    const effects = edits.effectsOff ? [] : plan.effects
        .map((e) => {
            const t = mapPoint(e.at, timeline);
            return t == null ? null : { type: e.type, frame: f(t) };
        })
        .filter(Boolean);
    for (const e of effects) rotate(e.type, SFX_FOR_EFFECT[e.type], e.frame, 2);

    // Sounds Claude placed itself (risers into reveals, drops on punchlines) outrank the automatic ones.
    for (const s of plan.sfx) {
        const t = mapPoint(s.at, timeline);
        if (t != null) sound(s.type, f(t), 3);
    }
    const sfx = edits.sfxOff ? [] : arrangeSfx(sfxEvents, total);

    const trackId = 'musicTrackId' in edits ? edits.musicTrackId : plan.music.trackId;
    const music = trackId ? { trackId, volume: edits.musicVolume ?? plan.music.volume, duck: speechRanges(pages) } : null;

    return {
        ...OUTPUT,
        durationInFrames: total,
        timeline: timelineOut,
        captions,
        hook,
        zooms,
        graphics,
        // Read by the composition deployed before graphics existed (it crashes without the field).
        overlays: [],
        transitions,
        effects,
        look: { grade: plan.look.grade, accent: ACCENT_HEX[plan.look.accent] ?? ACCENT_HEX.yellow, progressBar: plan.look.progressBar, motion: plan.look.motion },
        sfx,
        music,
        framing: { mode: edits.framingMode ?? plan.framing.mode, focusX: plan.framing.focusX },
    };
}
