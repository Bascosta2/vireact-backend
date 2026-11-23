import test from 'node:test';
import assert from 'node:assert/strict';
import { removeRepeats } from '../src/service/editor/no-repeats.js';
import { buildPieces, buildTimeline } from '../src/service/editor/timing.js';
import { norm } from '../src/service/editor/cut-candidates.js';

/** Words from a script: each entry is [text, start]; every word lasts 0.3 s. */
const say = (list) => list.map(([w, start]) => ({ w, start, end: start + 0.3 }));
const line = (text, at, step = 0.35) => text.split(' ').map((w, k) => [w, at + k * step]);

/** What the viewer hears, in order: the normalized words inside the pieces. */
const heard = (pieces, words) => pieces.flatMap((p) => words.filter((w) => (w.start + w.end) / 2 >= p.start && (w.start + w.end) / 2 < p.end).map((w) => norm(w.w)));

const noRunTwice = (seq, len = 4) => {
    const seen = new Set();
    for (let i = 0; i + len <= seq.length; i += 1) {
        const key = seq.slice(i, i + len).join(' ');
        if (seen.has(key)) return key;
        seen.add(key);
    }
    return null;
};

test('a retake said twice in a row: the first attempt goes, the final take stays', () => {
    const words = say([
        ...line('so the best way to grow', 1.0),
        ...line('so the best way to grow on tiktok is consistency', 4.0),
    ]);
    const media = { words, silences: [], durationSec: 9 };
    const pieces = buildPieces([{ id: 's1', start: 0.9, end: 8 }], [], media);
    const { pieces: out, removed } = removeRepeats(pieces, media);
    const said = heard(out, words);
    assert.equal(noRunTwice(said), null, `still repeats: ${said.join(' ')}`);
    assert.deepEqual(said, 'so the best way to grow on tiktok is consistency'.split(' '));
    assert.equal(removed[0].reason, 'retake');
});

test('a retake a minute apart in separate segments: only the later take plays', () => {
    const words = say([
        ...line('here is the secret nobody tells you', 2),
        ...line('and then some other stuff happens here', 10),
        ...line('here is the secret nobody tells you about editing', 70),
    ]);
    const media = { words, silences: [], durationSec: 80 };
    const segs = [{ id: 's1', start: 1.9, end: 5 }, { id: 's2', start: 9.9, end: 13 }, { id: 's3', start: 69.9, end: 74 }];
    const { pieces: out } = removeRepeats(buildPieces(segs, [], media), media);
    const said = heard(out, words);
    assert.equal(noRunTwice(said), null, said.join(' '));
    assert.ok(said.join(' ').endsWith('here is the secret nobody tells you about editing'));
    assert.ok(said.join(' ').startsWith('and then some other stuff'));
});

test('a hook pulled to the front is not heard again in the body', () => {
    const words = say([
        ...line('I lost ten thousand dollars', 1),
        ...line('and this one mistake cost me everything', 3),
        ...line('here is what happened', 6),
    ]);
    const media = { words, silences: [], durationSec: 9 };
    // The hook replays a line the body also contains.
    const segs = [{ id: 'h', start: 2.9, end: 5.6 }, { id: 'b', start: 0.9, end: 8 }];
    const { pieces: out } = removeRepeats(buildPieces(segs, [], media), media, { roles: { h: 'hook', b: 'body' } });
    const said = heard(out, words);
    assert.equal(noRunTwice(said), null, said.join(' '));
    assert.equal(said.slice(0, 7).join(' '), 'and this one mistake cost me everything', 'the hook still opens the video');
    assert.ok(said.includes('happened'));
});

test('touching segments snapped onto the same word never play it twice', () => {
    const words = say(line('this is one long sentence that keeps going on', 1, 0.32));
    const media = { words, silences: [], durationSec: 6 };
    // Two segments meeting in the middle of a word, reordered, plus an outright overlap.
    const segs = [{ id: 'b', start: 2.32, end: 4.5 }, { id: 'a', start: 0.9, end: 2.36 }, { id: 'c', start: 4.0, end: 5.0 }];
    const { pieces: out } = removeRepeats(buildPieces(segs, [], media), media);
    const sorted = [...out].sort((x, y) => x.start - y.start);
    for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i].start >= sorted[i - 1].end - 0.005, `overlap ${JSON.stringify(sorted)}`);
    const said = heard(out, words);
    assert.equal(new Set(said).size, said.length, `a word plays twice: ${said.join(' ')}`);
});

test('ordinary repetition stays, and a clean plan is untouched', () => {
    const words = say([...line('it was very very good', 1), ...line('really good stuff', 3.5)]);
    const media = { words, silences: [], durationSec: 6 };
    const pieces = buildPieces([{ id: 's1', start: 0.9, end: 5 }], [], media);
    const { pieces: out, removed } = removeRepeats(pieces, media);
    assert.deepEqual(out, pieces);
    assert.equal(removed.length, 0);
    const { durationFrames } = buildTimeline(out);
    assert.ok(durationFrames > 0);
});

test('squashed words borrow time from the pause beside them, so no edge can lose them', async () => {
    const { repairWordTimings, buildCutCandidates } = await import('../src/service/editor/cut-candidates.js');
    // "...I mean. [pause] Most people start" with "Most" squashed to zero length at the end of the pause,
    // and "...3 times the views. [pause]" with "views" squashed at the start of the next pause.
    const words = [
        { w: 'mean.', start: 9.6, end: 10.0 },
        { w: 'Most', start: 11.74, end: 11.74 },
        { w: 'people', start: 11.74, end: 12.08 },
        { w: 'the', start: 31.8, end: 32.52 },
        { w: 'views.', start: 32.52, end: 32.52 },
        { w: 'Uh', start: 34.36, end: 34.88 },
    ];
    const silences = [{ start: 10.03, end: 11.5 }, { start: 32.32, end: 34.01 }];
    const fixed = repairWordTimings(words, silences);
    const most = fixed[1];
    const views = fixed[4];
    assert.ok(most.end - most.start >= 0.12 && most.start >= 11.48 && most.end === 11.74, JSON.stringify(most));
    assert.ok(views.end - views.start >= 0.12 && views.start === 32.52, JSON.stringify(views));
    assert.deepEqual(repairWordTimings(fixed, silences), fixed, 'repairing twice changes nothing');
    // The pause after "views" is cut without touching the word.
    const pauses = buildCutCandidates({ words: fixed, silences, durationSec: 40 }).filter((c) => c.kind === 'silence');
    for (const p of pauses) for (const w of fixed) assert.ok(p.end <= w.start || p.start >= w.end, `pause ${p.start}-${p.end} cuts into "${w.w}"`);
});

test('a sliver of silence left between two cuts is dropped', () => {
    const words = say([...line('first part of the line', 1), ...line('second part right here', 5)]);
    const media = { words, silences: [], durationSec: 8 };
    // A cut leaves 3.2-3.5 (silence, no words) as its own piece.
    const pieces = [{ id: 'a', segId: 's', start: 0.9, end: 2.8 }, { id: 'b', segId: 's', start: 3.2, end: 3.5 }, { id: 'c', segId: 's', start: 4.9, end: 6.6 }];
    const { pieces: out } = removeRepeats(pieces, media);
    assert.deepEqual(out.map((p) => p.id), ['a', 'c']);
});
