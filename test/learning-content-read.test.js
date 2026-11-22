import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const C = await import('../src/service/learning/content-read.js');
const { featuresFromVideo, FEATURE_VERSION } = await import('../src/service/learning/features.js');
const { buildTimeline, deepFeatures, recomputeAnalysis, shotsFromCuts } = await import('../src/service/learning/deep-features.js');

const scenes = [
    { startTime: 0, endTime: 2.5, visualDescription: 'A woman in profile in a home gym, text reads "grow your booty"', primaryAction: 'exercises', onScreenText: 'grow your booty', audioSummary: 'upbeat pop song with female vocals', purpose: 'hook' },
    { startTime: 2.5, endTime: 13, visualDescription: 'She does glute bridges on a mat, close-up', primaryAction: 'demonstrates the move', onScreenText: '3 x 12', audioSummary: 'song continues with vocals', purpose: 'body' },
    { startTime: 13, endTime: 33, visualDescription: 'Wide shot of the finished set, she smiles', primaryAction: 'shows the result', onScreenText: '', audioSummary: 'song continues', purpose: 'payoff' },
];
const lyrics = [
    { text: 'My moon my man, take it easy on me', tStart: 5.3, tEnd: 12 },
    { text: 'please take it slow, my moon my man', tStart: 13, tEnd: 28 },
];

test('lyric heuristic: the sound title sung in the transcript, or scenes of singing with nobody talking', () => {
    assert.deepEqual(C.titleWords('My Moon My Man - Edit'), ['moon', 'man']);
    assert.deepEqual(C.titleWords('original sound - itsbelleirl'), [], 'an original sound has no song title to match');
    const h = C.lyricsHeuristic({ transcript: lyrics, scenes, soundTitle: 'My Moon My Man - Edit' });
    assert.deepEqual(h.speech, ['sung', 'sung']);
    assert.equal(h.audioType, 'music_with_lyrics');

    const talking = [{ ...scenes[0], audioSummary: 'a woman speaks to the camera over soft music' }];
    const said = [{ text: 'here is the one move you need', tStart: 0.2, tEnd: 2 }];
    assert.deepEqual(C.lyricsHeuristic({ transcript: said, scenes: talking, soundTitle: 'original sound' }).speech, ['spoken'], 'speech over music stays speech');
    assert.deepEqual(C.lyricsHeuristic({ transcript: said, scenes: [], soundTitle: null }).speech, ['spoken'], 'no evidence = speech (as before)');
});

test('readContent: model answers are normalized to the closed lists; a failed call falls back to the rules', async () => {
    let prompt = '';
    const complete = async ({ messages }) => {
        prompt = messages[0].content;
        return {
            audioType: 'music_with_lyrics',
            speech: [{ line: 1, kind: 'sung' }, { line: 2, kind: 'sung' }],
            scenes: [
                { scene: 1, setting: 'gym', subject: 'person_doing', shot: 'medium', energy: 'moderate', devices: [] },
                { scene: 2, setting: 'gym', subject: 'person_doing', shot: 'close_up', energy: 'intense', devices: ['demonstration', 'steps_or_list', 'not_a_device'] },
                { scene: 3, setting: 'gym', subject: 'person_doing', shot: 'wide', energy: 'calm', devices: ['reveal_or_result'] },
            ],
        };
    };
    const read = await C.readContent({ scenes, transcript: lyrics, soundTitle: 'My Moon My Man - Edit', caption: 'glutes' }, { complete });
    assert.match(prompt, /Sound: "My Moon My Man - Edit"/);
    assert.match(prompt, /1\. \[0-2\.5s\] visual: A woman in profile/);
    assert.match(prompt, /2\. \[13-28s\] "please take it slow/);
    assert.equal(read.source, 'model');
    assert.equal(read.version, C.CONTENT_READ_VERSION);
    assert.deepEqual(read.speech, ['sung', 'sung']);
    assert.deepEqual(read.scenes[1].devices, ['demonstration', 'steps_or_list'], 'values outside the list are dropped');

    const fallback = await C.readContent({ scenes, transcript: lyrics, soundTitle: 'My Moon My Man' }, { complete: async () => { throw new Error('down'); } });
    assert.equal(fallback.source, 'heuristic');
    assert.deepEqual(fallback.speech, ['sung', 'sung']);
    assert.deepEqual(fallback.scenes, [null, null, null]);
    assert.equal(await C.readContent({ scenes: [], transcript: [] }, { complete }), null, 'nothing to read');
});

const read = {
    version: 1, source: 'model', audioType: 'music_with_lyrics', speech: ['sung', 'sung'],
    scenes: [
        { setting: 'gym', subject: 'person_doing', shot: 'medium', energy: 'moderate', devices: [] },
        { setting: 'gym', subject: 'person_doing', shot: 'close_up', energy: 'intense', devices: ['demonstration', 'steps_or_list'] },
        { setting: 'home', subject: 'person_talking', shot: 'wide', energy: 'calm', devices: ['reveal_or_result'] },
    ],
};

test('description features: time-weighted shares, changes per minute, devices, the reveal time; lyrics are not speech', () => {
    const f = C.descriptionFeatures(read, { scenes, transcript: lyrics, durationSec: 33 });
    assert.equal(f.audioType, 'music_with_lyrics');
    assert.equal(f.lyricsShare, 1);
    assert.equal(f.hasSpokenWords, false);
    assert.equal(f.descSetting, 'home', 'the location with the most screen time (20 s of 33)');
    assert.equal(f.openingSubject, 'person_doing');
    assert.equal(f.descSettingCount, 2);
    assert.equal(f.descSubjectChangesPerMin, 1.82, 'one subject change in 33 s');
    assert.equal(f.descPersonShare, 1);
    assert.equal(f.descTalkingShare, 0.606);
    assert.equal(f.descCloseUpShare, 0.318);
    assert.equal(f.descIntenseShare, 0.318);
    assert.equal(f.descDemonstration, true);
    assert.equal(f.descReveal, true);
    assert.equal(f.descRevealSec, 13);
    assert.equal(f.descHumor, false);
    assert.equal(f.descVariety, 1);
    assert.deepEqual(C.descriptionFeatures(null, { scenes }), {});
});

test('a lyrics-only video has no speech features; the same video without a read keeps the old behaviour', () => {
    const shots = shotsFromCuts([2.458, 7.875, 13.167], 33);
    const withRead = deepFeatures({ durationSec: 33, cutsSource: 'ffmpeg', shots, scenes, transcript: lyrics, timeline: buildTimeline({ shots, scenes, transcript: lyrics, read }), read });
    assert.equal(withRead.speechWpm, undefined, 'lyrics are not a speaking speed');
    assert.equal(withRead.firstSpeechSec, undefined);
    assert.equal(withRead.speechCoverage, 0);
    assert.equal(withRead.wordsBeforeFirstCut, 0);
    assert.equal(withRead.lyricsShare, 1);
    assert.equal(withRead.descReveal, true);
    const timeline = buildTimeline({ shots, scenes, transcript: lyrics, read });
    assert.equal(timeline[1].said, '');
    assert.match(timeline[1].sung, /^My moon/, 'lyrics stay visible on the timeline, apart from speech');

    const without = deepFeatures({ durationSec: 33, cutsSource: 'ffmpeg', shots, scenes, transcript: lyrics, timeline: buildTimeline({ shots, scenes, transcript: lyrics }) });
    assert.ok(without.speechWpm > 0);
    assert.equal(without.lyricsShare, undefined);
});

test('a talking video with a song in the middle: only the spoken lines count as speech', () => {
    const mixed = [
        { text: 'three moves for your glutes', tStart: 0.3, tEnd: 2 },
        { text: 'my moon my man', tStart: 5, tEnd: 8 },
        { text: 'do twelve of each', tStart: 14, tEnd: 16 },
    ];
    const r = { ...read, audioType: 'mixed', speech: ['spoken', 'sung', 'spoken'] };
    const f = deepFeatures({ durationSec: 33, scenes, transcript: mixed, read: r });
    assert.equal(f.firstSpeechSec, 0.3);
    assert.equal(f.speechWpm, 16.4, '9 spoken words over 33 s');
    assert.equal(f.lyricsShare, 0.308, '4 of 13 words are lyrics');
    assert.equal(f.hasSpokenWords, true);
});

test('user uploads use the stored read; recomputeAnalysis rebuilds a stored deep analysis', () => {
    assert.equal(FEATURE_VERSION, 2);
    const video = { duration: 33, scenes, rawTranscript: lyrics, analysis: [], contentRead: read };
    const f = featuresFromVideo(video);
    assert.equal(f.speechWpm, undefined);
    assert.equal(f.descSetting, 'home');
    assert.equal(f.lyricsShare, 1);
    assert.ok(featuresFromVideo({ ...video, contentRead: undefined }).speechWpm > 0, 'no read = as before');

    const doc = {
        media: { durationSec: 33, hasAudio: true, loudnessLufs: -17 }, cutsSource: 'ffmpeg', cuts: [2.458, 7.875, 13.167], scenes, transcript: lyrics,
        silences: [], hookVision: { faceSize: 'none', people: 1, framing: 'medium', textOverlay: true, textWords: 4, visual: 'person_doing_action', changesAcrossFrames: 'new_scene', eyeContact: false },
        features: { softCutCount: 1, speechWpm: 41.3 },
    };
    const { timeline, features } = recomputeAnalysis(doc, read);
    assert.equal(timeline.length, 4);
    assert.equal(features.speechWpm, undefined, 'the stale lyrics-based speed is gone');
    assert.equal(features.softCutCount, 1, 'kept from the stored analysis');
    assert.equal(features.hookTextOverlay, true, 'hook features rebuilt from the stored frame description');
    assert.equal(features.shotCountExact, 4);
    assert.equal(features.descRevealSec, 13);
    assert.ok(C.SPEECH_KEYS.includes('speechWpm'));
});
