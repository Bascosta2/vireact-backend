import test from 'node:test';
import assert from 'node:assert/strict';
import { SPLIT_ZOOM, buildRenderProps, framingFor, needsBackgroundMatte, sanitizeEdits } from '../src/service/editor/compose.js';
import { MODELS, assertFalUrl, buildFalInput, estimateCostUsd, extractVideoUrl, ledgerTotal, matteJobStore, matteKey, resetBillingLockForTests, runFalQueue, runMatteStep, spendGuard, sumLedger } from '../src/service/editor/bg-removal.service.js';
import { setStorageForTests } from '../src/lib/storage.js';
import { clampFocus, edlSchemaFor, validateEdl, validateScreens } from '../src/service/editor/edl.js';
import { buildCutCandidates } from '../src/service/editor/cut-candidates.js';
import { buildPlannerContent } from '../src/service/editor/edit-planner.service.js';
import { applyBeatSwaps, buildStoryboard, carryStoryboard, cleanSwap, storyboardBlocksExport, storyboardNote, swapBeat } from '../src/service/editor/storyboard.js';
import { BRAND_FONTS, brandProblem, SKILLS, casualCase, hookLines, isSkill, sanitizeBrand } from '../src/service/editor/skills.js';

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
const plan = () => validateEdl({
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
}, ctx).plan;
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

test('the twenty animation and painted styles are skills with planner rules, render rules and built-in sounds only', async () => {
    const { ANIMATION_STYLE_IDS, isAnimationStyle } = await import('../src/service/editor/skills.js');
    const { SFX_TYPES } = await import('../src/service/editor/edl.js');
    assert.deepEqual([...ANIMATION_STYLE_IDS], STYLE_IDS, 'ids match the composition (vireact-frontend/src/remotion/styles/ids.ts)');
    for (const id of STYLE_IDS) {
        const s = SKILLS[id];
        assert.ok(isSkill(id) && isAnimationStyle(id), id);
        assert.equal(s.kind, 'animation');
        assert.match(s.plannerRules, new RegExp(`EDITING SKILL: ${s.name.toUpperCase()} ANIMATION STYLE`));
        assert.match(s.render.accent, /^#[0-9A-F]{6}$/i);
        const sounds = [...Object.entries(s.render.sfx).filter(([k]) => k !== 'volume' && k !== 'hook').flatMap(([, v]) => v), ...(s.render.sfx.hook ? [s.render.sfx.hook] : [])];
        for (const type of sounds) assert.ok(SFX_TYPES.includes(type), `${id}: ${type} is a built-in sound`);
    }
    assert.equal(isAnimationStyle('remotion-reel'), false);
    assert.ok(!/lego|ps2|playstation|ghibli/i.test(STYLE_IDS.map((id) => `${SKILLS[id].name} ${SKILLS[id].plannerRules}`).join(' ')), 'no trademarked names');
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

test('brand sheet: only hex colors and listed fonts survive, and the accent beats a style accent', () => {
    assert.equal(sanitizeBrand(null), null);
    assert.equal(sanitizeBrand({ accent: 'red', displayFont: 'Comic Sans' }), null);
    assert.deepEqual(sanitizeBrand({ accent: '#ff5a36', secondary: '#123', displayFont: 'Anton', bodyFont: 'Inter', evil: 1 }), { accent: '#FF5A36', displayFont: 'Anton', bodyFont: 'Inter' });
    assert.ok(BRAND_FONTS.includes('Anton'));
    const branded = buildRenderProps(plan(), {}, { ...media('comic-art'), brand: { accent: '#00AAFF', displayFont: 'Anton' } });
    assert.equal(branded.look.accent, '#00AAFF');
    assert.deepEqual(branded.brand, { accent: '#00AAFF', displayFont: 'Anton' });
    // No brand: nothing changes.
    const plain = buildRenderProps(plan(), {}, media('comic-art'));
    assert.equal(plain.brand, undefined);
    assert.equal(plain.look.accent, SKILLS['comic-art'].render.accent);
});

test('brand sheet save names the first invalid field instead of dropping it', () => {
    assert.equal(brandProblem({ accent: '#FF5A36', displayFont: 'Anton' }), null);
    assert.equal(brandProblem({ accent: 'red' }), 'accent');
    assert.equal(brandProblem({ accent: '#FF5A36', bodyFont: 'Comic Sans' }), 'bodyFont');
    assert.equal(brandProblem({ evil: 1 }), 'evil');
    assert.equal(brandProblem('x'), 'brand');
});

test('split screen: only with the flag, otherwise it falls back to fill', () => {
    assert.equal(sanitizeEdits({ framingMode: 'split' }).framingMode, 'split');
    const raw = { ...plan(), framing: { mode: 'fill', focusX: 0.4, detailX: 0.7, detailY: 0.3 } };
    const on = buildRenderProps(raw, { framingMode: 'split' }, { ...media(null), v2: true });
    assert.deepEqual(on.framing, { mode: 'split', focusX: 0.4, split: { detailX: 0.7, detailY: 0.3, zoom: SPLIT_ZOOM } });
    assert.deepEqual(buildRenderProps(raw, { framingMode: 'split' }, media(null)).framing, { mode: 'fill', focusX: 0.4 });
    assert.deepEqual(buildRenderProps(raw, {}, { ...media(null), v2: true }).framing, { mode: 'fill', focusX: 0.4 });
    assert.deepEqual(framingFor('fit_blur', { focusX: 0.5 }, false), { mode: 'fit_blur', focusX: 0.5 });
    // A planned split keeps its detail point through validation.
    process.env.EDITOR_FEATURES_V2 = 'true';
    try {
        const planned = validateEdl({ ...plan(), framing: { mode: 'split', focusX: 0.5, detailX: 1.4, detailY: 0.25 } }, ctx).plan;
        assert.equal(planned.framing.mode, 'split');
        assert.equal(planned.framing.detailX, 1);
        assert.ok('detailX' in edlSchemaFor(true).properties.framing.properties);
        assert.equal(validateEdl({ ...plan(), framing: { mode: 'split', focusX: 0.5 } }, ctx).plan.framing.detailY, 0.62);
    } finally {
        delete process.env.EDITOR_FEATURES_V2;
    }
    // Flag off: the planner schema is the original one and a split plan is coerced to fill.
    assert.equal('detailX' in edlSchemaFor(false).properties.framing.properties, false);
    assert.ok(!edlSchemaFor(false).properties.framing.properties.mode.description.includes('split'));
    assert.equal(validateEdl({ ...plan(), framing: { mode: 'split', focusX: 0.5, detailX: 0.7, detailY: 0.3 } }, ctx).plan.framing.mode, 'fill');
});

test('storyboard: beats list their graphics and sounds; drop and swap change the render; flag off ignores swaps', async () => {
    const p = { ...plan(), segments: [{ id: 's1', start: 0.3, end: 2.5, role: 'hook', reason: 'open' }, { id: 's2', start: 3.0, end: 4.8, role: 'payoff', reason: 'close' }], sfx: [{ type: 'ding', at: 3.4 }] };
    const sb = buildStoryboard(p, {});
    assert.deepEqual(sb.beats.map((b) => [b.id, b.role, b.graphics.length, b.sounds.length]), [['s1', 'hook', 1, 0], ['s2', 'payoff', 1, 1]]);
    assert.equal(sb.approved, false);
    assert.equal(buildStoryboard(p, { disabledSegments: ['s2'], storyboardApproved: true }).beats[1].dropped, true);

    // A swap replaces only that beat's layers.
    const swaps = { s2: { graphics: [{ type: 'pill', start: 3.2, end: 4.0, text: 'THE CATCH', subtext: '', items: [], focusX: 0.5, focusY: 0.5 }], sfx: [{ type: 'pop', at: 3.2 }], effects: [], why: 'a label instead' } };
    const swapped = applyBeatSwaps(p, swaps);
    assert.deepEqual(swapped.graphics.map((g) => g.text), ['AI', 'THE CATCH']);
    assert.deepEqual(swapped.sfx.map((e) => e.type), ['pop']);
    assert.equal(buildStoryboard(p, { beatSwaps: swaps }).beats[1].swapped, true);
    const withFlag = buildRenderProps(p, { beatSwaps: swaps }, { ...media(null), v2: true }, { density: null });
    assert.ok(withFlag.graphics.some((g) => g.text === 'THE CATCH'));
    assert.ok(!withFlag.graphics.some((g) => g.text === 'Cuts everything'));
    assert.ok(!buildRenderProps(p, { beatSwaps: swaps }, media(null), { density: null }).graphics.some((g) => g.text === 'THE CATCH'));

    // Edits are only stored with the flag, and only for real beats.
    assert.equal('storyboardApproved' in sanitizeEdits({ storyboardApproved: true }), false);
    assert.equal(sanitizeEdits({ storyboardApproved: true }, { v2: true }).storyboardApproved, true);
    // A PATCH can never write swapped beats or their counters.
    assert.equal('beatSwaps' in sanitizeEdits({ beatSwaps: swaps, swapsUsed: 0 }, { v2: true }), false);
    assert.equal('swapsUsed' in sanitizeEdits({ swapsUsed: 0 }, { v2: true }), false);

    // The planner's alternative for one beat is cleaned against that beat's range.
    const seg = p.segments[1];
    const clean = cleanSwap({ why: 'x', graphics: [{ type: 'pill', start: 3.5, end: 4, text: 'IN', subtext: '', items: '', focusX: 0.5, focusY: 0.5 }, { type: 'pill', start: 1, end: 2, text: 'OUT', subtext: '', items: '', focusX: 0.5, focusY: 0.5 }], beats: [{ type: 'ding', at: 3.5 }, { type: 'shake', at: 3.6 }, { type: 'ding', at: 0.5 }, { type: 'nonsense', at: 3.7 }] }, seg);
    assert.deepEqual([clean.graphics.map((g) => g.text), clean.sfx.length, clean.effects.length], [['IN'], 1, 1]);
    let asked = null;
    const swap = await swapBeat({ plan: p, edits: {}, words, segmentId: 's2' }, { request: async (a) => { asked = a; return { data: { why: 'new', graphics: [], beats: [{ type: 'pop', at: 3.3 }] }, generationId: 'g1' }; } });
    assert.equal(asked.label, 'editor_beat_swap');
    assert.match(asked.messages[0].content, /BEAT s2/);
    assert.equal(await swapBeat({ plan: p, words, segmentId: 'nope' }, { request: async () => ({}) }), null);
});

test('storyboard: a regenerate keeps dropped and swapped beats and asks for approval again', () => {
    const oldPlan = { ...plan(), segments: [{ id: 's1', start: 0, end: 2, role: 'hook', reason: '' }, { id: 's2', start: 3, end: 5, role: 'body', reason: '' }, { id: 's3', start: 6, end: 8, role: 'payoff', reason: '' }] };
    const oldEdits = { disabledSegments: ['s2'], beatSwaps: { s3: { graphics: [], sfx: [], effects: [], why: 'mine' } }, storyboardApproved: true };
    const newPlan = { segments: [{ id: 's1', start: 0.1, end: 1.9, role: 'hook' }, { id: 's2', start: 3.1, end: 4.9, role: 'body' }, { id: 's3', start: 5.9, end: 8, role: 'payoff' }] };
    const kept = carryStoryboard(oldPlan, oldEdits, newPlan);
    assert.deepEqual(kept.disabledSegments, ['s2']);
    assert.deepEqual(Object.keys(kept.beatSwaps), ['s3']);
    assert.equal(kept.storyboardApproved, false);
    assert.match(storyboardNote(oldPlan, oldEdits), /DROPPED[^]*3-5s[^]*6-8s/);
    assert.equal(storyboardNote(oldPlan, {}), '');
});

test('storyboard: swap cleaning, carry rules and export gate', () => {
    const seg = { id: 's', start: 3, end: 5 };
    const g = (start, end, text) => ({ type: 'pill', start, end, text, subtext: '', items: '', focusX: 0.5, focusY: 0.5 });
    const c = cleanSwap({ graphics: [g(3.1, 9, 'A'), g(3.5, 4.5, 'OVERLAP'), g(4.6, 5.5, 'B')], beats: [{ type: 'ding', at: 3.2 }, { type: 'pop', at: 3.4 }, { type: 'ding', at: 4 }, { type: 'ding', at: 5.5 }] }, seg);
    assert.deepEqual(c.graphics.map((x) => x.text), ['A']);
    assert.ok(c.graphics.every((x) => x.end <= 5));
    assert.deepEqual(c.sfx.map((x) => x.at), [3.2, 4]);
    // Carry: a new beat covering half of a dropped one is dropped too; times follow the new beat; all dropped = none dropped.
    const oldPlan = { segments: [{ id: 'a', start: 0, end: 4 }, { id: 'b', start: 5, end: 9 }] };
    const sw = { graphics: [{ ...g(5.5, 8, 'X'), items: [] }], sfx: [{ type: 'pop', at: 8.5 }], effects: [], why: '' };
    const kept = carryStoryboard(oldPlan, { disabledSegments: ['a'], beatSwaps: { b: sw } }, { segments: [{ id: 'n1', start: 0, end: 10 }, { id: 'n2', start: 5, end: 7 }] });
    assert.deepEqual(kept.disabledSegments, ['n1']);
    assert.deepEqual([kept.beatSwaps.n2.graphics[0].end, kept.beatSwaps.n2.sfx.length], [7, 0]);
    assert.deepEqual(carryStoryboard(oldPlan, { disabledSegments: ['a', 'b'] }, { segments: [{ id: 'n1', start: 0, end: 4 }, { id: 'n2', start: 5, end: 9 }] }).disabledSegments, []);
    assert.equal(kept.storyboardApproved, false);
    // Export: only an explicit "not approved" blocks; edits from before the review keep exporting.
    assert.equal(storyboardBlocksExport({}, true), false);
    assert.equal(storyboardBlocksExport({ storyboardApproved: false }, true), true);
    assert.equal(storyboardBlocksExport({ storyboardApproved: true }, true), false);
    assert.equal(storyboardBlocksExport({ storyboardApproved: false }, false), false);
});

// ---- background removal (fal.ai) ----
const jsonRes = (body, ok = true, status = 200) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new TextEncoder().encode('matte').buffer });
const falFake = (statuses, { result = { video: [{ url: 'https://v3.fal.media/o.webm' }] } } = {}) => {
    const calls = [];
    let i = 0;
    const fetchFn = async (url, init = {}) => {
        calls.push({ url, method: init.method ?? 'GET', headers: init.headers, body: init.body });
        if (init.method === 'POST') return jsonRes({ request_id: 'r1', status_url: 'https://queue.fal.run/veed/requests/r1/status', response_url: 'https://queue.fal.run/veed/requests/r1', cancel_url: 'https://queue.fal.run/veed/requests/r1/cancel' });
        if (url.endsWith('/status')) return jsonRes(statuses[Math.min(i++, statuses.length - 1)]);
        if (url.endsWith('/cancel')) return jsonRes({});
        if (url.includes('fal.media')) return jsonRes({});
        return jsonRes(result);
    };
    return { fetchFn, calls };
};
const memStorage = (existing = []) => {
    const keys = new Set(existing);
    const log = [];
    setStorageForTests({
        head: async (k) => (keys.has(k) ? { sizeBytes: 1 } : null),
        uploadFile: async (_p, k) => { keys.add(k); log.push(['file', k]); },
        uploadBuffer: async (_b, k) => { keys.add(k); log.push(['buffer', k]); },
        presignDownload: async (k) => `https://s3/${k}?sig`,
        deleteObject: async (k) => { log.push(['del', k]); },
    });
    return log;
};
const memStore = (seed = []) => {
    const rows = [...seed];
    const ledger = [];
    const latest = (h, v) => rows.filter((r) => r.sourceHash === h && r.variant === v).pop() ?? null;
    return {
        rows,
        ledger,
        find: async (h, v) => latest(h, v),
        // Compare-and-swap on what the caller read, like the MongoDB store.
        claim: async (existing, r, usage) => {
            if (latest(r.sourceHash, r.variant) !== existing) return false;
            rows.push({ ...r });
            ledger.push({ ...usage });
            return true;
        },
        save: async (r) => { rows.push({ ...r }); },
        touch: async (r) => latest(r.sourceHash, r.variant)?.claimId === r.claimId,
        markSending: async (r) => {
            if (latest(r.sourceHash, r.variant)?.claimId !== r.claimId) return false;
            ledger.filter((u) => u.claimId === r.claimId).forEach((u) => { u.sent = true; });
            return true;
        },
        release: async (r) => { ledger.filter((u) => u.claimId === r.claimId && !u.sent).forEach((u) => { u.voided = true; }); },
    };
};
/** In-memory stand-in for the MatteJob model: unique _id on insert, rev/claimId-conditioned updates. */
const fakeMatteModel = (seed = []) => {
    const docs = new Map(seed.map((d) => [d._id, structuredClone(d)]));
    const copy = (d) => structuredClone(d);
    return {
        docs,
        findOne: (f) => ({ lean: async () => (docs.has(f._id) ? copy(docs.get(f._id)) : null) }),
        create: async (d) => {
            await null;
            if (docs.has(d._id)) throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
            docs.set(d._id, copy(d));
        },
        findOneAndUpdate: async (f, u) => {
            await null;
            const d = docs.get(f._id);
            if (!d || d.rev !== f.rev) return null;
            Object.assign(d, copy(u.$set));
            d.rev += u.$inc.rev;
            d.usage.push(copy(u.$push.usage));
            return copy(d);
        },
        updateOne: async (f, u) => {
            await null;
            const d = docs.get(f._id);
            if (!d) return { matchedCount: 0 };
            if ('claimId' in f && (d.claimId ?? null) !== f.claimId) return { matchedCount: 0 };
            const em = f.usage?.$elemMatch;
            const i = f['usage.claimId'] !== undefined ? d.usage.findIndex((x) => x.claimId === f['usage.claimId'])
                : em ? d.usage.findIndex((x) => x.claimId === em.claimId && x.sent !== true) : null;
            if (i === -1) return { matchedCount: 0 };
            for (const [k, v] of Object.entries(u.$set ?? {})) {
                if (k.startsWith('usage.$.')) d.usage[i][k.slice('usage.$.'.length)] = v;
                else d[k] = copy(v);
            }
            d.rev += u.$inc?.rev ?? 0;
            return { matchedCount: 1 };
        },
        find: () => ({ select: () => ({ lean: async () => [...docs.values()].map(copy) }) }),
    };
};
const matteDeps = (fake, extra = {}) => ({ env: { FAL_KEY: 'k', BG_REMOVAL_MODEL: 'veed' }, hash: async () => 'abc', makeProxy: async () => {}, fetchFn: fake.fetchFn, sleepFn: async () => {}, track: () => {}, report: () => {}, store: memStore(), planOf: async () => 'pro', secondsThisMonth: async () => 0, usdToday: async () => 0, ...extra });
const matteJob = { userId: 'u1', projectId: 'p1', srcPath: '/x.mp4', workDir: '/tmp', durationSec: 60 };

test('fal request building: veed and bria inputs, auth header, submit url', async () => {
    assert.deepEqual(buildFalInput('veed', 'https://v', { refine: false }), { video_url: 'https://v', output_codec: 'vp9', refine_foreground_edges: false, subject_is_person: true });
    assert.equal(buildFalInput('bria', 'https://v').background_color, 'Transparent');
    assert.equal(buildFalInput('bria', 'https://v').output_container_and_codec, 'webm_vp9');
    assert.throws(() => buildFalInput('nope', 'x'));
    const fake = falFake([{ status: 'COMPLETED' }]);
    const out = await runFalQueue({ endpoint: MODELS.veed.endpoint, input: { a: 1 }, apiKey: 'KEY', fetchFn: fake.fetchFn, sleepFn: async () => {} });
    assert.equal(fake.calls[0].url, 'https://queue.fal.run/veed/video-background-removal');
    assert.equal(fake.calls[0].headers.Authorization, 'Key KEY');
    assert.equal(extractVideoUrl(out.result), 'https://v3.fal.media/o.webm');
    assert.equal(extractVideoUrl({}), null);
});

test('fal polling waits through IN_QUEUE/IN_PROGRESS, reports failures, and times out', async () => {
    const fake = falFake([{ status: 'IN_QUEUE' }, { status: 'IN_PROGRESS' }, { status: 'COMPLETED', metrics: { inference_time: 7 } }]);
    const out = await runFalQueue({ endpoint: 'e/x', input: {}, apiKey: 'k', fetchFn: fake.fetchFn, sleepFn: async () => {} });
    assert.equal(out.inferenceSec, 7);
    const bad = falFake([{ status: 'COMPLETED', error: 'boom' }]);
    await assert.rejects(runFalQueue({ endpoint: 'e/x', input: {}, apiKey: 'k', fetchFn: bad.fetchFn, sleepFn: async () => {} }), /could not process/);
    const slow = falFake([{ status: 'IN_PROGRESS' }]);
    let t = 0;
    await assert.rejects(runFalQueue({ endpoint: 'e/x', input: {}, apiKey: 'k', fetchFn: slow.fetchFn, sleepFn: async () => { t += 1000; }, now: () => t, pollMs: 1000, timeoutMs: 3000 }), /timed out/);
    assert.ok(slow.calls.some((c) => c.method === 'PUT' && c.url.endsWith('/cancel')));
});

test('matte cache key uses source hash and model; cost estimates', () => {
    assert.equal(matteKey('u', 'h1', 'veed', { refine: true }), 'editor/mattes/u/h1/veed-refine.webm');
    assert.notEqual(matteKey('u', 'h1', 'veed', { refine: false }), matteKey('u', 'h1', 'veed', { refine: true }));
    assert.equal(matteKey('u', 'h1', 'bria'), 'editor/mattes/u/h1/bria.webm');
    assert.equal(estimateCostUsd('veed', 60, { fps: 30, refine: false }), 0.9);
    assert.equal(estimateCostUsd('veed', 60, { refine: true }), 1.35);
    assert.equal(estimateCostUsd('bria', 60), 3);
});

test('matte step: stores the result, then a cache hit makes no fal call', async () => {
    resetBillingLockForTests();
    const log = memStorage();
    const fake = falFake([{ status: 'COMPLETED' }]);
    const deps = matteDeps(fake);
    const first = await runMatteStep(matteJob, deps);
    assert.equal(first.status, 'ok');
    assert.equal(first.key, 'editor/mattes/u1/abc/veed-refine.webm');
    assert.ok(log.some(([k, key]) => k === 'buffer' && key === first.key));
    assert.match(JSON.parse(fake.calls[0].body).video_url, /^https:\/\/s3\/editor\/mattes\/u1\/abc\/input-720p-[0-9a-f-]{36}\.mp4\?sig$/, 'per-claim copy');
    assert.equal(deps.store.rows[1].requestId, 'r1', 'request id saved right after submit');
    assert.deepEqual(deps.store.ledger.map((u) => [u.seconds, u.estCostUsd, Boolean(u.voided)]), [[60, 1.35, false]], 'the run is in the usage ledger');
    const again = falFake([{ status: 'COMPLETED' }]);
    const second = await runMatteStep(matteJob, matteDeps(again));
    assert.deepEqual([second.status, second.cached], ['ok', true]);
    assert.equal(again.calls.length, 0);
    setStorageForTests(null);
});

test('matte step falls back with a plain reason: no key, too long, provider error, timeout', async () => {
    resetBillingLockForTests();
    memStorage();
    const fake = falFake([{ status: 'COMPLETED' }]);
    assert.deepEqual(await runMatteStep(matteJob, matteDeps(fake, { env: {} })), { status: 'skipped', reason: 'not_configured' });
    assert.equal((await runMatteStep({ ...matteJob, durationSec: 181 }, matteDeps(fake))).reason, 'too_long');
    const broken = { fetchFn: async () => jsonRes({}, false, 500) };
    assert.equal((await runMatteStep(matteJob, matteDeps(broken))).reason, 'provider_error');
    const slow = falFake([{ status: 'IN_PROGRESS' }]);
    let t = 0;
    const out = await runMatteStep(matteJob, matteDeps(slow, { now: () => t, sleepFn: async () => { t += 60000; }, pollMs: 1000, timeoutMs: 120000 }));
    assert.equal(out.reason, 'timeout');
    assert.ok(slow.calls.some((c) => c.url.endsWith('/cancel')), 'gave up: cancelled');
    assert.equal(fake.calls.length, 0);
    setStorageForTests(null);
});

test('re-run after a crash resumes the pending request and never submits twice', async () => {
    resetBillingLockForTests();
    memStorage();
    const pending = { status: 'pending', model: 'veed', variant: 'veed-refine', sourceHash: 'abc', requestId: 'r1', statusUrl: 'https://queue.fal.run/veed/requests/r1/status', responseUrl: 'https://queue.fal.run/veed/requests/r1', cancelUrl: 'https://queue.fal.run/veed/requests/r1/cancel', submittedAt: new Date(), seconds: 60, estCostUsd: 1.35, updatedAt: new Date() };
    const fake = falFake([{ status: 'IN_PROGRESS' }, { status: 'COMPLETED' }]);
    const out = await runMatteStep(matteJob, matteDeps(fake, { store: memStore([pending]) }));
    assert.equal(out.status, 'ok');
    assert.equal(fake.calls.filter((c) => c.method === 'POST').length, 0);
    // A failed download is retried from the response url, not a new submit.
    memStorage();
    const failedDl = { ...pending, status: 'failed', reason: 'download_failed' };
    const fake2 = falFake([{ status: 'COMPLETED' }]);
    const out2 = await runMatteStep(matteJob, matteDeps(fake2, { store: memStore([failedDl]) }));
    assert.equal(out2.status, 'ok');
    assert.equal(fake2.calls.filter((c) => c.method === 'POST').length, 0);
    assert.equal(fake2.calls.filter((c) => c.url.endsWith('/status')).length, 0);
    // A fresh claim by another job with no request id yet: do not submit.
    memStorage();
    const claim = { status: 'pending', sourceHash: 'abc', variant: 'veed-refine', requestId: null, updatedAt: new Date() };
    const fake3 = falFake([{ status: 'COMPLETED' }]);
    assert.equal((await runMatteStep(matteJob, matteDeps(fake3, { store: memStore([claim]) }))).reason, 'in_progress');
    assert.equal(fake3.calls.length, 0);
    setStorageForTests(null);
});

test('a failed matte is not retried within 24 hours', async () => {
    resetBillingLockForTests();
    memStorage();
    const failed = { status: 'failed', reason: 'timeout', sourceHash: 'abc', variant: 'veed-refine', requestId: 'r1', updatedAt: new Date() };
    const fake = falFake([{ status: 'COMPLETED' }]);
    const out = await runMatteStep(matteJob, matteDeps(fake, { store: memStore([failed]) }));
    assert.deepEqual([out.status, out.reason], ['failed', 'timeout']);
    assert.equal(fake.calls.length, 0);
    setStorageForTests(null);
});

test('fal urls must be https on fal hosts before the key is sent', async () => {
    for (const bad of ['http://queue.fal.run/x', 'https://evil.com/x', 'https://queue.fal.run.evil.com/x', 'https://evilfal.run/x', 'not a url']) assert.throws(() => assertFalUrl(bad), /untrusted/, bad);
    for (const good of ['https://queue.fal.run/a', 'https://x.fal.run/a', 'https://rest.fal.ai/a']) assert.equal(assertFalUrl(good), good);
    memStorage();
    resetBillingLockForTests();
    const sent = [];
    const fetchFn = async (url, init = {}) => {
        sent.push(url);
        if (init.method === 'POST') return jsonRes({ request_id: 'r', status_url: 'https://evil.example/status', response_url: 'https://queue.fal.run/r' });
        return jsonRes({});
    };
    const out = await runMatteStep(matteJob, matteDeps({ fetchFn }));
    assert.equal(out.reason, 'provider_error');
    assert.deepEqual(sent, ['https://queue.fal.run/veed/video-background-removal'], 'key only went to the submit endpoint');
    setStorageForTests(null);
});

test('HTTP 403 is reported as billing, reported to the owner, and pauses all background removal', async () => {
    resetBillingLockForTests();
    memStorage();
    const reported = [];
    const fetchFn = async () => jsonRes({}, false, 403);
    const out = await runMatteStep(matteJob, matteDeps({ fetchFn }, { report: (e, ctx) => reported.push(ctx.stage) }));
    assert.equal(out.reason, 'billing');
    assert.deepEqual(reported, ['bg_removal_billing']);
    const fake = falFake([{ status: 'COMPLETED' }]);
    assert.equal((await runMatteStep({ ...matteJob, userId: 'u2' }, matteDeps(fake))).reason, 'billing');
    assert.equal(fake.calls.length, 0);
    resetBillingLockForTests();
    setStorageForTests(null);
});

test('status errors after submit cancel the request', async () => {
    const fake = falFake([{ status: 'IN_PROGRESS' }]);
    const base = fake.fetchFn;
    const fetchFn = async (url, init = {}) => (url.endsWith('/status') ? jsonRes({}, false, 500) : base(url, init));
    await assert.rejects(runFalQueue({ endpoint: 'e/x', input: {}, apiKey: 'k', fetchFn, sleepFn: async () => {} }), /status failed/);
    assert.ok(fake.calls.some((c) => c.method === 'PUT' && c.url.endsWith('/cancel')));
});

test('spend guards: paid plan only, monthly seconds per user, daily USD cap', async () => {
    const ok = { planOf: async () => 'pro', secondsThisMonth: async () => 0, usdToday: async () => 0 };
    const g = (deps, env = {}) => spendGuard({ userId: 'u', durationSec: 60, estCostUsd: 1.35 }, deps, env);
    assert.equal(await g(ok), null);
    assert.equal(await g({ ...ok, planOf: async () => 'free' }), 'plan');
    assert.equal(await g({ ...ok, planOf: async () => 'premium' }), 'plan');
    assert.equal(await g({ ...ok, planOf: async () => 'premium' }, { BG_REMOVAL_PLANS: 'pro,premium' }), null);
    assert.equal(await g({ ...ok, secondsThisMonth: async () => 541 }), 'cap');
    assert.equal(await g({ ...ok, secondsThisMonth: async () => 540 }), null);
    assert.equal(await g({ ...ok, secondsThisMonth: async () => 540 }, { BG_REMOVAL_MONTHLY_SEC_PER_USER: '590' }), 'cap');
    assert.equal(await g({ ...ok, usdToday: async () => 8.7 }), 'cap');
    assert.equal(await g({ ...ok, usdToday: async () => 8.6 }), null);
    memStorage();
    resetBillingLockForTests();
    const fake = falFake([{ status: 'COMPLETED' }]);
    const out = await runMatteStep(matteJob, matteDeps(fake, { planOf: async () => 'free' }));
    assert.deepEqual([out.status, out.reason], ['skipped', 'plan']);
    assert.equal(fake.calls.length, 0);
    setStorageForTests(null);
});

test('matte layers: needsBackgroundMatte and behind-person graphics only with a matte url', () => {
    const p = plan();
    assert.equal(needsBackgroundMatte(p), true);
    assert.equal(needsBackgroundMatte({ ...p, framing: { mode: 'fit_blur', focusX: 0.5 } }), false);
    assert.equal(needsBackgroundMatte({ ...p, graphics: p.graphics.filter((g) => g.type !== 'headline') }), false);
    assert.equal(needsBackgroundMatte(p, { overlaysOff: true }), false);
    const plain = buildRenderProps(p, {}, media(null), { density: null });
    assert.equal(plain.matte, undefined);
    assert.ok(plain.graphics.every((g) => !g.layer), 'no matte: unchanged');
    const withMatte = buildRenderProps(p, {}, { ...media(null), matteUrl: 'https://s3/m.webm' }, { density: null });
    assert.deepEqual(withMatte.matte, { url: 'https://s3/m.webm', mode: 'alpha-webm' });
    assert.deepEqual(withMatte.graphics.filter((g) => g.layer === 'behind').map((g) => g.type), ['headline']);
    assert.equal(buildRenderProps(p, { framingMode: 'fit_blur' }, { ...media(null), matteUrl: 'https://s3/m.webm' }, { density: null }).matte, undefined);
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

test('screen recording: focus points are clamped, shots validated, planner rules and schema only with the flag and a recording', () => {
    // Focus stays inside the picture at the chosen zoom (window = 1/zoom), zoom 1 to 2.5.
    assert.deepEqual(clampFocus(0, 1, 2), { x: 0.25, y: 0.75, zoom: 2 });
    assert.deepEqual(clampFocus(0.5, 0.5, 9), { x: 0.5, y: 0.5, zoom: 2.5 });
    assert.deepEqual(clampFocus('x', undefined, 0.2), { x: 0.5, y: 0.5, zoom: 1 });

    const segs = [{ id: 's1', start: 0.3, end: 4.8 }];
    const shot = (o) => ({ start: 1, end: 4, recStart: 0, fromX: 0.5, fromY: 0.5, fromZoom: 1, toX: 0.9, toY: 0.1, toZoom: 2, ...o });
    const ok = validateScreens([shot()], segs, 20);
    assert.deepEqual([ok[0].toX, ok[0].toY, ok[0].toZoom], [0.75, 0.25, 2]);
    assert.equal(validateScreens([shot()], segs, 0).length, 0, 'no recording, no shots');
    assert.equal(validateScreens([shot({ start: 5.5, end: 8 })], segs, 20).length, 0, 'must start inside a kept segment');
    assert.equal(validateScreens([shot({ end: 1.5 })], segs, 20).length, 0, 'too short');
    assert.equal(validateScreens([shot({ end: 60 })], [{ id: 's', start: 0, end: 100 }], 20)[0].end, 16, 'capped at 15s on screen');
    const fitted = validateScreens([shot({ recStart: 19, end: 4 })], segs, 20);
    assert.deepEqual([fitted[0].recStart, fitted[0].end], [18.5, 2.5], 'recStart pulled back so 1.5s of recording remains');
    assert.equal(validateScreens([shot({ recStart: 18.4, end: 5 })], segs, 20)[0].recStart, 18.4);
    assert.equal(validateScreens([shot({ recStart: 18.4, end: 5 })], segs, 20)[0].end, 2.6, 'cut to the recording that is left');
    assert.deepEqual(validateScreens([shot(), shot({ start: 3, end: 4.5 })], segs, 20).length, 1, 'shots never overlap');

    // Through validateEdl: only with the flag on and ctx.screenDurationSec.
    const withScreens = { ...plan(), screens: [shot()] };
    assert.equal('screens' in validateEdl(withScreens, { ...ctx, screenDurationSec: 20 }).plan, false, 'flag off: plan shape unchanged');
    process.env.EDITOR_FEATURES_V2 = 'true';
    try {
        assert.equal(validateEdl(withScreens, { ...ctx, screenDurationSec: 20 }).plan.screens.length, 1);
        assert.equal(validateEdl(withScreens, ctx).plan.screens.length, 0);
        assert.ok('screens' in edlSchemaFor(true, true).properties);
        assert.ok(!('screens' in edlSchemaFor(true).properties));
        const base = { project: { source: { durationSec: 6 }, media: { words, cutCandidates }, screenRecording: { durationSec: 20, width: 1920, height: 1080 } }, profile: {}, knowledgeText: '', exemplarText: '', trackText: '', sheets: [] };
        const text = (c) => c.filter((x) => x.type === 'text').map((x) => x.text).join('\n');
        assert.match(text(buildPlannerContent({ ...base, screenSheet: { base64: 'AA', intervalSec: 2 } })), /SCREEN RECORDING/);
        assert.doesNotMatch(text(buildPlannerContent(base)), /SCREEN RECORDING/);
    } finally {
        delete process.env.EDITOR_FEATURES_V2;
    }

    // Composition props: the shot is placed on the output timeline, split screen puts it in the lower half.
    const planned = { ...plan(), screens: [{ ...shot(), start: 1, end: 3.5 }] };
    const v2 = (extra) => ({ ...media(null), v2: true, screenRecordingSec: 20, ...extra });
    const props = buildRenderProps(planned, {}, v2());
    assert.equal(props.screens.length, 1);
    assert.equal(props.screens[0].layout, 'safe');
    assert.ok(props.screens[0].durationFrames > 6 && props.screens[0].startFrame >= 0);
    assert.deepEqual(props.screens[0].to, { x: 0.75, y: 0.25, zoom: 2 });
    assert.equal(buildRenderProps(planned, { framingMode: 'split' }, v2()).screens[0].layout, 'bottom');
    assert.equal(buildRenderProps(planned, {}, v2({ screenRecordingSec: 0 })).screens, undefined);
    assert.equal(buildRenderProps(planned, {}, { ...v2(), v2: false }).screens, undefined);
    // The storyboard beat lists its shots.
    assert.equal(buildStoryboard(planned, {}).beats[0].screens.length, 1);
});

test('simultaneous jobs for the same video: exactly one claims the work and submits (one charge)', async () => {
    resetBillingLockForTests();
    memStorage();
    const Model = fakeMatteModel();
    const fake = falFake([{ status: 'COMPLETED' }]);
    const deps = () => matteDeps(fake, { store: matteJobStore('u1', { Model }) });
    const results = await Promise.all([runMatteStep(matteJob, deps()), runMatteStep(matteJob, deps())]);
    assert.equal(fake.calls.filter((c) => c.method === 'POST').length, 1, 'one submit');
    assert.deepEqual(results.map((r) => r.status).sort(), ['ok', 'skipped']);
    assert.equal(results.find((r) => r.status === 'skipped').reason, 'in_progress');
    const doc = Model.docs.get('u1:abc:veed-refine');
    assert.deepEqual([doc.status, doc.requestId, doc.usage.length], ['ok', 'r1', 1]);

    // The same race on a retry of a matte that failed over 24 hours ago: still one submit.
    memStorage();
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const failed = { _id: 'u1:abc:veed-refine', userId: 'u1', sourceHash: 'abc', variant: 'veed-refine', rev: 3, claimId: 'c0', status: 'failed', reason: 'timeout', requestId: 'r0', seconds: 60, estCostUsd: 1.35, submittedAt: old, updatedAt: old, usage: [{ claimId: 'c0', at: old, seconds: 60, estCostUsd: 1.35, voided: false }] };
    const Model2 = fakeMatteModel([failed]);
    const fake2 = falFake([{ status: 'COMPLETED' }]);
    const deps2 = () => matteDeps(fake2, { store: matteJobStore('u1', { Model: Model2 }) });
    const retried = await Promise.all([runMatteStep(matteJob, deps2()), runMatteStep(matteJob, deps2())]);
    assert.equal(fake2.calls.filter((c) => c.method === 'POST').length, 1, 'one submit on retry');
    assert.deepEqual(retried.map((r) => r.status).sort(), ['ok', 'skipped']);
    // The earlier run stays in the ledger next to the retry, so the caps count both.
    const doc2 = Model2.docs.get('u1:abc:veed-refine');
    assert.deepEqual(doc2.usage.map((u) => u.claimId === 'c0'), [true, false]);
    assert.equal(sumLedger([doc2], new Date(old.getTime() - 1), 'seconds'), 120);
    assert.equal(sumLedger([doc2], new Date(old.getTime() + 1), 'seconds'), 60, 'only runs since the start of the period');
    setStorageForTests(null);
});

test('usage ledger: a run that never reached fal is not billed; caps sum every billed run', async () => {
    resetBillingLockForTests();
    memStorage();
    const Model = fakeMatteModel();
    const fake = falFake([{ status: 'COMPLETED' }]);
    const out = await runMatteStep(matteJob, matteDeps(fake, { store: matteJobStore('u1', { Model }), makeProxy: async () => { throw new Error('ffmpeg exited with 1'); } }));
    assert.equal(out.status, 'failed');
    assert.equal(fake.calls.length, 0);
    const doc = Model.docs.get('u1:abc:veed-refine');
    assert.deepEqual(doc.usage.map((u) => u.voided), [true], 'claimed, then released');
    assert.equal(sumLedger([doc], new Date(0), 'seconds'), 0);

    // A submit that errors may still have been billed: its entry stays.
    memStorage();
    const Model2 = fakeMatteModel();
    await runMatteStep(matteJob, matteDeps({ fetchFn: async () => jsonRes({}, false, 500) }, { store: matteJobStore('u1', { Model: Model2 }) }));
    assert.deepEqual(Model2.docs.get('u1:abc:veed-refine').usage.map((u) => Boolean(u.voided)), [false]);

    // ledgerTotal reads the ledger (not the latest record) for the caps.
    const at = new Date('2026-11-20T10:00:00Z');
    const docs = [
        { usage: [{ at: new Date('2026-10-31T23:00:00Z'), seconds: 100, estCostUsd: 2 }, { at, seconds: 60, estCostUsd: 1.35 }, { at, seconds: 30, estCostUsd: 0.7, voided: true }] },
        { usage: [{ at, seconds: 45, estCostUsd: 1 }] },
    ];
    let query = null;
    const Model3 = { find: (q) => { query = q; return { select: () => ({ lean: async () => docs }) }; } };
    const since = new Date('2026-11-01T00:00:00Z');
    assert.equal(await ledgerTotal({ userId: 'u1' }, since, 'seconds', { Model: Model3 }), 105);
    assert.deepEqual(query, { userId: 'u1', 'usage.at': { $gte: since } });
    assert.equal(Math.round((await ledgerTotal({}, since, 'estCostUsd', { Model: Model3 })) * 100) / 100, 2.35);
    setStorageForTests(null);
});

test('a slow run keeps its claim with a heartbeat; a stalled run that lost it never submits', async () => {
    resetBillingLockForTests();
    memStorage();
    let clock = Date.parse('2026-11-24T10:00:00Z');
    const now = () => clock;
    const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

    // Heartbeat: while the first run makes its copy for 20 minutes of clock time, a second run sees a fresh claim.
    const Model = fakeMatteModel();
    const fake = falFake([{ status: 'COMPLETED' }]);
    const slow = gate();
    const first = runMatteStep(matteJob, matteDeps(fake, { now, heartbeatMs: 5, store: matteJobStore('u1', { Model }), makeProxy: () => slow.p }));
    await new Promise((r) => setTimeout(r, 20));
    clock += 20 * 60 * 1000;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(new Date(Model.docs.get('u1:abc:veed-refine').updatedAt).getTime(), clock, 'heartbeat refreshed the claim');
    const second = await runMatteStep(matteJob, matteDeps(fake, { now, store: matteJobStore('u1', { Model }) }));
    assert.equal(second.reason, 'in_progress');
    slow.open();
    assert.equal((await first).status, 'ok');
    assert.equal(fake.calls.filter((c) => c.method === 'POST').length, 1);

    // A run that stalls with no heartbeat (paused process) loses the claim after 15 minutes: the new run submits, and
    // the stalled one checks ownership right before submitting and stops. One submit, one billed ledger entry.
    memStorage();
    const Model2 = fakeMatteModel();
    const fake2 = falFake([{ status: 'COMPLETED' }]);
    const stalled = gate();
    const a = runMatteStep(matteJob, matteDeps(fake2, { now, heartbeatMs: 60 * 60 * 1000, store: matteJobStore('u1', { Model: Model2 }), makeProxy: () => stalled.p }));
    await new Promise((r) => setTimeout(r, 10));
    clock += 16 * 60 * 1000;
    const b = await runMatteStep(matteJob, matteDeps(fake2, { now, store: matteJobStore('u1', { Model: Model2 }) }));
    assert.equal(b.status, 'ok', 'stale claim taken over');
    stalled.open();
    assert.deepEqual(await a, { status: 'skipped', reason: 'in_progress' });
    assert.equal(fake2.calls.filter((c) => c.method === 'POST').length, 1, 'exactly one submit');
    const doc = Model2.docs.get('u1:abc:veed-refine');
    assert.deepEqual(doc.usage.map((u) => [Boolean(u.sent), Boolean(u.voided)]), [[false, true], [true, false]], 'the stalled run is voided, the winner is billed');
    assert.equal(sumLedger([doc], new Date(0), 'seconds'), 60);
    assert.equal(doc.status, 'ok', 'the stalled run did not overwrite the winner');
    setStorageForTests(null);
});
