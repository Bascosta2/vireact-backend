import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';

const S = await import('../src/service/learning/media-signals.js');
const { pickPairs, OUTLIER_LOG, measuredVideoFeatures } = await import('../src/service/learning/deep-features.js');
const { hookFeatures } = await import('../src/service/learning/hook-vision.js');
const { intentShares } = await import('../src/service/learning/comments.js');
const { soundStage, buildSoundIndex, usesBefore, isOriginalSound } = await import('../src/service/learning/trends.js');
const { insightLines } = await import('../src/service/learning/insights.js');
const { capCreatorWeights, recencyWeight } = await import('../src/service/learning/model/trainer.js');

const frames = (scores, fps = 30) => scores.map((s, i) => ({ t: i / fps, scene: s }));

test('adaptive cuts: hard cuts, soft cuts far above the local baseline, no cuts in sustained motion, flash frames merged', () => {
    const quiet = Array(90).fill(0.002);
    quiet[30] = 0.6; // hard cut at 1.0 s
    quiet[60] = 0.12; // soft cut at 2.0 s (below the 0.3 threshold)
    assert.deepEqual(S.detectCuts(frames(quiet)), [1, 2]);
    assert.deepEqual(S.detectCuts(frames(quiet), { soft: 1.01 }), [1], 'a single threshold misses the soft cut');
    const motion = Array.from({ length: 90 }, (_, i) => 0.1 + 0.03 * Math.sin(i));
    assert.deepEqual(S.detectCuts(frames(motion)), [], 'sustained motion is not a cut');
    const flash = Array(60).fill(0.002);
    flash[20] = 0.5; flash[22] = 0.7;
    assert.deepEqual(S.detectCuts(frames(flash)), [0.733], 'two cuts within 0.2 s are one (the stronger)');
});

test('metadata parsing, picture stats, onsets, tempo and cut-on-beat alignment', () => {
    const text = 'frame:0    pts:0       pts_time:0\nlavfi.signalstats.YAVG=100\nlavfi.signalstats.YDIF=2\nlavfi.signalstats.SATAVG=40\nlavfi.scene_score=0.001\nframe:1    pts:1       pts_time:4\nlavfi.signalstats.YAVG=120\nlavfi.signalstats.YDIF=1\nlavfi.signalstats.SATAVG=50\nlavfi.scene_score=0.002\nframe:2 pts:2 pts_time:5\nlavfi.astats.Overall.RMS_level=-inf\n';
    const f = S.parseMetadataPrint(text);
    assert.equal(f[0].YAVG, 100);
    assert.equal(f[0].scene, 0.001);
    assert.equal(f[2].RMS_level, -Infinity);
    const pic = S.frameStats(f.slice(0, 2));
    assert.equal(pic.brightness, 110);
    assert.equal(pic.brightnessFirst3s, 100);
    assert.equal(pic.motionHookRatio, 2);
    // A beat every 0.5 s (120 BPM) on a ~46 ms envelope.
    const env = [];
    for (let i = 0; i < 260; i++) { const t = i * 0.0464; env.push({ t, db: (t % 0.5) < 0.05 ? -6 : -40 }); }
    const onsets = S.detectOnsets(env);
    assert.ok(onsets.length >= 20 && onsets.length <= 26, `onsets ${onsets.length}`);
    const bpm = S.estimateTempo(onsets, 12);
    assert.ok(Math.abs(bpm - 120) <= 4, `tempo ${bpm}`);
    const onBeat = S.beatAlignment([1, 2, 3, 4], onsets, 12);
    const offBeat = S.beatAlignment([1.25, 2.25, 3.25, 4.25], onsets, 12);
    assert.ok(onBeat.cutsOnBeatShare === 1 && onBeat.cutsOnBeatLift > 2, JSON.stringify(onBeat));
    assert.equal(offBeat.cutsOnBeatShare, 0);
    assert.deepEqual(S.beatAlignment([1], onsets, 12), {}, 'needs 3+ cuts');
});

test('language: stopwords and scripts; hashtags and short captions ignored', () => {
    assert.equal(S.detectLanguage('You need to try this recipe, it is so good and the kids love it'), 'en');
    assert.equal(S.detectLanguage('Mini SUV für 60k ohne Haubendämpfer, das ist nicht normal und ich bin sauer'), 'de');
    assert.equal(S.detectLanguage('La mejor receta de pollo que vas a probar en tu vida, es muy fácil'), 'es');
    assert.equal(S.detectLanguage('これは本当においしいラーメンです'), 'ja');
    assert.equal(S.detectLanguage('#fyp #viral #food'), null);
    assert.equal(S.detectLanguage('wow 🔥'), null);
});

test('pairs: lottery hits are kept out of pairs and studied as "viral"; least-covered niches first', () => {
    const vids = (prefix, views) => views.map((v, i) => ({ id: `${prefix}${i}`, views: v, durationSec: 30 }));
    const groups = [
        { creatorId: 'a', niche: 'food', baseline: 1000, analyzed: 0, videos: vids('a', [500000, 6000, 3000, 200]) }, // 500x = outlier
        { creatorId: 'b', niche: 'tech', baseline: 1000, analyzed: 0, videos: vids('b', [5000, 300]) },
    ];
    const picks = pickPairs(groups, { limit: 20, nicheDone: { food: 50, tech: 0 } });
    assert.deepEqual(picks.filter((p) => p.role !== 'viral').map((p) => p.id), ['b0', 'b1', 'a1', 'a3'], 'tech first (fewer pairs), food hit is the best non-outlier');
    assert.deepEqual(picks.filter((p) => p.role === 'viral').map((p) => p.id), ['a0']);
    assert.ok(picks.find((p) => p.id === 'a0').outperformance > OUTLIER_LOG);
    assert.equal(pickPairs(groups, { limit: 4 }).filter((p) => p.role === 'viral').length, 0, 'viral slots are 10% of the limit');
});

test('hook vision answers become features; comment intents weight liked comments; sound stages', () => {
    assert.deepEqual(hookFeatures({ faceSize: 'large', people: 1, framing: 'close_up', textOverlay: true, textWords: 6, visual: 'face_to_camera', changesAcrossFrames: 'small_change', eyeContact: true }), {
        hookFaceShare: 0.6, hookPeople: 1, hookCloseUp: true, hookTextOverlay: true, hookTextWords: 6, hookEyeContact: true, hookSceneChange: 1, hookVisual: 'face_to_camera',
    });
    assert.deepEqual(hookFeatures({ faceSize: 'huge' }), {});
    const shares = intentShares([{ intent: 'wants_more', likes: 1000 }, { intent: 'spam', likes: 0 }, { intent: 'nope', likes: 5 }]);
    assert.ok(shares.wants_more > 0.85 && shares.spam < 0.15);
    assert.equal(shares.n, 3);
    assert.equal(intentShares([]), null);
    assert.equal(soundStage({ last14: 5, prior14: 0, medianOutperformance: 0.4 }), 'emerging');
    assert.equal(soundStage({ last14: 9, prior14: 4, medianOutperformance: 0.2 }), 'rising');
    assert.equal(soundStage({ last14: 4, prior14: 4, medianOutperformance: -0.1 }), 'fading');
    assert.equal(soundStage({ last14: 2, prior14: 9 }), 'fading');
    assert.equal(soundStage({ last14: 1, prior14: 1 }), null);
    assert.ok(isOriginalSound('original sound - arta') && !isOriginalSound('Espresso'));
    const DAY = 86400000;
    const idx = buildSoundIndex([{ soundId: 's', soundTitle: 'Song', postedAt: new Date(10 * DAY) }, { soundId: 's', soundTitle: 'Song', postedAt: new Date(20 * DAY) }, { soundId: 'o', soundTitle: 'original sound', postedAt: new Date(20 * DAY) }]);
    assert.equal(usesBefore(idx, 's', 21 * DAY), 2);
    assert.equal(usesBefore(idx, 's', 20 * DAY), 1, 'the video itself is not counted');
    assert.equal(usesBefore(idx, 'o', 21 * DAY), 0, 'original sounds are not trends');
});

test('insight lines: only the analyzer\'s factors, with this video\'s value; weights capped per creator; recency', () => {
    const insights = [
        { niche: 'food', feature: 'firstCutSecExact', pairs: 42, hitHigherShare: 0.24, medianHit: 1.1, medianMiss: 2.6 },
        { niche: 'all', feature: 'textWhileSpeakingShare', pairs: 80, hitHigherShare: 0.7, medianHit: 0.8, medianMiss: 0.4 },
    ];
    const hook = insightLines(insights, { firstCutSecExact: 3.2 }, 'hook');
    assert.equal(hook.length, 1);
    assert.match(hook[0], /first cut: in food, a creator's stronger videos had less \(typical 1.1s vs 2.6s.*76% of 42 .*This video: 3.2s/);
    const caption = insightLines(insights, {}, 'caption');
    assert.match(caption[0], /on-screen text while talking: across niches.*80% vs 40%.*This video: not measured/);
    assert.deepEqual(insightLines(insights, {}, 'views_predictor'), []);
    const capped = capCreatorWeights([{ group: 'a', w: 6 }, { group: 'a', w: 6 }, { group: 'b', w: 1 }], 8);
    assert.deepEqual(capped.map((r) => r.w), [4, 4, 1]);
    const now = Date.UTC(2026, 10, 19);
    assert.equal(recencyWeight(new Date(now - 120 * 86400000), now, 120), 0.5);
    assert.equal(recencyWeight(new Date(now - 5000 * 86400000), now, 120), 0.05, 'floor');
});

test('user uploads: measured features line up with the Twelve Labs scenes and transcript', () => {
    const video = {
        scenes: [{ startTime: 0, endTime: 3, onScreenText: 'WAIT', visualDescription: 'face' }, { startTime: 3, endTime: 10, onScreenText: '', visualDescription: 'b-roll' }],
        rawTranscript: [{ text: 'stop scrolling now', tStart: 0.2, tEnd: 1.2 }],
    };
    const m = { durationSec: 10, cuts: [1.5, 3, 6], hardCuts: 2, silences: [{ start: 8, end: 10 }], hasAudio: true, loudnessLufs: -14, picture: { brightness: 120 }, rhythm: { tempoBpm: 100 }, hook: { hookFaceShare: 0.3 } };
    const f = measuredVideoFeatures(video, m);
    assert.equal(f.firstCutSecExact, 1.5);
    assert.equal(f.shotCountExact, 4);
    assert.equal(f.wordsBeforeFirstCut, 3);
    assert.equal(f.silenceShare, 0.2);
    assert.equal(f.brightness, 120);
    assert.equal(f.tempoBpm, 100);
    assert.equal(f.hookFaceShare, 0.3);
    assert.equal(f.softCutCount, 1);
    assert.equal(f.firstSpeechSec, undefined, 'Twelve Labs keys stay with featuresFromVideo');
    assert.deepEqual(measuredVideoFeatures(video, undefined), {});
});

test('measureMedia on a real clip: soft cut found, beats found, hook frames image', async () => {
    const { measureMedia } = await import('../src/service/learning/media-measure.js');
    const { ffmpeg } = await import('../src/lib/ffmpeg.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vx-signals-'));
    try {
        const file = path.join(dir, 'clip.mp4');
        await ffmpeg([
            '-f', 'lavfi', '-i', 'color=c=red:s=320x568:d=2:r=30', '-f', 'lavfi', '-i', 'testsrc2=s=320x568:d=2:r=30', '-f', 'lavfi', '-i', 'testsrc2=s=320x568:d=2:r=30',
            '-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,0.5),0.06),sin(2*PI*880*t),0)':d=6:s=44100",
            '-filter_complex', '[2]hue=h=25:s=0.8,eq=brightness=0.06[c];[0][1][c]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-map', '3',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '6', file,
        ]);
        const m = await measureMedia(file, { hookFrames: true, workDir: dir });
        assert.equal(m.cuts.length, 2, `cuts ${m.cuts}`);
        assert.ok(Math.abs(m.cuts[0] - 2) < 0.1 && Math.abs(m.cuts[1] - 4) < 0.1);
        assert.equal(m.cutsHardOnly.length, 1, 'the hue-shift cut is soft: a single threshold misses it');
        assert.ok(m.rhythm.onsetRate > 1.5, JSON.stringify(m.rhythm));
        assert.ok(Math.abs(m.rhythm.tempoBpm - 120) <= 5, JSON.stringify(m.rhythm));
        assert.ok(m.picture.brightness > 0 && m.picture.motion >= 0);
        assert.ok(m.hookImage && (await fs.stat(m.hookImage)).size > 1000);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
