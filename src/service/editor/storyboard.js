import { requestClaudeJson } from '../../lib/anthropic.js';
import { EFFECT_TYPES, GRAPHIC_TYPES, SFX_TYPES, VISUAL_NAMES, normalizeGraphic } from './edl.js';

/**
 * Storyboard review (EDITOR_FEATURES_V2). A "beat" is one planned segment (hook, turn, payoff...) with the
 * graphics, sounds, effects and zooms that fall inside it. The creator approves, drops or swaps beats before
 * rendering:
 * - drop    = the segment id goes into edits.disabledSegments (the same switch the review page already has);
 * - swap    = the planner is asked for another treatment of that one beat; the answer is kept in
 *             edits.beatSwaps[segmentId] and replaces the plan's graphics/sounds/effects inside that segment;
 * - approve = edits.storyboardApproved, which the server clears whenever a beat changes.
 */

const MAX_SWAP_GRAPHICS = 3;
const MAX_SWAP_SOUNDS = 4;
const MAX_SWAP_EFFECTS = 2;
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const within = (t, s) => t >= s.start && t < s.end;
const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

const graphicLabel = (g) => (g.type === 'visual' ? g.visual : g.type === 'list' ? (g.items ?? []).join(', ') : g.text) || '';

/** Replace the plan's graphics, sounds and effects inside each swapped segment. Pure; unknown ids are ignored. */
export function applyBeatSwaps(plan, swaps) {
    const ids = Object.keys(swaps ?? {});
    if (!ids.length) return plan;
    const segs = (plan.segments ?? []).filter((s) => swaps[s.id]);
    if (!segs.length) return plan;
    const inSwapped = (t) => segs.some((s) => within(t, s));
    const add = (key) => segs.flatMap((s) => swaps[s.id]?.[key] ?? []);
    return {
        ...plan,
        graphics: [...(plan.graphics ?? []).filter((g) => !inSwapped(g.start)), ...add('graphics')].sort((a, b) => a.start - b.start),
        sfx: [...(plan.sfx ?? []).filter((e) => !inSwapped(e.at)), ...add('sfx')].sort((a, b) => a.at - b.at),
        effects: [...(plan.effects ?? []).filter((e) => !inSwapped(e.at)), ...add('effects')].sort((a, b) => a.at - b.at),
    };
}

/** What the review page shows: every beat with its graphics, sounds and framing, and whether it was dropped or swapped. */
export function buildStoryboard(plan, edits = {}) {
    const swaps = edits.beatSwaps ?? {};
    const dropped = new Set(edits.disabledSegments ?? []);
    const live = applyBeatSwaps(plan, swaps);
    const framing = edits.framingMode ?? plan.framing?.mode ?? 'fill';
    return {
        approved: edits.storyboardApproved === true,
        beats: (plan.segments ?? []).map((s) => ({
            id: s.id,
            role: s.role,
            start: s.start,
            end: s.end,
            reason: s.reason,
            dropped: dropped.has(s.id),
            swapped: Boolean(swaps[s.id]),
            swapNote: swaps[s.id]?.why ?? null,
            graphics: (live.graphics ?? []).filter((g) => within(g.start, s)).map((g) => ({ type: g.type, text: graphicLabel(g), start: g.start })),
            sounds: (live.sfx ?? []).filter((e) => within(e.at, s)).map((e) => ({ type: e.type, at: e.at })),
            effects: (live.effects ?? []).filter((e) => within(e.at, s)).map((e) => ({ type: e.type, at: e.at })),
            zooms: (plan.zooms ?? []).filter((z) => within(z.at, s)).length,
            framing,
        })),
    };
}

/** Keep only well-formed swap entries (a PATCH can never store junk). */
export function sanitizeBeatSwaps(input, segmentIds = null) {
    const out = {};
    if (!input || typeof input !== 'object') return out;
    for (const [id, v] of Object.entries(input).slice(0, 50)) {
        if (segmentIds && !segmentIds.has(id)) continue;
        if (!v || typeof v !== 'object') continue;
        out[id] = {
            graphics: (Array.isArray(v.graphics) ? v.graphics : []).slice(0, MAX_SWAP_GRAPHICS).map(normalizeGraphic),
            sfx: (Array.isArray(v.sfx) ? v.sfx : []).filter((e) => SFX_TYPES.includes(e?.type) && Number.isFinite(e.at)).slice(0, MAX_SWAP_SOUNDS).map((e) => ({ type: e.type, at: r3(e.at) })),
            effects: (Array.isArray(v.effects) ? v.effects : []).filter((e) => EFFECT_TYPES.includes(e?.type) && Number.isFinite(e.at)).slice(0, MAX_SWAP_EFFECTS).map((e) => ({ type: e.type, at: r3(e.at) })),
            why: String(v.why ?? '').slice(0, 200),
            count: Math.min(9, Math.max(1, Number(v.count) || 1)),
        };
    }
    return out;
}

/**
 * After a regeneration the plan has new segment ids. Carry the creator's drops and swaps over by time: a new
 * segment that sits mostly inside a dropped (or swapped) range inherits it. Approval is never carried.
 */
export function carryStoryboard(oldPlan, oldEdits, newPlan) {
    const droppedOld = (oldPlan.segments ?? []).filter((s) => (oldEdits.disabledSegments ?? []).includes(s.id));
    const swappedOld = (oldPlan.segments ?? []).filter((s) => oldEdits.beatSwaps?.[s.id]);
    const disabledSegments = [];
    const beatSwaps = {};
    for (const n of newPlan.segments ?? []) {
        const len = Math.max(0.01, n.end - n.start);
        if (droppedOld.some((o) => overlap(o, n) / len >= 0.5)) disabledSegments.push(n.id);
        const o = swappedOld.find((x) => overlap(x, n) / len >= 0.5);
        if (o) beatSwaps[n.id] = oldEdits.beatSwaps[o.id];
    }
    return { disabledSegments, beatSwaps };
}

/** Text for the regenerate prompt: what the creator already decided on the storyboard. */
export function storyboardNote(plan, edits = {}) {
    const dropped = (plan.segments ?? []).filter((s) => (edits.disabledSegments ?? []).includes(s.id));
    const swapped = (plan.segments ?? []).filter((s) => edits.beatSwaps?.[s.id]);
    const lines = [];
    if (dropped.length) lines.push(`The creator DROPPED these parts of the footage; leave them out entirely: ${dropped.map((s) => `${s.start}-${s.end}s`).join(', ')}.`);
    if (swapped.length) lines.push(`The creator picked their own graphics and sounds for these parts; keep their ranges as segments and do not place other graphics or sounds inside them: ${swapped.map((s) => `${s.start}-${s.end}s`).join(', ')}.`);
    return lines.join('\n');
}

const SWAP_SCHEMA = {
    type: 'object',
    properties: {
        why: { type: 'string' },
        graphics: { type: 'array', items: { type: 'object', properties: {
            type: { type: 'string', description: `One of: ${GRAPHIC_TYPES.join(', ')}` },
            start: { type: 'number' }, end: { type: 'number' }, text: { type: 'string' }, subtext: { type: 'string' },
            items: { type: 'string', description: 'list: items separated by " | "; visual: the illustration name' },
            focusX: { type: 'number' }, focusY: { type: 'number' },
        }, required: ['type', 'start', 'end', 'text', 'subtext', 'items', 'focusX', 'focusY'], additionalProperties: false } },
        beats: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', description: 'a sound name, or shake, or flash' }, at: { type: 'number' } }, required: ['type', 'at'], additionalProperties: false } },
    },
    required: ['why', 'graphics', 'beats'],
    additionalProperties: false,
};

/** Validate the planner's alternative for one beat against that beat's range. */
export function cleanSwap(data, segment) {
    const graphics = (data?.graphics ?? []).map(normalizeGraphic)
        .filter((g) => within(g.start, segment) && (g.type === 'visual' ? Boolean(g.visual) : g.type === 'list' ? g.items.length > 0 : Boolean(g.text)))
        .slice(0, MAX_SWAP_GRAPHICS);
    const beats = Array.isArray(data?.beats) ? data.beats.filter((b) => Number.isFinite(b?.at) && within(b.at, segment)) : [];
    return {
        graphics,
        sfx: beats.filter((b) => SFX_TYPES.includes(b.type)).slice(0, MAX_SWAP_SOUNDS).map((b) => ({ type: b.type, at: r3(b.at) })),
        effects: beats.filter((b) => EFFECT_TYPES.includes(b.type)).slice(0, MAX_SWAP_EFFECTS).map((b) => ({ type: b.type, at: r3(b.at) })),
        why: String(data?.why ?? '').slice(0, 200),
    };
}

/**
 * Ask the planner for another treatment of ONE beat (graphics, sounds, effects) and return it validated.
 * @param {{plan:object, edits:object, words:Array, segmentId:string}} args
 */
export async function swapBeat({ plan, edits = {}, words = [], segmentId }, deps = {}) {
    const request = deps.request ?? requestClaudeJson;
    const segment = (plan.segments ?? []).find((s) => s.id === segmentId);
    if (!segment) return null;
    const beat = buildStoryboard(plan, edits).beats.find((b) => b.id === segmentId);
    const spoken = words.filter((w) => w.start >= segment.start && w.start < segment.end).map((w) => w.w).join(' ');
    const system = [{ type: 'text', text: [
        'You are the senior short-form video editor at Vireact. The creator reviewed the storyboard and asked for a different treatment of ONE beat. Return new graphics and sounds for that beat only.',
        `Graphic types: ${GRAPHIC_TYPES.join(', ')}. For a visual, items is exactly one of: ${VISUAL_NAMES.join(', ')}.`,
        `Sounds (type in beats): ${SFX_TYPES.join(', ')}; effects: ${EFFECT_TYPES.join(', ')}.`,
        `Rules: all times are source seconds inside the beat's range. At most ${MAX_SWAP_GRAPHICS} graphics (usually 1) and ${MAX_SWAP_SOUNDS} sounds (usually 1 or 2), never two sounds within 2 seconds, each graphic must say something the words alone do not and must differ from the current treatment. Never promise results. Use only the creator's footage. Return only the JSON object.`,
    ].join('\n') }];
    const user = [
        `BEAT ${segment.id} (${segment.role}) ${segment.start}-${segment.end}s. Why it is in the edit: ${segment.reason || 'n/a'}`,
        `SPOKEN: ${spoken || '(no speech)'}`,
        `CURRENT graphics: ${JSON.stringify(beat?.graphics ?? [])}`,
        `CURRENT sounds and effects: ${JSON.stringify([...(beat?.sounds ?? []), ...(beat?.effects ?? [])])}`,
        'Give a different treatment of this beat.',
    ].join('\n');
    const res = await request({ label: 'editor_beat_swap', system, messages: [{ role: 'user', content: user }], schema: SWAP_SCHEMA, effort: 'low', maxTokens: 4000 });
    const swap = cleanSwap(res.data, segment);
    return { ...swap, count: Math.min(9, (edits.beatSwaps?.[segmentId]?.count ?? 0) + 1), generationId: res.generationId ?? null };
}
