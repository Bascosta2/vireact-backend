import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sceneFeatures, transcriptFeatures, featuresFromVideo, featuresFromDataset, featuresFromSocial, FEATURE_VERSION } from '../src/service/learning/features.js';
import { outcomeAtHorizon, baselineFor, creatorBaseline, outperformance, median } from '../src/service/learning/labels.js';
import { metrics, metricsBy, timeSplit, checkOwnerCases, promotionDecision } from '../src/service/learning/evaluate.js';
import { buildCollectionPlan, nextCheckAt, queryFor } from '../src/service/learning/social/collector.js';
import { cleanVideo, cleanCreator, cleanStats } from '../src/service/learning/social/providers.js';
import { toLabels } from '../src/service/learning/classifier.js';
import { NICHE_TREE, TAXONOMY_NICHES, subNicheOf, formatFromStrategy } from '../src/constants/taxonomy.js';
import { NICHES } from '../src/constants/library.js';

const DAY = 24 * 60 * 60 * 1000;

const scenes = [
    { startTime: 0, endTime: 1.2, onScreenText: 'Stop doing this', visualDescription: 'A woman talks directly to the camera', audioSummary: 'whoosh sound effect' },
    { startTime: 1.2, endTime: 3, onScreenText: '', visualDescription: 'Zoom in on the laptop', audioSummary: 'upbeat music' },
    { startTime: 3, endTime: 5, onScreenText: 'Step 2', visualDescription: 'b-roll of a desk', audioSummary: 'voice' },
    { startTime: 5, endTime: 10, onScreenText: '', visualDescription: 'She smiles', audioSummary: 'music fades' },
];

test('taxonomy: keeps the existing niche keys and every sub-niche belongs to one niche', () => {
    for (const n of NICHES) assert.ok(TAXONOMY_NICHES.includes(n), `legacy niche ${n} still exists`);
    assert.equal(subNicheOf('fitness_health', 'gym_training'), 'gym_training');
    assert.equal(subNicheOf('food', 'gym_training'), null, 'sub-niche from another niche is refused');
    assert.equal(formatFromStrategy('skit'), 'pov_skit');
    assert.equal(formatFromStrategy('nonsense'), null);
    assert.ok(Object.values(NICHE_TREE).every((subs) => subs.length >= 1));
});

test('scene features: cut speed, opening, text, music, zoom', () => {
    const f = sceneFeatures(scenes, 10);
    assert.equal(f.sceneCount, 4);
    assert.equal(f.avgShotSec, 2.5);
    assert.equal(f.cutsPerMin, 18);
    assert.equal(f.firstCutSec, 1.2);
    assert.equal(f.longestShotSec, 5);
    assert.equal(f.textInFirst2s, true);
    assert.equal(f.toCameraOpening, true);
    assert.equal(f.onScreenTextShare, 0.5);
    assert.equal(f.musicShare, 0.5);
    assert.equal(f.zoomShare, 0.25);
    assert.deepEqual(sceneFeatures([], 10), {});
});

test('transcript features read the stored { text, tStart, tEnd } shape and the SDK shape', () => {
    const stored = [{ text: 'Stop doing this right now', tStart: 0.4, tEnd: 2 }, { text: 'here is why it fails', tStart: 2, tEnd: 4 }];
    const f = transcriptFeatures(stored, 10);
    assert.equal(f.firstSpeechSec, 0.4);
    assert.equal(f.speechWpm, 60);
    assert.equal(f.speechCoverage, 0.36);
    assert.equal(f.openingWords, 10);
    assert.deepEqual(transcriptFeatures([{ value: 'hi there', start: 1, end: 2 }], 10).firstSpeechSec, 1);
    assert.deepEqual(transcriptFeatures([], 10), { speechCoverage: 0 }, 'a silent video is a fact, not missing');
});

test('features from a user video, an admin example and a public video share the same keys', () => {
    const video = {
        duration: 10, scenes, rawTranscript: [{ text: 'Stop doing this', tStart: 0.2, tEnd: 1.5 }],
        analysis: [{ feature: 'hook', score: 81 }, { feature: 'pacing', score: 74 }], viralityScore: 72,
        sourceDescription: 'Desk tips #productivity #wfh', postedAt: '2026-11-10T15:00:00Z', contentProfile: { format: 'tutorial', hookType: 'mistake_warning' },
    };
    const f = featuresFromVideo(video);
    assert.equal(f.hookScore, 81);
    assert.equal(f.viralityScore, 72);
    assert.equal(f.hashtagCount, 2);
    assert.equal(f.postHourUtc, 15);
    assert.equal(f.strategyFormat, 'tutorial');
    assert.equal(f.strategyHook, 'mistake_warning');
    assert.ok(f.sfxShare > 0);
    assert.ok(!('audioScore' in f), 'missing scores stay missing');

    const d = featuresFromDataset({ editProfile: { avgShotSec: 1.4, cutsPerMin: 42, speechWpm: 190, durationSec: 22, musicPresence: 'high', sfxUse: 'some whooshes' }, hookScore: 88 });
    assert.equal(d.cutsPerMin, 42);
    assert.equal(d.musicLevel, 1);
    assert.equal(d.sfxLevel, 0.5);
    assert.equal(d.durationSec, 22);

    const s = featuresFromSocial({ durationSec: 31, caption: 'POV: you finally fixed it #fyp #desk', soundTitle: 'original sound - me', postedAt: new Date('2026-11-01T20:00:00Z') });
    assert.equal(s.hashtagCount, 2);
    assert.equal(s.originalSound, true);
    assert.equal(s.postWeekdayUtc, 0);
    assert.equal(FEATURE_VERSION, 1);
});

test('labels: settled reading nearest 7 days; baseline from the creator, else followers', () => {
    const snaps = [{ views: 100, ageHours: 20 }, { views: 900, ageHours: 70 }, { views: 1500, ageHours: 160 }, { views: 1700, ageHours: 400 }];
    assert.deepEqual(outcomeAtHorizon(snaps), { views: 1500, ageHours: 160, ageKnown: true, source: null });
    assert.equal(outcomeAtHorizon([{ views: 100, ageHours: 20 }]), null, 'still climbing');
    assert.equal(outcomeAtHorizon([{ views: 5, capturedAt: new Date(1) }, { views: 50, capturedAt: new Date(2) }]).views, 50);
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(creatorBaseline([10, 20]), null);
    assert.deepEqual(baselineFor({ otherViews: [100, 300, 200] }), { views: 200, n: 3, method: 'creator_median' });
    assert.equal(baselineFor({ followers: 9000 }).method, 'followers');
    assert.equal(baselineFor({}), null);
    assert.ok(Math.abs(outperformance(399, 199) - Math.log(2)) < 1e-9, '2x the usual = ln 2');
});

test('report card metrics: miss factor, within 2x, band coverage, bias, groups, time split', () => {
    const now = Date.UTC(2026, 10, 17);
    const rows = [
        { actual: 1000, predicted: { low: 500, expected: 1000, high: 3000 }, platform: 'tiktok', at: new Date(now - 2 * DAY) },
        { actual: 4000, predicted: { low: 500, expected: 1000, high: 3000 }, platform: 'tiktok', at: new Date(now - 30 * DAY) },
        { actual: 600, predicted: { low: 500, expected: 1000, high: 3000 }, platform: 'youtube', at: new Date(now - 40 * DAY) },
        { actual: null, predicted: { expected: 1000 } },
    ];
    const m = metrics(rows);
    assert.equal(m.n, 3);
    assert.equal(m.coverage, 0.667);
    assert.equal(m.within2x, 0.667);
    assert.ok(m.typicalMiss > 1.6 && m.typicalMiss < 1.7, String(m.typicalMiss));
    assert.ok(m.bias > 1, 'under-predicting on average');
    assert.deepEqual(Object.keys(metricsBy(rows, 'platform', { minN: 2 })), ['tiktok']);
    const { train, test: recent } = timeSplit(rows.slice(0, 3), { now, testDays: 14 });
    assert.equal(recent.length, 1);
    assert.equal(train.length, 2);
    assert.deepEqual(metrics([]), { n: 0, typicalMiss: null, within2x: null, coverage: null, bias: null });
});

test("the owner's calibration cases pass on today's model and gate any replacement", () => {
    const cases = checkOwnerCases();
    assert.equal(cases.length, 2);
    assert.ok(cases.every((c) => c.pass), JSON.stringify(cases));
    const champion = { n: 200, typicalMiss: 3, coverage: 0.7 };
    const better = { n: 200, typicalMiss: 2.5, coverage: 0.8 };
    assert.equal(promotionDecision({ champion, challenger: better, ownerCases: cases }).promote, true);
    assert.equal(promotionDecision({ champion, challenger: { ...better, coverage: 0.95 }, ownerCases: cases }).promote, false, 'bands too wide');
    assert.equal(promotionDecision({ champion, challenger: { ...better, typicalMiss: 2.99 }, ownerCases: cases }).promote, false, 'not clearly better');
    assert.equal(promotionDecision({ champion, challenger: { ...better, n: 10 }, ownerCases: cases }).promote, false, 'too little evidence');
    assert.equal(promotionDecision({ champion, challenger: better, ownerCases: [{ id: 'x', pass: false }] }).promote, false);
});

test('collection plan rotates through every sub-niche and re-checks at 1, 3 and 7 days', () => {
    const seen = new Set();
    for (let d = 0; d < 6; d++) for (const q of buildCollectionPlan({ now: d * DAY })) seen.add(q.subNiche);
    const all = Object.entries(NICHE_TREE).filter(([n]) => n !== 'other').flatMap(([, s]) => s);
    assert.equal(seen.size, all.length, 'six days cover the whole tree');
    assert.equal(buildCollectionPlan({ now: 0, weights: { gaming: 0 } }).some((q) => q.niche === 'gaming'), false);
    assert.equal(buildCollectionPlan({ now: 0, weights: { food: 2 } }).filter((q) => q.niche === 'food').length, 2);
    assert.equal(queryFor('grwm'), 'get ready with me');
    const posted = Date.UTC(2026, 10, 1);
    assert.equal(nextCheckAt(posted, posted).getTime(), posted + 24 * 3600e3);
    assert.equal(nextCheckAt(posted, posted + 2 * DAY).getTime(), posted + 72 * 3600e3);
    assert.equal(nextCheckAt(posted, posted + 8 * DAY), null);
    assert.equal(nextCheckAt(null, posted), null);
});

test('provider data is validated before it can be stored', () => {
    assert.equal(cleanVideo({ externalId: '../../etc' }), null);
    assert.equal(cleanVideo({}), null);
    const v = cleanVideo({ externalId: 7301, url: 'http://insecure.example', views: -5, likes: '12', durationSec: 99999, postedAt: 1762000000, hashtags: ['#FYP', '', 'x'.repeat(300)], caption: 'a'.repeat(3000) });
    assert.equal(v.externalId, '7301');
    assert.equal(v.url, null);
    assert.equal(v.views, null);
    assert.equal(v.likes, 12);
    assert.equal(v.durationSec, null);
    assert.ok(v.postedAt instanceof Date);
    assert.deepEqual(v.hashtags, ['fyp', 'x'.repeat(100)]);
    assert.equal(v.caption.length, 2200);
    assert.equal(cleanCreator({ externalId: 'abc', followers: 'many' }).followers, null);
    assert.equal(cleanStats({ externalId: 'abc' }), null, 'stats need views');
});

test('classifier output: closed lists, sub-niche must match the niche, unsure goes to other', () => {
    const refs = new Map([['V1', {}], ['V2', {}], ['V3', {}]]);
    const out = toLabels([
        { ref: 'V1', niche: 'fitness_health', subNiche: 'gym_training', format: 'tutorial', hookPattern: 'bold_claim', confidence: 0.9 },
        { ref: 'V2', niche: 'food', subNiche: 'gym_training', format: 'made_up', hookPattern: 'question', confidence: 0.8 },
        { ref: 'V3', niche: 'tech', subNiche: 'ai_tools', format: 'tutorial', hookPattern: 'none', confidence: 0.2 },
        { ref: 'V9', niche: 'tech', subNiche: 'ai_tools', format: 'tutorial', hookPattern: 'none', confidence: 0.9 },
    ], refs);
    assert.equal(out.get('V1').subNiche, 'gym_training');
    assert.equal(out.get('V2').subNiche, null);
    assert.equal(out.get('V2').format, 'other');
    assert.equal(out.get('V3').niche, 'other');
    assert.equal(out.has('V9'), false, 'unknown refs are ignored');
});
