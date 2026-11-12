import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectTestDb, disconnectTestDb } from './helpers/test-db.js';
import { ffmpeg } from '../src/lib/ffmpeg.js';
import { VideoPerformanceDataset } from '../src/model/VideoPerformanceDataset.model.js';
import { KnowledgeBase } from '../src/model/knowledge-base.model.js';
import { cosine, nicheBenchmarks, rankExemplars, selectExemplars } from '../src/service/editor/exemplars.js';
import { measureEdit, profileExample, profileText, PROFILE_SCHEMA } from '../src/service/editor/exemplar-profile.service.js';
import { formatExemplars, formatTranscript, formatCandidates } from '../src/service/editor/edit-planner.service.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vireact-examples-test-'));
before(async () => { await connectTestDb(); });
after(async () => {
    await disconnectTestDb();
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('cosine similarity basics', () => {
    assert.equal(cosine([1, 0], [1, 0]), 1);
    assert.equal(cosine([1, 0], [0, 1]), 0);
    assert.equal(cosine([1, 0], [1]), 0);
});

test('rankExemplars balances similarity and real performance, boosts same platform and niche', () => {
    const pool = [
        { _id: 'a', platform: 'tiktok', niche: 'fitness_health', actualViews: 5_000_000, editEmbedding: [0, 1] },
        { _id: 'b', platform: 'tiktok', niche: 'fitness_health', actualViews: 400_000, editEmbedding: [1, 0] },
        { _id: 'c', platform: 'youtube', niche: 'tech', actualViews: 9_000_000, editEmbedding: [0, 1] },
    ];
    const similar = rankExemplars(pool, [1, 0], { platform: 'tiktok', niche: 'fitness_health', count: 3 });
    assert.equal(similar[0]._id, 'b', 'closest match wins when performance is comparable');
    const byPerf = rankExemplars(pool, null, { count: 3 });
    assert.equal(byPerf[0]._id, 'c', 'without a query vector, most-viewed wins');
});

test('nicheBenchmarks uses the niche when it has 3+ examples, else everything', () => {
    const mk = (niche, views, shot) => ({ niche, actualViews: views, editProfile: { avgShotSec: shot, cutsPerMin: 20, zoomsPerMin: 4, speechWpm: 180, durationSec: 30 } });
    const pool = [mk('food', 100, 1), mk('food', 200, 2), mk('food', 300, 3), mk('tech', 1000, 9)];
    assert.equal(nicheBenchmarks(pool, 'food').scope, 'top food examples');
    assert.equal(nicheBenchmarks(pool, 'tech').scope, 'top examples across niches');
});

test('measureEdit computes shot length, cut rate, pace and aspect', () => {
    const m = measureEdit({
        info: { durationSec: 30, width: 1080, height: 1920 },
        sceneCuts: [3, 6, 9, 12, 15],
        silences: [{ start: 1, end: 2.5 }],
        words: Array.from({ length: 60 }, (_, i) => ({ w: 'x', start: i * 0.4, end: i * 0.4 + 0.3 })),
    });
    assert.equal(m.avgShotSec, 5);
    assert.equal(m.cutsPerMin, 10);
    assert.equal(m.aspect, '9:16');
    assert.equal(m.pauseRatio, 5);
    assert.ok(m.speechWpm > 140 && m.speechWpm < 160);
});

test('profile schema is strict', () => {
    assert.equal(PROFILE_SCHEMA.additionalProperties, false);
    assert.deepEqual([...PROFILE_SCHEMA.required].sort(), Object.keys(PROFILE_SCHEMA.properties).sort());
});

test('profileExample on a real clip: measures, asks Claude with frames, embeds, stores profile and an editing KB entry', { timeout: 120_000 }, async () => {
    const clip = path.join(tmp, 'viral.mp4');
    await ffmpeg([
        '-f', 'lavfi', '-i', 'color=c=red:s=720x1280:r=30:d=3',
        '-f', 'lavfi', '-i', 'color=c=blue:s=720x1280:r=30:d=3',
        '-f', 'lavfi', '-i', 'color=c=green:s=720x1280:r=30:d=3',
        '-f', 'lavfi', '-i', "aevalsrc='0.4*sin(2*PI*330*t)':s=44100:d=9",
        '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-map', '3:a',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip,
    ]);
    const doc = await VideoPerformanceDataset.create({ sourceType: 'creator_video', platform: 'tiktok', niche: 'food', actualViews: 2_400_000, shares: 30_000, editProfileStatus: 'pending' });
    const calls = [];
    const result = await profileExample(doc._id, clip, {
        transcribe: async () => ({ words: [{ w: 'Watch', start: 0.2, end: 0.5 }, { w: 'this', start: 0.55, end: 0.8 }] }),
        request: async (params) => {
            calls.push(params);
            return { data: { captionStyle: 'white bold centered', captionDensity: 'word_by_word', zoomsPerMin: 6, textOverlayUse: 'step numbers', hookPattern: 'result first', hookFirst2s: 'finished dish fills the frame', musicPresence: 'background', sfxUse: 'whoosh on cuts', pacingNotes: 'cut every 3 seconds', summary: 'Show the finished dish first, then cut every 3 seconds.' } };
        },
        embed: async () => [0.1, 0.2, 0.3],
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(calls[0].label, 'editor_exemplar_profile');
    assert.ok(calls[0].messages[0].content.some((b) => b.type === 'image'), 'frames sent to Claude');

    const saved = await VideoPerformanceDataset.findById(doc._id).select('+editEmbedding').lean();
    assert.equal(saved.editProfileStatus, 'ready');
    assert.equal(saved.editProfile.aspect, '9:16');
    assert.ok(saved.editProfile.cutsPerMin > 0, 'scene cuts measured');
    assert.equal(saved.editProfile.hookPattern, 'result first');
    assert.deepEqual(saved.editEmbedding, [0.1, 0.2, 0.3]);
    const kb = await KnowledgeBase.findOne({ 'metadata.source': `editor_example:${doc._id}` }).lean();
    assert.equal(kb.metadata.topic, 'editing');
    assert.match(kb.content, /2,400,000 views/);

    // The editor can now pick it.
    const picked = await selectExemplars({ description: 'food recipe', platform: 'tiktok', niche: 'food' }, { embed: async () => [0.1, 0.2, 0.3] });
    assert.ok(picked.exemplars.some((e) => String(e._id) === String(doc._id)));
    assert.ok(!('editEmbedding' in picked.exemplars[0]), 'embeddings never reach the prompt');
    assert.match(formatExemplars(picked.exemplars, picked.benchmarks), /2,400,000 views/);
    await KnowledgeBase.deleteMany({ 'metadata.source': `editor_example:${doc._id}` });
});

test('profileExample stores the failure instead of throwing', async () => {
    const doc = await VideoPerformanceDataset.create({ sourceType: 'creator_video', platform: 'tiktok', actualViews: 10 });
    const r = await profileExample(doc._id, path.join(tmp, 'missing.mp4'));
    assert.equal(r.ok, false);
    const saved = await VideoPerformanceDataset.findById(doc._id).lean();
    assert.equal(saved.editProfileStatus, 'failed');
    assert.ok(saved.editProfileError);
});

test('prompt formatters', () => {
    assert.match(formatTranscript([{ w: 'Hi', start: 0, end: 0.4 }]), /\[0\] 0\.00-0\.40 Hi/);
    assert.match(formatTranscript([]), /No speech/);
    assert.equal(formatCandidates([{ id: 'c1', kind: 'filler', start: 1, end: 1.2, text: 'um' }]), 'c1 filler 1.00-1.20 "um"');
    assert.match(formatExemplars([], null), /No viral examples/);
    assert.match(profileText({ platform: 'tiktok', actualViews: 5 }, { durationSec: 9, aspect: '9:16', avgShotSec: 3, cutsPerMin: 20, zoomsPerMin: 0, speechWpm: 0, hookPattern: 'x', hookFirst2s: 'y', captionStyle: 'z', captionDensity: 'none', textOverlayUse: 'n', musicPresence: 'none', sfxUse: 'n', pacingNotes: 'p', summary: 's' }), /What to copy: s/);
});
