import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanUserText, cleanUserFacing } from '../src/service/analyzer/voice.js';
import { calibrateViewBand, viewCeilingFor } from '../src/service/view-calibration.js';
import { buildInitialAnalysisMessage, describeFix } from '../src/service/initial-analysis-message.js';
import { normalizeScriptOption, scriptTargetSeconds, toScriptSuggestionsResponse } from '../src/service/script-suggestions.service.js';
import { SPECIFICITY_CONTRACT } from '../src/service/analyzer/run-feedback-analyzer.js';

const DASH = /[—–]/;

test('cleaner removes knowledge-base references seen in production and all em/en dashes', () => {
    const fromProduction = [
        'The hook lacks spoken content, violating the pattern of using strong statements or visuals as seen in Bas\'s examples.',
        'Expected: This aligns with the pattern of using strong opening lines or text overlays, as seen in Bas\'s examples.',
        'According to Bas\'s principles, open on the payoff.',
        'Open on the payoff, according to the retrieved insights, then cut at 0:03.',
        'Use the pattern from the reference notes to open faster.',
    ];
    for (const sentence of fromProduction) {
        const cleaned = cleanUserText(sentence);
        assert.doesNotMatch(cleaned, /\bBas\b|retrieved|reference notes|examples/i, cleaned);
        assert.ok(cleaned.length > 10, `kept the useful part: "${cleaned}"`);
    }
    assert.equal(cleanUserText('Cut 0:04–0:06 — Then show the reveal.'), 'Cut 0:04-0:06. Then show the reveal.');
    assert.equal(cleanUserText('Too slow — cut it.'), 'Too slow, cut it.');
    assert.doesNotMatch(cleanUserText('a — b – c'), DASH);
});

test('cleaner leaves verbatim transcript fields alone', () => {
    const out = cleanUserFacing({ fix: { type: 'replace_line', before: 'so today — I', after: 'Say it — now' }, observed: 'she says — hi' });
    assert.equal(out.fix.before, 'so today — I');
    assert.equal(out.observed, 'she says — hi');
    assert.equal(out.fix.after, 'Say it, now');
});

test('every analyzer and chat prompt carries the voice and calibration rules', () => {
    assert.match(SPECIFICITY_CONTRACT, /Never use em dashes/);
    assert.match(SPECIFICITY_CONTRACT, /never mention them/);
    assert.match(SPECIFICITY_CONTRACT, /CALIBRATION/);
});

test('view band is capped by the overall score (a 43/100 video cannot be predicted at 75K)', () => {
    const band = calibrateViewBand({ low: 40000, expected: 75000, high: 110000 }, 43);
    assert.deepEqual(band, { low: 30, expected: 200, high: 1200, capped: true });

    const strong = calibrateViewBand({ low: 500, expected: 2000, high: 9000 }, 80);
    assert.deepEqual(strong, { low: 500, expected: 2000, high: 9000, capped: false });

    assert.deepEqual(calibrateViewBand({ low: null, expected: null, high: null }, 60), { low: null, expected: null, high: null, capped: false });
    // Missing expected is derived, unknown score gets a below-average ceiling, band stays ordered.
    const derived = calibrateViewBand({ low: 100, high: 300 }, null);
    assert.equal(derived.expected, 200);
    assert.ok(derived.low <= derived.expected && derived.expected <= derived.high);
    assert.equal(viewCeilingFor(null).minScore, 45);
});

test('first coach message is a short timestamped plan with literal fixes and no dashes', () => {
    const message = buildInitialAnalysisMessage({
        viralityScore: 43,
        analysis: [
            { feature: 'hook', score: 35, suggestions: ['0:00-0:02: put text on screen.'] },
            { feature: 'caption', score: 10, suggestions: [] },
            { feature: 'pacing', score: 55, suggestions: [] },
            { feature: 'advanced_analytics', score: 70, suggestions: [] },
        ],
        timestampFeedback: [
            { tStart: 0, tEnd: 2, severity: 5, sourceFeature: 'hook', issue: 'Nothing on screen or said in the first 2 seconds — viewers swipe', fix: { type: 'add_text_overlay', after: 'Watch me surf under this pier' } },
            { tStart: 8, tEnd: 11, severity: 3, sourceFeature: 'pacing', issue: 'The same shot holds for 3 seconds', fix: { type: 'cut', after: 'cut 0:08-0:10 (2s)' } },
            { tStart: 1, tEnd: 3, severity: 4, sourceFeature: 'advanced_analytics', issue: 'Pro only', fix: { type: 'add_text_overlay', after: 'secret' } },
        ],
    });
    assert.match(message, /^Virality score: 43\/100\. Fix this before you post\./);
    assert.match(message, /1\. 0:00-0:02\. .*Put this text on screen: "Watch me surf under this pier"/);
    assert.match(message, /2\. 0:08-0:11\. .*Cut 0:08-0:10/);
    assert.match(message, /Weakest: captions \(10\)\. Strongest: pacing \(55\)\./);
    assert.doesNotMatch(message, /secret|Pro only/, 'advanced items stay out of the shared message');
    assert.doesNotMatch(message, DASH);
    assert.doesNotMatch(message, /What's wrong|Suggestions to improve/);
});

test('fix descriptions are literal instructions', () => {
    assert.equal(describeFix({ type: 'replace_line', after: 'I surfed this at 6am' }), 'Say this instead: "I surfed this at 6am"');
    assert.equal(describeFix({ type: 'trim', after: 'trim 0:00-0:01' }), 'Trim 0:00-0:01');
    assert.equal(describeFix({ type: 'cut', after: '' }), '');
});

test('script options are fitted to the video length and rejected when unspeakable', () => {
    const target = 21;
    const option = normalizeScriptOption({
        title: 'Result first',
        angle: 'Show the best wave first.',
        hookLine: 'I surfed under this pier at 6am',
        beats: [
            { tStart: 0.4, tEnd: 3, say: 'I surfed under this pier at 6am.', onScreenText: 'Under the pier at 6am', visual: 'Wave under the pier' },
            { tStart: 3, tEnd: 15, say: '', onScreenText: 'Watch the gap', visual: 'Approach' },
            { tStart: 15, tEnd: 30, say: 'Follow for part two.', onScreenText: 'Part 2 tomorrow', visual: 'Exit the wave' },
            { tStart: 25, tEnd: 20, say: 'bad', onScreenText: '', visual: '' },
        ],
        cta: 'Follow for part two',
        whyItWorks: 'The payoff comes first — so viewers stay.',
    }, 0, target);
    assert.equal(option.id, 'script_1');
    assert.equal(option.beats.length, 3);
    assert.equal(option.beats[0].tStart, 0);
    assert.equal(option.beats[option.beats.length - 1].tEnd, target);
    assert.doesNotMatch(option.whyItWorks, DASH);

    const tooWordy = normalizeScriptOption({
        title: 'x', angle: '', hookLine: '', cta: '', whyItWorks: '',
        beats: [
            { tStart: 0, tEnd: 2, say: 'word '.repeat(40), onScreenText: '', visual: '' },
            { tStart: 2, tEnd: 4, say: 'word '.repeat(40), onScreenText: '', visual: '' },
        ],
    }, 1, 4);
    assert.equal(tooWordy, null);
    assert.equal(normalizeScriptOption({ beats: [{ tStart: 0, tEnd: 2, say: 'hi', onScreenText: '', visual: '' }] }, 0, 10), null);
});

test('script length follows the video, clamped to a sensible range', () => {
    assert.equal(scriptTargetSeconds({ duration: 21.4 }), 21);
    assert.equal(scriptTargetSeconds({ scenes: [{ endTime: 3 }] }), 6);
    assert.equal(scriptTargetSeconds({ duration: 400 }), 90);
    assert.equal(scriptTargetSeconds({}), 30);
    assert.equal(toScriptSuggestionsResponse(null).options.length, 0);
    assert.equal(toScriptSuggestionsResponse({ options: [{ id: 'a' }], generationCount: 2 }).regenerationsLeft, 2);
});

test('impossible timecodes are repaired using the video length; internal fix ids become words', async () => {
    const { retimeForDuration } = await import('../src/service/analyzer/voice.js');
    assert.equal(retimeForDuration('6:00-12:00: put text. 5:00-5:11 too. Keep 0:12.', 21), '0:06-0:12: put text. 0:05-0:11 too. Keep 0:12.');
    assert.equal(retimeForDuration('1:30 is fine', 120), '1:30 is fine');
    assert.deepEqual(
        retimeForDuration({ fix: { before: '6:00 verbatim', after: 'cut 6:00-9:00' } }, 21),
        { fix: { before: '6:00 verbatim', after: 'cut 0:06-0:09' } }
    );
    assert.equal(cleanUserText("0:00-0:06 add_text_overlay 'Pier run' at 00:12"), "0:00-0:06 put this text on screen: 'Pier run' at 0:12");
    assert.equal(cleanUserText('cut 00:00:11.000-00:00:16.000 to maintain viewer engagement.'), 'cut 0:11-0:16.');
    assert.equal(describeFix({ type: 'add_sound', after: 'add a splash at 0:12' }), 'Add a splash at 0:12');
});

test('caption replacements read as on-screen text and do not duplicate an overlay at the same moment', () => {
    assert.equal(describeFix({ type: 'replace_line', after: 'Surfing under the pier' }, 'caption'), 'Change the on-screen text to: "Surfing under the pier"');
    assert.equal(describeFix({ type: 'replace_line', after: 'I made it' }, 'hook'), 'Say this instead: "I made it"');
    const message = buildInitialAnalysisMessage({
        viralityScore: 40,
        analysis: [{ feature: 'hook', score: 38 }, { feature: 'audio', score: 52 }],
        timestampFeedback: [
            { tStart: 0, tEnd: 5, severity: 5, category: 'hook', sourceFeature: 'hook', issue: 'No action named', fix: { type: 'add_text_overlay', after: 'Surfing under the pier' } },
            { tStart: 0, tEnd: 5, severity: 4, category: 'caption', sourceFeature: 'caption', issue: 'Date only', fix: { type: 'replace_line', after: 'Bajo el muelle' } },
            { tStart: 12, tEnd: 21, severity: 3, category: 'pacing', sourceFeature: 'pacing', issue: 'Repeats', fix: { type: 'cut', after: 'cut 0:12-0:21' } },
        ],
    });
    assert.match(message, /Do these 2 things first/);
    assert.doesNotMatch(message, /Bajo el muelle/);
});
