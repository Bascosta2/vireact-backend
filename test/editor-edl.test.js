import test from 'node:test';
import assert from 'node:assert/strict';
import * as edlModule from '../src/service/editor/edl.js';
const { EDL_SCHEMA, validateEdl } = edlModule;
import { buildRenderProps, sanitizeEdits } from '../src/service/editor/compose.js';
import { buildCutCandidates } from '../src/service/editor/cut-candidates.js';

const words = [
    { w: 'Um', start: 1.0, end: 1.2 },
    { w: 'today', start: 2.0, end: 2.4 },
    { w: 'I', start: 2.45, end: 2.5 },
    { w: 'want', start: 2.55, end: 2.8 },
    { w: 'to', start: 3.8, end: 3.9 },
    { w: 'show', start: 3.95, end: 4.2 },
    { w: 'you', start: 4.25, end: 4.4 },
    { w: 'this', start: 6.0, end: 6.3 },
    { w: 'trick.', start: 6.35, end: 6.9 },
];
const durationSec = 12;
const cutCandidates = buildCutCandidates({ words, durationSec });
const ctx = {
    durationSec,
    wordCount: words.length,
    candidateIds: cutCandidates.map((c) => c.id),
    candidateRanges: Object.fromEntries(cutCandidates.map((c) => [c.id, c])),
    trackIds: ['t_upbeat'],
};

const good = () => ({
    summary: 'Opens on the payoff, removes dead air and filler, adds bold captions.',
    hookStrategy: 'Lead with "this trick" so the payoff is promised in the first second.',
    segments: [
        { id: 's1', start: 5.9, end: 7.0, role: 'hook', reason: 'strongest line' },
        { id: 's2', start: 1.9, end: 4.5, role: 'body', reason: 'setup' },
    ],
    acceptedCandidateIds: cutCandidates.filter((c) => c.kind === 'filler' || c.kind === 'dead_start').map((c) => c.id),
    captions: { preset: 'bold_pop', emphasisWordIdx: [8, 99] },
    hookOverlay: { enabled: true, text: 'This trick changed everything', durationSec: 5 },
    zooms: [{ at: 6.0, duration: 0.8, scale: 1.6, focusX: 0.5, focusY: 0.4, reason: 'punch in on payoff' }, { at: 9.0, duration: 1, scale: 1.2, focusX: 0.5, focusY: 0.5, reason: 'cut moment' }],
    textOverlays: [{ start: 2.0, end: 3.0, text: 'Step 1', position: 'top' }],
    framing: { mode: 'fill', focusX: 0.5 },
    music: { trackId: 't_upbeat', volume: 0.9, reason: 'energy' },
    sfx: [{ type: 'whoosh', at: 2.0 }, { type: 'pop', at: 10 }],
    changes: [{ kind: 'reorder', label: 'Moved the payoff to the start', why: 'Viral examples in this niche open on the result.', evidence: 'viral_example' }],
    expectedEffect: 'A faster first second should hold more viewers past the hook.',
});

test('EDL schema is strict everywhere (all objects closed and fully required)', () => {
    const walk = (s) => {
        if (s.type === 'object') {
            assert.equal(s.additionalProperties, false);
            assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
            Object.values(s.properties).forEach(walk);
        }
        if (s.type === 'array') walk(s.items);
    };
    walk(EDL_SCHEMA);
});

test('validateEdl accepts a good plan and normalizes it', () => {
    const { ok, plan, issues } = validateEdl(good(), ctx);
    assert.equal(ok, true, issues.join('; '));
    assert.deepEqual(plan.captions.emphasisWordIdx, [8], 'out-of-range word index dropped');
    assert.equal(plan.zooms.length, 1, 'zoom on a cut moment dropped');
    assert.equal(plan.zooms[0].scale, 1.35, 'zoom scale clamped');
    assert.equal(plan.hookOverlay.durationSec, 3, 'hook overlay clamped to 3 s');
    assert.equal(plan.music.volume, 0.6);
    assert.deepEqual(plan.sfx.map((s) => s.type), ['whoosh']);
});

test('validateEdl sends structural problems back with clear issues', () => {
    const overlap = good();
    overlap.segments[1].end = 6.5;
    assert.match(validateEdl(overlap, ctx).issues.join(), /overlap/);

    const outside = good();
    outside.segments[0].end = 30;
    assert.match(validateEdl(outside, ctx).issues.join(), /outside the video/);

    const unknown = good();
    unknown.acceptedCandidateIds.push('c999');
    assert.match(validateEdl(unknown, ctx).issues.join(), /unknown ids/);

    const track = good();
    track.music.trackId = 'made_up';
    assert.match(validateEdl(track, ctx).issues.join(), /sound library/);

    const promise = good();
    promise.expectedEffect = 'This will go viral.';
    assert.match(validateEdl(promise, ctx).issues.join(), /promises/);

    const tiny = good();
    tiny.segments = [{ id: 's1', start: 6.0, end: 6.9, role: 'hook', reason: '' }];
    assert.match(validateEdl(tiny, ctx).issues.join(), /only .*s long/);

    assert.equal(validateEdl(null, ctx).ok, false);
});

test('buildRenderProps: hook plays first, captions skip cut words, music ducks under speech', () => {
    const { plan } = validateEdl(good(), ctx);
    const media = { words, silences: [], durationSec, cutCandidates };
    const props = buildRenderProps(plan, {}, media);
    assert.equal(props.width, 1080);
    assert.equal(props.height, 1920);
    assert.equal(props.timeline[0].segId, 's1');
    assert.equal(props.durationInFrames, props.timeline.reduce((n, p) => n + p.durationFrames, 0));
    const captionText = props.captions.pages.flatMap((p) => p.words.map((w) => w.text));
    assert.ok(!captionText.includes('Um'));
    assert.equal(captionText[0], 'this', 'first caption is the hook line');
    assert.ok(props.hook && props.hook.startFrame === 0);
    assert.ok(props.music && props.music.duck.length > 0);
    assert.equal(props.zooms.length, 1);
    assert.ok(props.zooms[0].startFrame < 15, 'payoff zoom lands at the start of the output');
});

test('buildRenderProps applies the creator review changes', () => {
    const { plan } = validateEdl(good(), ctx);
    const media = { words, silences: [], durationSec, cutCandidates };
    const base = buildRenderProps(plan, {}, media);
    const edits = sanitizeEdits({
        keepOriginalOrder: true,
        restoredCandidates: plan.acceptedCandidateIds,
        captionPreset: 'karaoke',
        captionText: { 5: 'SHOW', 999: 'x' },
        hookOverlayOff: true,
        zoomsOff: true,
        musicTrackId: 'none',
        sfxOff: true,
        junk: 'ignored',
    }, { wordCount: words.length, trackIds: new Set(['t_upbeat']) });
    assert.deepEqual(Object.keys(edits).sort(), ['captionPreset', 'captionText', 'hookOverlayOff', 'keepOriginalOrder', 'musicTrackId', 'restoredCandidates', 'sfxOff', 'zoomsOff']);
    assert.deepEqual(edits.captionText, { 5: 'SHOW' });

    const props = buildRenderProps(plan, edits, media);
    assert.equal(props.timeline[0].segId, 's2', 'original order restored');
    assert.equal(props.durationInFrames, base.durationInFrames, 'reordering keeps the length');
    const withoutHook = buildRenderProps(plan, sanitizeEdits({ disabledSegments: ['s1'] }), media);
    assert.ok(withoutHook.durationInFrames < base.durationInFrames, 'removing a segment shortens the edit');
    assert.equal(withoutHook.timeline[0].segId, 's2');
    assert.equal(props.captions.preset, 'karaoke');
    assert.ok(props.captions.pages.flatMap((p) => p.words).some((w) => w.text === 'SHOW'));
    assert.equal(props.hook, null);
    assert.deepEqual(props.zooms, []);
    assert.equal(props.music, null);
    assert.deepEqual(props.sfx, []);
});

const rich = () => ({
    ...good(),
    segments: [
        { id: 's1', start: 5.9, end: 7.0, role: 'hook', reason: 'strongest line' },
        { id: 's2', start: 1.25, end: 4.5, role: 'body', reason: 'setup' },
    ],
    // The pause between "want" and "to" (2.85-3.75) is cut, so s2 plays as two pieces.
    acceptedCandidateIds: cutCandidates.filter((c) => c.kind === 'silence' && c.start > 2.8 && c.end < 3.8).map((c) => c.id),
    graphics: [
        { type: 'slam', start: 6.6, end: 6.8, text: 'THIS TRICK', subtext: '', items: [], focusX: 0.5, focusY: 0.5 },
        { type: 'list', start: 2.0, end: 2.5, text: 'Steps', subtext: '', items: ['Film', 'Cut', 'Post', ''], focusX: 0.5, focusY: 0.5 },
        { type: 'counter', start: 3.9, end: 6.0, text: '$10,000', subtext: 'in a month', items: [], focusX: 0.5, focusY: 0.5 },
        { type: 'pill', start: 9.0, end: 10, text: 'cut moment', subtext: '', items: [], focusX: 0.5, focusY: 0.5 },
        { type: 'callout', start: 2.1, end: 3, text: '', subtext: '', items: [], focusX: 0.4, focusY: 0.3 },
    ],
    transitions: { style: 'whip', jumpCutZoom: true },
    effects: [{ type: 'shake', at: 6.62 }, { type: 'flash', at: 11 }],
    look: { grade: 'warm', accent: 'pink', progressBar: true, motion: true },
    sfx: [{ type: 'riser', at: 6.0 }],
});

test('validateEdl keeps graphics with content on kept moments and gives lists time to reveal', () => {
    const { ok, plan, issues } = validateEdl(rich(), ctx);
    assert.equal(ok, true, issues.join('; '));
    assert.deepEqual(plan.graphics.map((g) => g.type), ['slam', 'list', 'counter'], 'cut-moment pill and empty callout dropped');
    const list = plan.graphics.find((g) => g.type === 'list');
    assert.deepEqual(list.items, ['Film', 'Cut', 'Post']);
    assert.ok(list.end - list.start >= 0.6 + 3 * 0.45 - 1e-9, 'list lasts long enough for every item');
    assert.ok(plan.graphics[0].end - plan.graphics[0].start >= 0.6 - 1e-9, 'slam has a minimum on-screen time');
    assert.deepEqual(plan.effects.map((e) => e.type), ['shake']);
    assert.deepEqual(plan.look, { grade: 'warm', accent: 'pink', progressBar: true, motion: true });
    assert.equal(plan.transitions.style, 'whip');

    const promise = rich();
    promise.graphics[0].text = 'GUARANTEED';
    assert.match(validateEdl(promise, ctx).issues.join(), /promises/);
});

test('buildRenderProps: transitions at segment jumps, jump-cut zooms inside a segment, sound on every beat', () => {
    const { plan } = validateEdl(rich(), ctx);
    const media = { words, silences: [], durationSec, cutCandidates };
    const props = buildRenderProps(plan, {}, media);

    // s1 then s2: one jump between segments gets the planned transition.
    assert.equal(props.transitions.length, 1);
    assert.equal(props.transitions[0].type, 'whip');
    assert.equal(props.transitions[0].frame, props.timeline.find((p) => p.segId === 's2').outStartFrame);
    // Pause cuts inside s2 alternate a slight zoom.
    const s2 = props.timeline.filter((p) => p.segId === 's2');
    assert.ok(s2.length >= 2, 'filler cuts split s2');
    assert.deepEqual(s2.slice(0, 2).map((p) => p.baseScale), [1, 1.08]);

    assert.equal(props.look.accent, '#FF4FA3');
    assert.deepEqual(props.graphics.map((g) => g.type).sort(), ['counter', 'list', 'slam']);

    const types = props.sfx.map((s) => s.type);
    assert.ok(types.includes('whoosh'), 'whip transition has a whoosh');
    assert.ok(types.includes('boom'), 'slam has a boom');
    assert.ok(types.includes('typing') && types.includes('ding'), 'counter types then dings');
    assert.ok(types.includes('riser') || types.includes('bass_drop'), 'Claude\'s own sounds are kept');
    for (let k = 1; k < props.sfx.length; k += 1) assert.ok(props.sfx[k].frame - props.sfx[k - 1].frame >= 5, 'sounds never pile up');
    assert.ok(props.sfx.every((s) => s.volume > 0 && s.volume <= 1));
});

test('buildRenderProps upgrades plans saved before graphics existed', () => {
    const { plan } = validateEdl(good(), ctx);
    const legacy = { ...plan, textOverlays: [{ start: 2.0, end: 3.0, text: 'Step 1', position: 'top' }] };
    delete legacy.graphics;
    delete legacy.transitions;
    delete legacy.effects;
    delete legacy.look;
    const props = buildRenderProps(legacy, {}, { words, silences: [], durationSec, cutCandidates });
    assert.deepEqual(props.graphics.map((g) => [g.type, g.text]), [['pill', 'Step 1']]);
    assert.equal(props.transitions[0]?.type, 'punch');
    assert.equal(props.look.grade, 'vivid');
});

test('review toggles switch off transitions, effects and graphics with their sounds', () => {
    const { plan } = validateEdl(rich(), ctx);
    const media = { words, silences: [], durationSec, cutCandidates };
    const edits = sanitizeEdits({ transitionsOff: true, effectsOff: true, overlaysOff: true });
    assert.deepEqual(edits, { overlaysOff: true, transitionsOff: true, effectsOff: true });
    const props = buildRenderProps(plan, edits, media);
    assert.deepEqual(props.transitions, []);
    assert.deepEqual(props.effects, []);
    assert.deepEqual(props.graphics, []);
    assert.ok(props.timeline.every((p) => p.baseScale === 1));
    assert.ok(!props.sfx.some((s) => ['whoosh', 'boom', 'typing'].includes(s.type)), 'no sounds for switched-off layers');
});

test('the hook card makes room for graphics at the top of the screen', () => {
    const { plan } = validateEdl({ ...rich(), hookOverlay: { enabled: true, text: 'Watch this', durationSec: 3 } }, ctx);
    const props = buildRenderProps(plan, {}, { words, silences: [], durationSec, cutCandidates });
    const top = props.graphics.filter((g) => ['pill', 'headline', 'counter', 'list'].includes(g.type));
    assert.ok(props.hook.durationFrames >= 30, 'the hook shows for at least a second');
    for (const g of top) assert.ok(g.startFrame >= props.hook.durationFrames, `${g.type} starts after the hook card`);
});

test('graphics at the top of the screen never overlap', () => {
    const { plan } = validateEdl(rich(), ctx);
    const props = buildRenderProps(plan, {}, { words, silences: [], durationSec, cutCandidates });
    const top = props.graphics.filter((g) => ['pill', 'headline', 'counter', 'list'].includes(g.type)).sort((a, b) => a.startFrame - b.startFrame);
    for (let k = 1; k < top.length; k += 1) assert.ok(top[k - 1].startFrame + top[k - 1].durationFrames <= top[k].startFrame, `${top[k - 1].type} ends before ${top[k].type}`);
});

test('EDL schema stays within Claude\'s grammar limit: no enums, no arrays inside arrays', () => {
    // "The compiled grammar is too large" failed every plan on 2026-11-13; see the note in edl.js.
    const walk = (s, insideArray = false) => {
        assert.equal(s.enum, undefined, 'allowed values belong in the description');
        if (s.type === 'array') {
            assert.equal(insideArray, false, 'array nested inside an array');
            walk(s.items, true);
        }
        if (s.type === 'object') Object.values(s.properties).forEach((p) => walk(p, insideArray));
    };
    walk(EDL_SCHEMA);
    assert.ok(JSON.stringify(EDL_SCHEMA).length < 4000, 'schema grew; test the grammar against the API before shipping');
});

test('validateEdl reads the compact style, beats and "a | b" list items', () => {
    const plan0 = rich();
    delete plan0.transitions;
    delete plan0.look;
    delete plan0.effects;
    plan0.sfx = [];
    plan0.style = { transition: 'glitch', jumpCutZoom: false, grade: 'cool', accent: 'blue', progressBar: false, motion: true };
    plan0.beats = [{ type: 'riser', at: 6.0 }, { type: 'shake', at: 6.62 }, { type: 'made_up', at: 6.7 }];
    plan0.graphics[1].items = 'Film | Cut |  | Post';
    plan0.changes = [{ kind: 'sparkles', label: 'x', why: 'y', evidence: 'vibes' }];
    const { ok, plan, issues } = validateEdl(plan0, ctx);
    assert.equal(ok, true, issues.join('; '));
    assert.deepEqual(plan.transitions, { style: 'glitch', jumpCutZoom: false });
    assert.deepEqual(plan.look, { grade: 'cool', accent: 'blue', progressBar: false, motion: true });
    assert.deepEqual(plan.sfx.map((s) => s.type), ['riser']);
    assert.deepEqual(plan.effects.map((e) => e.type), ['shake']);
    assert.deepEqual(plan.graphics.find((g) => g.type === 'list').items, ['Film', 'Cut', 'Post']);
    assert.deepEqual([plan.changes[0].kind, plan.changes[0].evidence], ['cut', 'footage'], 'unknown values fall back');
});

test('a saved plan converts back to the schema shape and validates to the same plan', () => {
    const { plan } = validateEdl(rich(), ctx);
    const { toSchemaShape } = edlModule;
    const shaped = toSchemaShape(plan);
    const keys = Object.keys(EDL_SCHEMA.properties).sort();
    assert.deepEqual(Object.keys(shaped).sort(), keys, 'every schema field, nothing else');
    const again = validateEdl(shaped, ctx);
    assert.equal(again.ok, true, again.issues.join('; '));
    for (const k of ['graphics', 'transitions', 'look', 'effects', 'sfx', 'segments', 'captions']) assert.deepEqual(again.plan[k], plan[k], k);
    // Plans saved before graphics existed convert too.
    const legacy = { ...plan, textOverlays: [{ start: 2, end: 3, text: 'Step 1', position: 'top' }] };
    for (const k of ['graphics', 'transitions', 'look', 'effects']) delete legacy[k];
    assert.equal(toSchemaShape(legacy).graphics[0].text, 'Step 1');
});
