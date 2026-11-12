import test from 'node:test';
import assert from 'node:assert/strict';
import { EDL_SCHEMA, validateEdl } from '../src/service/editor/edl.js';
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
