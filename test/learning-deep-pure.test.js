import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const {
    shotsFromCuts, shotsFromScenes, buildTimeline, deepFeatures, parseCaptions, pickPairs, factorReport, signTestP, spearman, MIN_PAIR_GAP,
} = await import('../src/service/learning/deep-features.js');

test('shots from measured cuts: cover the whole video, merge cuts closer than 0.2 s, drop cuts at the edges', () => {
    const shots = shotsFromCuts([1.5, 1.6, 0.1, 4, 9.95, 'x'], 10);
    assert.deepEqual(shots, [{ start: 0, end: 1.5 }, { start: 1.5, end: 4 }, { start: 4, end: 10 }]);
    assert.deepEqual(shotsFromCuts([], 8), [{ start: 0, end: 8 }]);
    assert.deepEqual(shotsFromCuts([1, 2], null), [], 'no duration, no shots');
    assert.deepEqual(shotsFromScenes([{ startTime: 2, endTime: 5 }, { startTime: 0, endTime: 2 }, { startTime: 5, endTime: 5 }]), [{ start: 0, end: 2 }, { start: 2, end: 5 }]);
});

test('timeline: words land in the shot they are spoken in (a sentence across a cut is split), screen content from the overlapping scene', () => {
    const shots = [{ start: 0, end: 2 }, { start: 2, end: 6 }];
    const scenes = [
        { startTime: 0, endTime: 2.2, onScreenText: 'WAIT FOR IT', visualDescription: 'close-up of a face', primaryAction: 'talks to camera', purpose: 'hook' },
        { startTime: 2.2, endTime: 6, onScreenText: '', visualDescription: 'kitchen counter', primaryAction: 'pours batter', purpose: 'demonstration' },
    ];
    // 4 words over 1..3 s: two before the cut at 2 s, two after.
    const transcript = [{ text: 'you need this trick', tStart: 1, tEnd: 3 }, { text: 'then bake', tStart: 4, tEnd: 5 }];
    const tl = buildTimeline({ shots, scenes, transcript });
    assert.equal(tl.length, 2);
    assert.equal(tl[0].said, 'you need');
    assert.equal(tl[1].said, 'this trick then bake');
    assert.equal(tl[0].onScreenText, 'WAIT FOR IT');
    assert.equal(tl[0].purpose, 'hook');
    assert.equal(tl[1].visual, 'kitchen counter');
    assert.equal(tl[1].durationSec, 4);
    assert.deepEqual(buildTimeline({ shots: [], transcript }), []);
});

test('deep features: exact-cut keys only for measured files; Pegasus keys match user uploads; alignment keys', () => {
    const shots = shotsFromCuts([0.8, 1.6, 2.4, 7], 20);
    const scenes = [
        { startTime: 0, endTime: 2.5, onScreenText: 'WAIT', visualDescription: 'man talks to the camera', purpose: 'hook', audioSummary: 'speech' },
        { startTime: 2.5, endTime: 20, onScreenText: '', visualDescription: 'b-roll', purpose: 'cta', audioSummary: 'upbeat music' },
    ];
    const transcript = [{ text: 'stop scrolling right now', tStart: 0.2, tEnd: 1.4 }, { text: 'here is why', tStart: 8, tEnd: 9 }];
    const timeline = buildTimeline({ shots, scenes, transcript });
    const f = deepFeatures({ durationSec: 20, cutsSource: 'ffmpeg', shots, scenes, transcript, timeline, silences: [{ start: 10, end: 15 }], loudnessLufs: -14.23, hasAudio: true });
    assert.equal(f.shotCountExact, 5);
    assert.equal(f.firstCutSecExact, 0.8);
    assert.equal(f.cutsInFirst3sExact, 3);
    assert.equal(f.cutsPerMinExact, 12);
    assert.equal(f.cutsPerMinFirst10sExact, 24);
    assert.equal(f.shortShotShareExact, 0.6);
    assert.equal(f.firstSpeechSec, 0.2, 'transcript keys shared with user uploads');
    assert.equal(f.textInFirst2s, true, 'scene keys shared with user uploads');
    assert.equal(f.hookTextAndSpeech, true);
    assert.equal(f.wordsBeforeFirstCut, 2);
    assert.equal(f.silenceShare, 0.25);
    assert.equal(f.loudnessLufs, -14.2);
    assert.equal(f.hookEndSec, 2.5);
    assert.equal(f.hasCta, true);
    assert.equal(f.hasPayoff, false);

    const est = deepFeatures({ durationSec: 20, cutsSource: 'pegasus', shots: shotsFromScenes(scenes), scenes, transcript, timeline: [] });
    assert.equal(est.shotCountExact, undefined, 'no exact keys from estimated scene times');
    assert.equal(est.silenceShare, undefined);
});

test('captions: WebVTT and SRT timings, tags stripped, garbage ignored', () => {
    const vtt = 'WEBVTT\n\n1\n00:00:00.120 --> 00:00:01.900\nYou <b>need</b> this\n\n00:01.900 --> 00:03.000 align:start\ntrick\n\nNOTE x\n\nbroken --> line\n';
    assert.deepEqual(parseCaptions(vtt), [{ text: 'You need this', tStart: 0.12, tEnd: 1.9 }, { text: 'trick', tStart: 1.9, tEnd: 3 }]);
    assert.deepEqual(parseCaptions('1\r\n00:00:01,500 --> 00:00:02,000\r\nhello\r\n'), [{ text: 'hello', tStart: 1.5, tEnd: 2 }]);
    assert.deepEqual(parseCaptions(null), []);
});

test('pick pairs: best and worst from the same creator, clear gap only, least-analyzed creators first, niches take turns', () => {
    const vids = (prefix, views) => views.map((v, i) => ({ id: `${prefix}${i}`, views: v, durationSec: 30 }));
    const groups = [
        { creatorId: 'a', niche: 'food', baseline: 1000, analyzed: 4, videos: vids('a', [5000, 1000, 200]) },
        { creatorId: 'b', niche: 'food', baseline: 1000, analyzed: 0, videos: vids('b', [9000, 300]) },
        { creatorId: 'c', niche: 'tech', baseline: 1000, analyzed: 0, videos: vids('c', [1200, 900]) }, // gap too small
        { creatorId: 'd', niche: 'tech', baseline: 500, analyzed: 1, videos: [...vids('d', [4000, 100]), { id: 'dlong', views: 99999, durationSec: 600 }] },
        { creatorId: 'e', niche: 'pets', baseline: null, videos: vids('e', [1, 99999]) }, // no baseline
    ];
    const picks = pickPairs(groups, { limit: 6, maxDurationSec: 180 });
    assert.deepEqual(picks.map((p) => p.id), ['b0', 'b1', 'd0', 'd1', 'a0', 'a2']);
    assert.deepEqual(picks.map((p) => p.role), ['hit', 'miss', 'hit', 'miss', 'hit', 'miss']);
    assert.ok(picks.every((p) => p.id !== 'dlong'), 'videos over the length limit are skipped');
    assert.equal(pickPairs(groups, { limit: 2 }).length, 2);
    assert.ok(MIN_PAIR_GAP > 0.69 && MIN_PAIR_GAP < 0.7);
});

test('factor report: sign test across creator pairs, typical values, correlation; sorted by consistency', () => {
    const rows = [];
    for (let i = 0; i < 12; i++) {
        rows.push({ creatorId: `c${i}`, role: 'hit', outperformance: 1 + i / 10, features: { firstCutSecExact: 0.8, cutsPerMinExact: 20 + (i % 3), noise: i % 2 } });
        rows.push({ creatorId: `c${i}`, role: 'miss', outperformance: -1 - i / 10, features: { firstCutSecExact: 2.5, cutsPerMinExact: 20 + ((i + 1) % 3), noise: (i + 1) % 2 } });
    }
    const r = factorReport(rows);
    assert.equal(r.creatorsWithPairs, 12);
    const first = r.factors[0];
    assert.equal(first.feature, 'firstCutSecExact');
    assert.equal(first.pairs, 12);
    assert.equal(first.hitHigherShare, 0, 'hits always cut sooner');
    assert.ok(first.p < 0.001);
    assert.equal(first.medianHit, 0.8);
    assert.equal(first.medianMiss, 2.5);
    assert.ok(first.correlation < -0.8);
    assert.equal(first.status, 'early', 'under 30 pairs is early');
    assert.equal(signTestP(5, 10), 1);
    assert.ok(Math.abs(signTestP(0, 10) - 0.00195) < 0.0001);
    assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
    assert.equal(spearman([1, 2], [1, 2]), null);
});
