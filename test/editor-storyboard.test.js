import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRenderProps } from '../src/service/editor/compose.js';
import {
    BACKDROP_IDS, STORYBOARD_OPTIONS, STORYBOARD_SCHEMA, buildStoryboardEdit, decorateStoryboardProps, drawsOwnScene, generateStoryboards, normalizeOption,
} from '../src/service/editor/storyboard.service.js';

const rawOption = (extra = {}) => ({
    title: 'The fox who saved the forest',
    logline: 'A tiny fox outsmarts a wildfire.',
    angle: 'a bedtime story',
    mood: 'inspiring',
    musicTrackId: 't1',
    scenes: [
        { narration: 'Deep in the forest lived a small red fox named Ember.', backdrop: 'nature', emphasis: 'Ember', graphicType: 'visual', graphicText: '', graphicSubtext: '', graphicItems: 'plant' },
        { narration: 'One dry summer, smoke rose over the hills. Everyone ran.', backdrop: 'city-night', emphasis: 'smoke', graphicType: 'counter', graphicText: '3 days', graphicSubtext: 'without rain', graphicItems: '' },
        { narration: 'Too short', backdrop: 'nature', emphasis: '', graphicType: 'none', graphicText: '', graphicSubtext: '', graphicItems: '' },
        { narration: 'Ember dug a trench, then another, then ten more.', backdrop: 'volcano', emphasis: 'trench', graphicType: 'cta', graphicText: 'Follow', graphicSubtext: '', graphicItems: '' },
        { narration: 'The fire stopped at her line. The forest lived.', backdrop: 'ocean', emphasis: 'lived', graphicType: 'chart', graphicText: 'Trees saved', graphicSubtext: '', graphicItems: 'before | after' },
        { narration: 'And every spring the fox comes back to see it bloom.', backdrop: 'nature', emphasis: '', graphicType: 'cta', graphicText: 'Follow for part 2', graphicSubtext: '', graphicItems: '' },
    ],
    ...extra,
});

const media = (built, skill) => ({ words: built.words, silences: [], cutCandidates: [], durationSec: built.durationSec, skill });

test('storyboard options are cleaned: short scenes dropped, backdrops checked, one closing ask at the end, charts need numbers', () => {
    const o = normalizeOption(rawOption(), 'glow-sketch');
    assert.equal(o.scenes.length, 5, 'the 2-word scene is dropped');
    assert.deepEqual(o.scenes.map((s) => s.backdrop), ['nature', 'city-night', 'abstract', 'ocean', 'nature']);
    assert.equal(o.scenes[0].graphic.type, 'visual');
    assert.equal(o.scenes[0].graphic.visual, 'plant');
    assert.equal(o.scenes[2].graphic.type, 'pill', 'a closing ask before the last scene becomes a label');
    assert.equal(o.scenes[3].graphic, null, 'a chart without numbers is dropped');
    assert.equal(o.scenes[4].graphic.type, 'cta');
    // Styles that paint their own world ignore backdrops.
    assert.ok(drawsOwnScene('watercolour') && drawsOwnScene('blueprint') && !drawsOwnScene('glow-sketch') && !drawsOwnScene('microscope'));
    assert.ok(normalizeOption(rawOption(), 'watercolour').scenes.every((s) => s.backdrop === 'scene'));
    // Promises are taken out of anything the creator will see.
    assert.doesNotMatch(normalizeOption(rawOption({ title: 'This will go viral' }), 'glow-sketch').title, /viral/i);
    assert.ok(BACKDROP_IDS.includes('space') && BACKDROP_IDS.length === 12);
    assert.ok(JSON.stringify(STORYBOARD_SCHEMA).length < 1500, 'schema stays small');
});

test('a confirmed storyboard becomes a clean timeline: scenes back to back, words in order, graphics inside their scene', () => {
    const o = normalizeOption(rawOption(), 'glow-sketch');
    const built = buildStoryboardEdit(o, { trackIds: new Set(['t1']) });
    // Words never overlap and only move forward.
    for (let i = 1; i < built.words.length; i += 1) assert.ok(built.words[i].start >= built.words[i - 1].end, `word ${i}`);
    // Scenes are contiguous and cover the video.
    assert.equal(built.timing[0].start, 0);
    for (let k = 1; k < built.timing.length; k += 1) assert.equal(built.timing[k].start, built.timing[k - 1].end);
    assert.ok(built.durationSec >= built.timing.at(-1).end);
    for (const s of built.timing) assert.ok(s.end - s.start >= 3.2);
    // The title opens the video; the first graphic waits for it.
    assert.equal(built.plan.hookOverlay.text, o.title);
    assert.ok(built.plan.graphics[0].start >= built.plan.hookOverlay.durationSec);
    for (const g of built.plan.graphics) {
        const scene = built.timing.find((s) => g.start >= s.start && g.start < s.end);
        assert.ok(scene && g.end <= scene.end, `${g.type} stays in its scene`);
    }
    assert.equal(built.plan.segments.length, 1, 'nothing is cut');
    assert.equal(built.plan.music.trackId, 't1');
    assert.ok(built.plan.captions.emphasisWordIdx.length >= 3);
});

test('storyboard render props: a scene per storyboard scene, transitions with sound on every change, music that never ducks', () => {
    for (const style of ['glow-sketch', 'watercolour', 'blueprint', 'microscope']) {
        const o = normalizeOption(rawOption(), style);
        const built = buildStoryboardEdit(o, { trackIds: new Set(['t1']) });
        const project = { kind: 'storyboard', skill: style, storyboard: { final: { ...o, timing: built.timing } } };
        const props = decorateStoryboardProps(buildRenderProps(built.plan, {}, media(built, style), { density: null }), project, {});
        assert.equal(props.videoUrl, '');
        assert.equal(props.storyboard.scenes.length, o.scenes.length);
        assert.equal(props.storyboard.scenes[0].startFrame, 0);
        const last = props.storyboard.scenes.at(-1);
        assert.equal(last.startFrame + last.durationFrames, props.durationInFrames, 'the scenes fill the video');
        assert.deepEqual(props.transitions.map((t) => t.frame), props.storyboard.scenes.slice(1).map((s) => s.startFrame));
        for (const t of props.transitions) assert.ok(props.sfx.some((s) => Math.abs(s.frame - (t.frame - 3)) <= 1), 'a sound on each transition');
        assert.deepEqual(props.music.duck, []);
        assert.equal(props.skill.layout, drawsOwnScene(style) ? 'scene' : 'footage', style);
        assert.ok(props.captions.pages.length > 5);
        assert.ok(props.graphics.length >= 3, 'every graphic is kept (no density thinning)');
        // Switched-off layers stay off.
        const quiet = decorateStoryboardProps(buildRenderProps(built.plan, { transitionsOff: true, sfxOff: true }, media(built, style), { density: null }), project, { transitionsOff: true, sfxOff: true });
        assert.equal(quiet.transitions.length, 0);
        assert.equal(quiet.sfx.length, 0);
    }
});

test('Claude writes exactly three storyboards; too few usable ones are asked for again', async () => {
    const calls = [];
    const three = { options: [rawOption(), rawOption({ title: 'Two' }), rawOption({ title: 'Three' }), rawOption({ title: 'Four' })] };
    const res = await generateStoryboards({ prompt: 'A fox saves a forest', styleId: 'glow-sketch', lengthSec: 30, tracks: [{ slug: 't1', title: 'Rise', mood: 'inspiring' }] }, {
        request: async (p) => {
            calls.push(p);
            return { data: calls.length === 1 ? { options: [rawOption()] } : three, generationId: 'g1' };
        },
    });
    assert.equal(calls.length, 2, 'retried once');
    assert.equal(res.options.length, STORYBOARD_OPTIONS);
    assert.equal(res.options[0].musicTrackId, 't1');
    assert.match(calls[0].system, /EXACTLY 3 storyboard options/);
    assert.match(calls[0].system, /Glow Sketch/);
    assert.match(calls[1].messages[0].content, /did not have 3 usable options/);
    // A note asks for three new ones, showing the previous titles.
    const again = [];
    await generateStoryboards({ prompt: 'A fox', styleId: 'watercolour', lengthSec: 15, tracks: [], note: 'funnier', previous: res.options }, { request: async (p) => (again.push(p), { data: three }) });
    assert.match(again[0].messages[0].content, /funnier/);
    assert.match(again[0].system, /"scene"/);
    // Unknown tracks fall back to the library (or none).
    assert.equal(res.options[1].musicTrackId, 't1');
    await assert.rejects(generateStoryboards({ prompt: 'x', styleId: 'glow-sketch', lengthSec: 30 }, { request: async () => ({ data: { options: [] } }) }));
});
