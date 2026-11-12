import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCutCandidates, candidateSeconds, gapsFromWords } from '../src/service/editor/cut-candidates.js';
import { buildPieces, buildTimeline, captionPages, mapRange, snapPiece, srcToOut, subtractRanges } from '../src/service/editor/timing.js';

// "Um so today I want I want to show you the trick." with a pause and a retake.
const words = [
    { w: 'Um', start: 1.0, end: 1.2 },
    { w: 'so', start: 1.6, end: 1.8 },
    { w: 'today', start: 2.0, end: 2.4 },
    { w: 'I', start: 2.45, end: 2.5 },
    { w: 'want', start: 2.55, end: 2.8 },
    { w: 'I', start: 3.4, end: 3.45 },
    { w: 'want', start: 3.5, end: 3.75 },
    { w: 'to', start: 3.8, end: 3.9 },
    { w: 'show', start: 3.95, end: 4.2 },
    { w: 'you', start: 4.25, end: 4.4 },
    { w: 'the', start: 5.4, end: 5.5 },
    { w: 'trick.', start: 5.55, end: 6.0 },
];

test('cut candidates: dead start, filler, soft filler with pauses, retake, pause and dead end', () => {
    const c = buildCutCandidates({ words, silences: [], durationSec: 8 });
    const kinds = c.map((x) => x.kind);
    assert.ok(kinds.includes('dead_start'));
    assert.ok(kinds.includes('dead_end'));
    const fillers = c.filter((x) => x.kind === 'filler').map((x) => x.text);
    assert.deepEqual(fillers, ['Um', 'so']);
    const retake = c.find((x) => x.kind === 'retake');
    assert.equal(retake.text, 'I want');
    assert.equal(retake.start, 2.45);
    assert.equal(retake.end, 3.4);
    // The 1 s pause between "you" and "the" comes from word gaps when silencedetect found nothing.
    assert.ok(c.some((x) => x.kind === 'silence' && x.start > 4.4 && x.end < 5.4));
    assert.ok(c.every((x, i) => x.id === `c${i + 1}`));
    for (let i = 1; i < c.length; i += 1) assert.ok(c[i].start >= c[i - 1].start);
});

test('cut candidates: ordinary repetition without a pause is not a retake; empty transcript uses silences', () => {
    const rep = [
        { w: 'very', start: 0, end: 0.2 },
        { w: 'very', start: 0.22, end: 0.4 },
        { w: 'good', start: 0.42, end: 0.7 },
    ];
    assert.equal(buildCutCandidates({ words: rep, durationSec: 0.8 }).filter((x) => x.kind === 'retake').length, 0);
    const silentOnly = buildCutCandidates({ words: [], silences: [{ start: 2, end: 3 }, { start: 5, end: 5.2 }], durationSec: 10 });
    assert.equal(silentOnly.length, 1);
    assert.equal(silentOnly[0].kind, 'silence');
});

test('candidateSeconds counts overlapping ranges once; gapsFromWords finds pauses', () => {
    assert.equal(candidateSeconds([{ start: 0, end: 1 }, { start: 0.5, end: 1.5 }, { start: 3, end: 4 }]), 2.5);
    assert.deepEqual(gapsFromWords(words, 0.5).map((g) => g.start), [2.8, 4.4]);
});

test('subtractRanges splits a segment around cuts', () => {
    assert.deepEqual(subtractRanges({ start: 0, end: 10 }, [{ start: 2, end: 3 }, { start: 5, end: 6 }]), [
        { start: 0, end: 2 },
        { start: 3, end: 5 },
        { start: 6, end: 10 },
    ]);
    assert.deepEqual(subtractRanges({ start: 0, end: 2 }, [{ start: 0, end: 5 }]), []);
});

test('snapPiece moves edges onto word boundaries within tolerance, leaves far edges alone', () => {
    const s = snapPiece({ start: 2.1, end: 4.33 }, { words, silences: [], durationSec: 8 });
    assert.equal(s.start, 1.96); // 2.1 is in the first half of "today" (2.0-2.4): keep it, minus lead pad
    assert.equal(s.end, 4.46); // 4.33 is in the second half of "you" (4.25-4.4): keep it, plus tail pad
    const dropHalf = snapPiece({ start: 2.3, end: 4.28 }, { words, silences: [], durationSec: 8 });
    assert.equal(dropHalf.start, 2.41); // past the middle of "today": start after it
    assert.equal(dropHalf.end, 4.24); // before the middle of "you": end before it
    // Padding never reaches into the next word ("I" starts 0.05 s after "today" ends).
    assert.equal(snapPiece({ start: 0, end: 2.42 }, { words, silences: [], durationSec: 8 }).end, 2.44);
    const far = snapPiece({ start: 7.0, end: 7.5 }, { words, silences: [], durationSec: 8 });
    assert.deepEqual([far.start, far.end], [7.0, 7.5]);
});

test('buildPieces + buildTimeline: reordered hook plays first, frames are exact and cuts are removed', () => {
    const media = { words, silences: [], durationSec: 8 };
    const segments = [
        { id: 's2', start: 5.4, end: 6.1 }, // hook moved first
        { id: 's1', start: 1.6, end: 4.5 },
    ];
    const retake = { start: 2.45, end: 3.4 };
    const pieces = buildPieces(segments, [retake], media);
    assert.deepEqual(pieces.map((p) => p.id), ['s2', 's1.1', 's1.2']);
    const { timeline, durationFrames, durationSec } = buildTimeline(pieces, 30);
    assert.equal(timeline[0].outStartFrame, 0);
    for (let i = 1; i < timeline.length; i += 1) {
        assert.equal(timeline[i].outStartFrame, timeline[i - 1].outStartFrame + timeline[i - 1].durationFrames);
    }
    assert.equal(durationFrames, timeline.reduce((n, p) => n + p.durationFrames, 0));
    assert.equal(durationSec, Math.round((durationFrames / 30) * 1000) / 1000);
    // The retake is gone: its middle maps to nothing.
    assert.equal(srcToOut(3.0, timeline), null);
    // The hook's first word plays at the very start.
    assert.ok(srcToOut(5.45, timeline) < 0.1);
});

test('captionPages: pages follow output order, break on punctuation, apply emphasis and text fixes', () => {
    const media = { words, silences: [], durationSec: 8 };
    const pieces = buildPieces([{ id: 's1', start: 1.9, end: 6.1 }], [{ start: 2.45, end: 3.4 }], media);
    const { timeline } = buildTimeline(pieces);
    const pages = captionPages(words, timeline, { emphasis: new Set([11]), textOverrides: { 8: 'SHOW' } });
    const text = pages.map((p) => p.words.map((w) => w.text).join(' '));
    assert.ok(!text.join(' ').includes('Um'), 'cut words are not captioned');
    assert.ok(text.join(' ').includes('SHOW'));
    assert.equal(pages.at(-1).words.at(-1).text, 'trick.');
    assert.equal(pages.at(-1).words.at(-1).emphasis, true);
    assert.ok(pages.every((p) => p.words.length <= 4));
    for (let i = 1; i < pages.length; i += 1) assert.ok(pages[i].start >= pages[i - 1].start);
});

test('mapRange clips to the piece and returns null for cut starts', () => {
    const { timeline } = buildTimeline([{ id: 'a', segId: 'a', start: 0, end: 2 }, { id: 'b', segId: 'b', start: 5, end: 7 }]);
    assert.deepEqual(mapRange(1.5, 4, timeline), { start: 1.5, end: 2 });
    assert.deepEqual(mapRange(5.5, 6, timeline), { start: 2.5, end: 3 });
    assert.equal(mapRange(3, 4, timeline), null);
});
