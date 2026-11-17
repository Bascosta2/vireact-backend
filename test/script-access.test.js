import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAN_LIMITS, SCRIPT_ACCESS } from '../src/constants.js';
import {
    SCRIPT_MECHANISMS, SCRIPT_OPTION_COUNT, SCRIPT_SET_VERSION, generateScriptOptions, isLegacyScriptSet,
    requiredPlanForScript, scriptAccessForPlan, tidyScriptTitles, toScriptSuggestionsResponse,
} from '../src/service/script-suggestions.service.js';

const fullOption = (i) => ({
    id: `script_${i + 1}`,
    title: `Idea ${i + 1}`,
    angle: `Angle ${i + 1}`,
    hookLine: `Hook ${i + 1}`,
    beats: [{ tStart: 0, tEnd: 5, say: 'One.', onScreenText: '', visual: 'a' }, { tStart: 5, tEnd: 10, say: 'Two.', onScreenText: '', visual: 'b' }],
    cta: `End ${i + 1}`,
    whyItWorks: `Why ${i + 1}`,
});
const stored = (count, extra = {}) => ({ options: Array.from({ length: count }, (_, i) => fullOption(i)), generationCount: 1, targetSeconds: 10, version: SCRIPT_SET_VERSION, ...extra });

test('plans: Pro has 40 analyses a month; scripts open 2, 6, 10 and 10 per video', () => {
    assert.equal(PLAN_LIMITS.pro.videosPerMonth, 40);
    assert.deepEqual(SCRIPT_ACCESS, { free: 2, premium: 6, pro: 10, enterprise: 10 });
    assert.equal(SCRIPT_OPTION_COUNT, 10);
    assert.equal(SCRIPT_MECHANISMS.length, 10);
    assert.equal(scriptAccessForPlan('free'), 2);
    assert.equal(scriptAccessForPlan('premium'), 6);
    assert.equal(scriptAccessForPlan('pro'), 10);
    assert.equal(scriptAccessForPlan('something-else'), 2);
    assert.equal(scriptAccessForPlan(undefined), 2);
});

test('locked scripts keep their idea name but never leave the server', () => {
    const cases = [['free', 2], ['premium', 6], ['pro', 10], ['enterprise', 10]];
    for (const [plan, open] of cases) {
        const res = toScriptSuggestionsResponse(stored(10), { plan });
        assert.deepEqual(res.access, { plan, unlocked: open, total: 10 });
        assert.equal(res.options.length, 10);
        res.options.forEach((option, i) => {
            assert.equal(option.title, `Idea ${i + 1}`, 'every idea name is visible');
            if (i < open) {
                assert.equal(option.locked, false);
                assert.equal(option.beats.length, 2);
                assert.equal(option.hookLine, `Hook ${i + 1}`);
            } else {
                assert.equal(option.locked, true);
                assert.equal(option.requiredPlan, i < 6 ? 'premium' : 'pro');
                assert.deepEqual(option.beats, []);
                assert.equal(option.hookLine, '');
                assert.equal(option.angle, '');
                assert.equal(option.cta, '');
                assert.equal(option.whyItWorks, '');
                assert.doesNotMatch(JSON.stringify(option), /Hook|Angle|End|Why|One\.|Two\./);
            }
        });
    }
    // Default (no plan given) is the Free amount.
    assert.equal(toScriptSuggestionsResponse(stored(10)).options.filter((o) => !o.locked).length, 2);
    assert.equal(requiredPlanForScript(2), 'premium');
    assert.equal(requiredPlanForScript(5), 'premium');
    assert.equal(requiredPlanForScript(6), 'pro');
});

test('older four-script sets are flagged for a rewrite; empty sets report the plan access', () => {
    const legacy = stored(4, { version: undefined });
    assert.equal(isLegacyScriptSet(legacy), true);
    assert.equal(toScriptSuggestionsResponse(legacy, { plan: 'pro' }).needsRefresh, true);
    assert.equal(isLegacyScriptSet(stored(8)), false, 'a current set with fewer usable scripts is not rewritten again');
    assert.equal(isLegacyScriptSet(null), false);
    const empty = toScriptSuggestionsResponse(null, { plan: 'premium' });
    assert.deepEqual(empty.options, []);
    assert.deepEqual(empty.access, { plan: 'premium', unlocked: 6, total: 10 });
    assert.equal(empty.needsRefresh, false);
});

test('idea names are trimmed to three words and kept unique', () => {
    const titles = tidyScriptTitles([{ title: 'Score first.' }, { title: 'score first' }, { title: 'A very long idea name here' }, { title: '' }]).map((o) => o.title);
    assert.deepEqual(titles, ['Score first', 'score first 2', 'A very long', 'Script idea']);
});

test('generation writes ten scripts in two requests of five, and survives one failing', async () => {
    const video = { duration: 10, scenes: [{ startTime: 0, endTime: 10, visualDescription: 'A desk', purpose: 'hook' }], rawTranscript: [{ tStart: 0, tEnd: 10, text: 'Hello there.' }], analysis: [], timestampFeedback: [] };
    const prompts = [];
    const writer = (failSecond) => async ({ messages, maxTokens }) => {
        const prompt = messages[0].content;
        prompts.push(prompt);
        assert.equal(maxTokens, 6000);
        if (failSecond && prompt.includes(SCRIPT_MECHANISMS[9])) throw new Error('model unavailable');
        const names = prompt.includes(SCRIPT_MECHANISMS[0]) ? ['Score first', 'Bold claim', 'Big question', 'Common mistake', 'Three steps'] : ['Mid story', 'Myth buster', 'Before after', 'Your turn', 'Held back'];
        return { options: names.map((title, i) => ({ ...fullOption(i), title })) };
    };
    const deps = { retrieve: async () => [], complete: writer(false) };

    const { options, targetSeconds } = await generateScriptOptions(video, deps);
    assert.equal(targetSeconds, 10);
    assert.equal(prompts.length, 2);
    assert.ok(SCRIPT_MECHANISMS.slice(0, 5).every((m) => prompts.some((p) => p.includes(m) && !p.includes(SCRIPT_MECHANISMS[5]))));
    assert.ok(prompts.every((p) => p.includes('Write 5 complete alternative scripts')));
    assert.equal(options.length, 10);
    assert.deepEqual(options.map((o) => o.id), Array.from({ length: 10 }, (_, i) => `script_${i + 1}`));
    assert.equal(new Set(options.map((o) => o.title)).size, 10);
    assert.equal(options[0].title, 'Score first');
    assert.equal(options[5].title, 'Mid story');

    const partial = await generateScriptOptions(video, { retrieve: async () => [], complete: writer(true) });
    assert.equal(partial.options.length, 5);
    await assert.rejects(generateScriptOptions(video, { retrieve: async () => [], complete: async () => { throw new Error('down'); } }), /down/);
});
