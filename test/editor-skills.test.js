import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEdl } from '../src/service/editor/edl.js';
import { buildRenderProps, sanitizeEdits } from '../src/service/editor/compose.js';
import { buildCutCandidates } from '../src/service/editor/cut-candidates.js';
import { buildPlannerContent } from '../src/service/editor/edit-planner.service.js';
import { SKILLS, casualCase, hookLines, isSkill } from '../src/service/editor/skills.js';

const words = [
    { w: 'Today', start: 0.4, end: 0.7 },
    { w: 'I', start: 0.75, end: 0.8 },
    { w: 'built', start: 0.85, end: 1.1 },
    { w: 'an', start: 1.15, end: 1.2 },
    { w: 'AI', start: 1.25, end: 1.5 },
    { w: 'editor.', start: 1.55, end: 2.9 },
    { w: '—', start: 2.95, end: 3.0 },
    { w: 'It', start: 3.1, end: 3.2 },
    { w: 'cuts', start: 3.25, end: 3.5 },
    { w: 'everything', start: 3.55, end: 4.0 },
    { w: 'on', start: 4.05, end: 4.1 },
    { w: 'YouTube.', start: 4.15, end: 4.7 },
];
const durationSec = 6;
const cutCandidates = buildCutCandidates({ words, durationSec });
const ctx = { durationSec, wordCount: words.length, candidateIds: cutCandidates.map((c) => c.id), candidateRanges: Object.fromEntries(cutCandidates.map((c) => [c.id, c])), trackIds: ['t1'] };
const rawPlan = () => ({
    summary: 'Tight cut with a text hook.',
    hookStrategy: 'Promise the editor up front.',
    segments: [{ id: 's1', start: 0.3, end: 4.8, role: 'hook', reason: 'all of it' }],
    acceptedCandidateIds: [],
    captions: { preset: 'impact', emphasisWordIdx: [4] },
    hookOverlay: { enabled: true, text: 'I built an AI editor / that cuts for you', durationSec: 3 },
    zooms: [],
    graphics: [
        { type: 'slam', start: 1.2, end: 2.2, text: 'AI', subtext: '', items: [], focusX: 0.5, focusY: 0.5 },
        { type: 'headline', start: 3.2, end: 4.4, text: 'Cuts everything', subtext: '', items: [], focusX: 0.5, focusY: 0.5 },
    ],
    transitions: { style: 'glitch', jumpCutZoom: false },
    framing: { mode: 'fill', focusX: 0.5 },
    music: { trackId: 't1', volume: 0.5, reason: 'bed' },
    sfx: [],
    changes: [],
    expectedEffect: 'Clearer opening.',
});
const plan = () => validateEdl(rawPlan(), ctx).plan;
const media = (skill) => ({ words, silences: [], durationSec, cutCandidates, skill });

test('skill registry and helpers', () => {
    assert.equal(isSkill('remotion-reel'), true);
    assert.equal(isSkill('nope'), false);
    assert.match(SKILLS['remotion-reel'].plannerRules, /text hook/i);
    assert.equal(casualCase('Today'), 'today');
    assert.equal(casualCase('I'), 'I');
    assert.equal(casualCase('AI,'), 'AI,');
    assert.equal(casualCase('YouTube.'), 'YouTube.');
    assert.equal(casualCase('NASA'), 'NASA');
    assert.deepEqual(hookLines('How to start content / if you\'re shy'), ['How to start content', 'if you\'re shy']);
    assert.deepEqual(hookLines('Short hook'), ['Short hook']);
    assert.deepEqual(hookLines('This is a much longer hook line that needs a break'), ['This is a much longer hook', 'line that needs a break']);
});

test('without a skill nothing changes', () => {
    const props = buildRenderProps(plan(), {}, media(null));
    assert.equal(props.skill, undefined);
    assert.ok(props.graphics.some((g) => g.type === 'slam'));
    assert.equal(props.transitions.length >= 0, true);
    assert.ok(props.sfx.some((s) => s.type === 'hit' && s.frame === 0), 'the standard hook lands with a hit');
});

test('Remotion Reel: casual captions that never linger, text hook lines, no slam, quiet music, whip transitions', () => {
    const props = buildRenderProps(plan(), { hookVariant: 'black' }, media('remotion-reel'));
    assert.deepEqual(props.skill, { id: 'remotion-reel', version: 1, hookVariant: 'black', hookLines: ['I built an AI editor', 'that cuts for you'] });
    const text = props.captions.pages.flatMap((p) => p.words.map((w) => w.text));
    assert.equal(text[0], 'today', 'casual lowercase');
    assert.ok(text.includes('I') && text.includes('AI') && text.includes('YouTube.'), 'I, acronyms and names keep their capitals');
    assert.ok(!text.includes('—'), 'stray punctuation is not a caption word');
    for (const p of props.captions.pages) {
        assert.ok(p.words.length <= 3);
        assert.ok(p.words.map((w) => w.text).join(' ').length <= 17);
    }
    // "editor." runs 1.55-2.9 s: its line ends at most 0.55 s after the word starts (+0.1 s), not at 2.9 s.
    const editorPage = props.captions.pages.find((p) => p.words.some((w) => w.text === 'editor.'));
    assert.ok(editorPage.endFrame <= Math.round((1.55 - 0.3 + 0.55 + 0.1) * 30) + 1, `ended at ${editorPage.endFrame}`);
    const pages = props.captions.pages;
    for (let k = 1; k < pages.length; k += 1) assert.ok(pages[k - 1].endFrame <= pages[k].startFrame, 'lines never overlap');
    assert.ok(!props.graphics.some((g) => g.type === 'slam'), 'stamp text is out for this style');
    assert.ok(props.graphics.some((g) => g.type === 'headline'));
    assert.ok(props.transitions.every((t) => t.type === 'whip'));
    assert.equal(props.music.volume, 0.2, 'music sits well under the voice');
    assert.equal(buildRenderProps(plan(), { musicVolume: 0.4 }, media('remotion-reel')).music.volume, 0.4, 'the creator\'s own level wins');
    assert.ok(!props.sfx.some((s) => s.type === 'hit' && s.frame === 0), 'the hook is a still sticker: no hit');
});

test('hook variant is an edit the creator can change; the planner gets the skill rules', () => {
    assert.equal(sanitizeEdits({ hookVariant: 'plain' }).hookVariant, 'plain');
    assert.equal(sanitizeEdits({ hookVariant: 'neon' }).hookVariant, undefined);
    const project = { source: { durationSec: 6, width: 1080, height: 1920 }, media: { words, cutCandidates }, skill: 'remotion-reel' };
    const content = buildPlannerContent({ project, profile: {}, knowledgeText: '', exemplarText: '', trackText: '', sheets: [] });
    assert.ok(content.some((c) => c.type === 'text' && /EDITING SKILL: REMOTION REEL/.test(c.text)));
    const plain = buildPlannerContent({ project: { ...project, skill: null }, profile: {}, knowledgeText: '', exemplarText: '', trackText: '', sheets: [] });
    assert.ok(!plain.some((c) => c.type === 'text' && /EDITING SKILL/.test(c.text)));
});

const STYLE_IDS = ['glow-sketch', 'comic-art', 'brick-build', 'pixel-art', 'chalkboard', 'retro-3d', 'flat-vector', 'minimal-line', 'cgi-motion', 'explainer-3d', 'watercolour', 'roman-mosaic', 'sumi-e', 'impasto-oil', 'nocturne-gouache', 'botanical-plate', 'paper-cut', 'art-nouveau', 'golden-hour', 'painted-anime'];

test('every style (the twenty hand-made ones and the library) is a skill with planner rules, render rules and built-in sounds only', async () => {
    const { ANIMATION_STYLE_IDS, isAnimationStyle } = await import('../src/service/editor/skills.js');
    const { SFX_TYPES } = await import('../src/service/editor/edl.js');
    const { STYLE_LIBRARY } = await import('../src/service/editor/skills.js');
    assert.deepEqual([...ANIMATION_STYLE_IDS], [...STYLE_IDS, ...STYLE_LIBRARY.map((e) => e.id)], 'ids match the composition (vireact-frontend/src/remotion/styles/ids.ts)');
    assert.equal(STYLE_LIBRARY.length, 111);
    for (const id of ANIMATION_STYLE_IDS) {
        const s = SKILLS[id];
        assert.ok(isSkill(id) && isAnimationStyle(id), id);
        assert.equal(s.kind, 'animation');
        assert.match(s.plannerRules, new RegExp(`EDITING SKILL: ${s.name.toUpperCase()} ANIMATION STYLE`));
        assert.match(s.render.accent, /^#[0-9A-F]{6}$/i);
        const sounds = [...Object.entries(s.render.sfx).filter(([k]) => k !== 'volume' && k !== 'hook').flatMap(([, v]) => v), ...(s.render.sfx.hook ? [s.render.sfx.hook] : [])];
        for (const type of sounds) assert.ok(SFX_TYPES.includes(type), `${id}: ${type} is a built-in sound`);
    }
    assert.equal(isAnimationStyle('remotion-reel'), false);
    assert.ok(!/lego|ps2|playstation|ghibli|hd-2d|backrooms|dan koe|zackd|clawd|reuters/i.test(ANIMATION_STYLE_IDS.map((id) => `${SKILLS[id].name} ${SKILLS[id].plannerRules}`).join(' ')), 'no trademarked or creator names');
});

test('an animation style sets the palette, its sounds and captions, and keeps the plan\'s structure', () => {
    const standard = buildRenderProps(plan(), {}, media(null));
    const pixel = buildRenderProps(plan(), {}, media('pixel-art'));
    assert.equal(pixel.skill.id, 'pixel-art');
    assert.deepEqual(pixel.skill.hookLines, ['I built an AI editor', 'that cuts for you']);
    assert.equal(pixel.look.accent, SKILLS['pixel-art'].render.accent);
    assert.equal(pixel.look.grade, 'none');
    assert.equal(pixel.durationInFrames, standard.durationInFrames, 'the cut is the same');
    assert.deepEqual(pixel.timeline, standard.timeline);
    assert.ok(pixel.sfx.some((s) => s.type === 'power_up' && s.frame === 0), 'the hook lands with the style\'s sound');
    assert.ok(!pixel.sfx.some((s) => s.type === 'hit' && s.frame === 0));
    for (const p of pixel.captions.pages) assert.ok(p.words.length <= 2, 'pixel type is wide: 2 words a line');
    // Graphics take the style's sounds.
    const slamSound = pixel.sfx.find((s) => s.frame === pixel.graphics.find((g) => g.type === 'slam')?.startFrame);
    assert.ok(slamSound && SKILLS['pixel-art'].render.sfx.slam.includes(slamSound.type), JSON.stringify(slamSound));

    const minimal = buildRenderProps(plan(), {}, media('minimal-line'));
    assert.ok(!minimal.graphics.some((g) => g.type === 'slam'), 'no slams in Minimal Line');
    assert.ok(!minimal.sfx.some((s) => s.frame === 0 && s.type === 'hit'), 'a quiet hook');
    assert.equal(minimal.captions.pages[0].words[0].text, 'today', 'casual lowercase');
    const standardVol = Math.max(...standard.sfx.map((s) => s.volume));
    assert.ok(Math.max(...minimal.sfx.map((s) => s.volume)) < standardVol, 'softer sounds');
});

test('an animation-style edit can switch to another style; other edits cannot', () => {
    assert.equal(sanitizeEdits({ animationStyle: 'comic-art' }).animationStyle, 'comic-art');
    assert.equal(sanitizeEdits({ animationStyle: 'remotion-reel' }).animationStyle, undefined);
    assert.equal(sanitizeEdits({ animationStyle: 'nope' }).animationStyle, undefined);
    const switched = buildRenderProps(plan(), { animationStyle: 'comic-art' }, media('pixel-art'));
    assert.equal(switched.skill.id, 'comic-art');
    assert.equal(switched.look.accent, SKILLS['comic-art'].render.accent);
    assert.equal(buildRenderProps(plan(), { animationStyle: 'comic-art' }, media('remotion-reel')).skill.id, 'remotion-reel');
    assert.equal(buildRenderProps(plan(), { animationStyle: 'comic-art' }, media(null)).skill, undefined);
    // The planner follows the style the edit is in now.
    const project = { source: { durationSec: 6, width: 1080, height: 1920 }, media: { words, cutCandidates }, skill: 'pixel-art', edits: { animationStyle: 'chalkboard' } };
    const content = buildPlannerContent({ project, profile: {}, knowledgeText: '', exemplarText: '', trackText: '', sheets: [] });
    assert.ok(content.some((c) => c.type === 'text' && /EDITING SKILL: CHALKBOARD ANIMATION STYLE/.test(c.text)));
});

test('styles are grouped by what they are for; storytelling styles paint a scene the creator can turn off', async () => {
    const { styleCategory } = await import('../src/service/editor/skills.js');
    assert.equal(styleCategory('chalkboard'), 'talking-head');
    assert.equal(styleCategory('pixel-art'), 'any-footage');
    assert.equal(styleCategory('watercolour'), 'storytelling');
    assert.equal(SKILLS['sumi-e'].category, 'storytelling');
    assert.match(SKILLS['sumi-e'].plannerRules, /ANIMATED STORYTELLING/);
    assert.doesNotMatch(SKILLS['pixel-art'].plannerRules, /ANIMATED STORYTELLING/);

    const withCallout = () => {
        const p = plan();
        p.graphics.push({ type: 'callout', start: 3.3, end: 4.3, text: 'Look', subtext: '', items: [], focusX: 0.5, focusY: 0.4 });
        return p;
    };
    const story = buildRenderProps(withCallout(), {}, media('watercolour'), { density: null });
    assert.equal(story.skill.layout, 'scene');
    assert.ok(!story.graphics.some((g) => g.type === 'callout'), 'no callouts over a painted scene');
    const footage = buildRenderProps(withCallout(), sanitizeEdits({ sceneOff: true }), media('watercolour'), { density: null });
    assert.equal(footage.skill.layout, 'footage');
    assert.ok(footage.graphics.some((g) => g.type === 'callout'));
    assert.equal(buildRenderProps(plan(), {}, media('pixel-art')).skill.layout, 'footage');
    assert.equal(buildRenderProps(plan(), {}, media('remotion-reel')).skill.layout, undefined);
    // Switching a story to a non-story style shows the footage.
    assert.equal(buildRenderProps(plan(), { animationStyle: 'comic-art' }, media('watercolour')).skill.layout, 'footage');
});

test('library styles: scene layouts for storytelling and explainers, explainer rules, sound palettes', async () => {
    const { STYLE_LIBRARY, SFX_PALETTES, styleLayout } = await import('../src/service/editor/skills.js');
    for (const e of STYLE_LIBRARY) {
        const s = SKILLS[e.id];
        assert.ok(SFX_PALETTES[e.sfx], `${e.id}: palette ${e.sfx}`);
        assert.equal(s.render.accent, e.accent);
        assert.equal(s.category, e.category);
        assert.equal(styleLayout(e.id), e.layout);
        assert.equal(s.render.layout, e.layout === 'story' || e.layout === 'explainer' ? 'scene' : 'footage', e.id);
        if (e.layout === 'explainer') assert.match(s.plannerRules, /EXPLAINER: the style draws its own scene/);
        if (e.layout === 'story') assert.match(s.plannerRules, /ANIMATED STORYTELLING/);
    }
    // An explainer edit shows its scene (the creator in a bubble) and drops callouts like storytelling does.
    const p = plan();
    p.graphics.push({ type: 'callout', start: 3.3, end: 4.3, text: 'Look', subtext: '', items: [], focusX: 0.5, focusY: 0.4 });
    const props = buildRenderProps(p, {}, media('blueprint'), { density: null });
    assert.equal(props.skill.layout, 'scene');
    assert.ok(!props.graphics.some((g) => g.type === 'callout'));
    assert.equal(buildRenderProps(plan(), {}, media('microscope')).skill.layout, 'footage');
});

test('chart graphic: bars from "label: value" items, top area, a sound per bar', () => {
    const withChart = validateEdl({
        ...JSON.parse(JSON.stringify(rawPlan())),
        graphics: [{ type: 'chart', start: 1.0, end: 4.5, text: 'Revenue by year', subtext: '', items: '2023: $1.2M | 2024: $2.6M | 2025: $4.4M', focusX: 0.5, focusY: 0.5 }],
    }, ctx);
    assert.ok(withChart.ok, withChart.issues.join('; '));
    const g = withChart.plan.graphics.find((x) => x.type === 'chart');
    assert.deepEqual(g.items, ['2023: $1.2M', '2024: $2.6M', '2025: $4.4M']);
    const props = buildRenderProps(withChart.plan, {}, media('coin-stacks'), { density: null });
    const chart = props.graphics.find((x) => x.type === 'chart');
    assert.ok(chart, 'chart kept');
    const bars = props.sfx.filter((x) => x.frame >= chart.startFrame + 9 && x.frame <= chart.startFrame + 36);
    assert.ok(bars.length >= 2, 'bar sounds');
    // A chart with fewer than two numbers is not worth showing.
    const empty = validateEdl({ ...JSON.parse(JSON.stringify(rawPlan())), graphics: [{ type: 'chart', start: 1, end: 4, text: 'x', subtext: '', items: 'a | b', focusX: 0.5, focusY: 0.5 }] }, ctx);
    assert.ok(!empty.plan.graphics.some((x) => x.type === 'chart'));
});
