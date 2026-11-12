/**
 * The edit decision list (EDL) Claude returns, its strict JSON schema, and the server-side checks.
 * Structural problems (bad segments, unknown ids, too short, promises) go back to Claude for one
 * retry; small out-of-range details (a zoom on a cut moment) are dropped quietly.
 */

export const CAPTION_PRESETS = ['bold_pop', 'clean', 'karaoke'];
export const SFX_TYPES = ['whoosh', 'pop', 'riser', 'ding', 'boom'];
export const CHANGE_KINDS = ['cut', 'reorder', 'captions', 'zoom', 'hook', 'overlay', 'music', 'sfx', 'framing'];
export const EVIDENCE = ['knowledge', 'viral_example', 'footage'];
export const SEGMENT_ROLES = ['hook', 'setup', 'body', 'payoff', 'cta'];

const BANNED = /\b(guarantee[ds]?|will go viral|go viral for sure|100% viral|viral guaranteed)\b/i;
const MIN_SEGMENT_SEC = 0.4;
const MIN_OUTPUT_SEC = 3;
const EDGE_TOLERANCE = 0.25;

const str = { type: 'string' };
const num = { type: 'number' };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const arr = (items) => ({ type: 'array', items });

export const EDL_SCHEMA = obj({
    summary: str,
    hookStrategy: str,
    segments: arr(obj({ id: str, start: num, end: num, role: { type: 'string', enum: SEGMENT_ROLES }, reason: str })),
    acceptedCandidateIds: arr(str),
    captions: obj({ preset: { type: 'string', enum: CAPTION_PRESETS }, emphasisWordIdx: arr({ type: 'integer' }) }),
    hookOverlay: obj({ enabled: { type: 'boolean' }, text: str, durationSec: num }),
    zooms: arr(obj({ at: num, duration: num, scale: num, focusX: num, focusY: num, reason: str })),
    textOverlays: arr(obj({ start: num, end: num, text: str, position: { type: 'string', enum: ['top', 'center', 'bottom'] } })),
    framing: obj({ mode: { type: 'string', enum: ['fill', 'fit_blur'] }, focusX: num }),
    music: obj({ trackId: str, volume: num, reason: str }),
    sfx: arr(obj({ type: { type: 'string', enum: SFX_TYPES }, at: num })),
    changes: arr(obj({ kind: { type: 'string', enum: CHANGE_KINDS }, label: str, why: str, evidence: { type: 'string', enum: EVIDENCE } })),
    expectedEffect: str,
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
const r3 = (n) => Math.round(Number(n) * 1000) / 1000;
const clip = (s, n) => String(s ?? '').trim().slice(0, n);

const inSegments = (t, segments) => segments.some((s) => t >= s.start && t < s.end);

/**
 * @param {object} edl raw model output
 * @param {{durationSec:number, wordCount:number, candidateIds:Set<string>|string[], trackIds:Set<string>|string[], candidateRanges?:Record<string,{start:number,end:number}>}} ctx
 * @returns {{ok:boolean, issues:string[], plan:object|null}}
 */
export function validateEdl(edl, ctx) {
    const issues = [];
    const duration = Number(ctx.durationSec) || 0;
    const candidateIds = new Set(ctx.candidateIds ?? []);
    const trackIds = new Set(ctx.trackIds ?? []);
    if (!edl || typeof edl !== 'object') return { ok: false, issues: ['Response was not an object'], plan: null };

    const segments = (edl.segments ?? []).map((s) => ({ ...s, start: r3(s.start), end: r3(s.end) }));
    if (segments.length === 0) issues.push('segments is empty: keep at least one part of the footage');
    const ids = new Set();
    for (const s of segments) {
        if (!s.id || ids.has(s.id)) issues.push(`segment id "${s.id}" is missing or repeated`);
        ids.add(s.id);
        if (s.start < -EDGE_TOLERANCE || s.end > duration + EDGE_TOLERANCE) issues.push(`segment ${s.id} (${s.start}-${s.end}) is outside the video (0-${duration})`);
        if (s.end - s.start < MIN_SEGMENT_SEC) issues.push(`segment ${s.id} is shorter than ${MIN_SEGMENT_SEC}s`);
        s.start = clamp(s.start, 0, duration);
        s.end = clamp(s.end, 0, duration);
    }
    const bySource = [...segments].sort((a, b) => a.start - b.start);
    for (let i = 1; i < bySource.length; i += 1) {
        if (bySource[i].start < bySource[i - 1].end - 0.05) issues.push(`segments ${bySource[i - 1].id} and ${bySource[i].id} overlap: each moment of footage can be used once`);
    }

    const accepted = [...new Set(edl.acceptedCandidateIds ?? [])];
    const unknown = accepted.filter((id) => !candidateIds.has(id));
    if (unknown.length) issues.push(`acceptedCandidateIds has unknown ids: ${unknown.slice(0, 5).join(', ')}`);

    // Output length after accepted cuts.
    const ranges = ctx.candidateRanges ?? {};
    const cutInside = (s) => accepted.reduce((n, id) => {
        const c = ranges[id];
        if (!c) return n;
        return n + Math.max(0, Math.min(c.end, s.end) - Math.max(c.start, s.start));
    }, 0);
    const outputSec = segments.reduce((n, s) => n + Math.max(0, s.end - s.start - cutInside(s)), 0);
    const minOut = Math.min(MIN_OUTPUT_SEC, duration * 0.5);
    if (segments.length && outputSec < minOut) issues.push(`the edit is only ${outputSec.toFixed(1)}s long; keep at least ${minOut.toFixed(1)}s`);

    const emphasis = (edl.captions?.emphasisWordIdx ?? []).filter((i) => Number.isInteger(i) && i >= 0 && i < (ctx.wordCount ?? 0));
    const musicId = String(edl.music?.trackId ?? '').trim();
    if (musicId && !trackIds.has(musicId)) issues.push(`music.trackId "${musicId}" is not in the sound library; use one of the listed ids or ""`);

    const texts = [edl.summary, edl.hookStrategy, edl.expectedEffect, edl.hookOverlay?.text, ...(edl.changes ?? []).flatMap((c) => [c.label, c.why]), ...(edl.textOverlays ?? []).map((o) => o.text)];
    if (texts.some((t) => BANNED.test(String(t ?? '')))) issues.push('remove promises such as "guaranteed" or "will go viral"; describe the expected effect without guarantees');

    if (issues.length) return { ok: false, issues, plan: null };

    const kept = segments;
    const plan = {
        summary: clip(edl.summary, 600),
        hookStrategy: clip(edl.hookStrategy, 400),
        segments: kept.map((s) => ({ id: s.id, start: s.start, end: s.end, role: s.role, reason: clip(s.reason, 200) })),
        acceptedCandidateIds: accepted,
        captions: { preset: CAPTION_PRESETS.includes(edl.captions?.preset) ? edl.captions.preset : 'bold_pop', emphasisWordIdx: [...new Set(emphasis)] },
        hookOverlay: {
            enabled: Boolean(edl.hookOverlay?.enabled && clip(edl.hookOverlay?.text, 60)),
            text: clip(edl.hookOverlay?.text, 60),
            durationSec: r3(clamp(edl.hookOverlay?.durationSec ?? 2, 1, 3)),
        },
        zooms: (edl.zooms ?? [])
            .filter((z) => inSegments(z.at, kept))
            .slice(0, 30)
            .map((z) => ({ at: r3(z.at), duration: r3(clamp(z.duration, 0.3, 4)), scale: r3(clamp(z.scale, 1.0, 1.35)), focusX: r3(clamp(z.focusX, 0, 1)), focusY: r3(clamp(z.focusY, 0, 1)), reason: clip(z.reason, 160) })),
        textOverlays: (edl.textOverlays ?? [])
            .filter((o) => clip(o.text, 60) && inSegments(o.start, kept) && o.end > o.start)
            .slice(0, 10)
            .map((o) => ({ start: r3(o.start), end: r3(Math.min(o.end, o.start + 6)), text: clip(o.text, 60), position: o.position })),
        framing: { mode: edl.framing?.mode === 'fit_blur' ? 'fit_blur' : 'fill', focusX: r3(clamp(edl.framing?.focusX ?? 0.5, 0, 1)) },
        music: { trackId: musicId || null, volume: r3(clamp(edl.music?.volume ?? 0.15, 0, 0.6)), reason: clip(edl.music?.reason, 200) },
        sfx: (edl.sfx ?? []).filter((s) => SFX_TYPES.includes(s.type) && inSegments(s.at, kept)).slice(0, 25).map((s) => ({ type: s.type, at: r3(s.at) })),
        changes: (edl.changes ?? []).slice(0, 20).map((c) => ({ kind: c.kind, label: clip(c.label, 120), why: clip(c.why, 300), evidence: c.evidence })),
        expectedEffect: clip(edl.expectedEffect, 400),
    };
    return { ok: true, issues: [], plan };
}
