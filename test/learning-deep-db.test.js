import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
console.warn = () => {};
console.log = () => {};

const { connectTestDb, disconnectTestDb } = await import('./helpers/test-db.js');
const { VideoFeatures, OutcomeSnapshot, SocialCreator, SocialVideo, SocialVideoAnalysis } = await import('../src/model/learning.model.js');
const { runDeepAnalysis, measureVideo, downloadVideo } = await import('../src/service/learning/deep-analyzer.js');
const { runCollection } = await import('../src/service/learning/social/collector.js');
const { deepOverview, deepDetail } = await import('../src/service/learning/learning.service.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 19, 12);

before(async () => {
    await connectTestDb();
    await Promise.all([VideoFeatures, OutcomeSnapshot, SocialCreator, SocialVideo, SocialVideoAnalysis].map((m) => m.syncIndexes()));
});
after(disconnectTestDb);

const seedCreator = async (key, viewsList, { niche = 'food' } = {}) => {
    const creator = await SocialCreator.create({ platform: 'tiktok', externalId: key, handle: `${key}_h`, followers: 20000, niche, baselineViews: 1000, baselineN: 6 });
    const videos = [];
    for (const [i, views] of viewsList.entries()) {
        const v = await SocialVideo.create({
            platform: 'tiktok', externalId: `${key}-${i}`, creatorId: creator._id, creatorExternalId: key, url: `https://www.tiktok.com/@${key}/video/${i}`,
            caption: `clip ${i} #food`, durationSec: 30, postedAt: new Date(NOW - (20 + i) * DAY), provider: 'fake', discoveredVia: 'creator_backfill',
            latest: { views, at: new Date(NOW - DAY) },
        });
        await VideoFeatures.create({ subjectType: 'social', subjectId: v._id, platform: 'tiktok', featureVersion: 1, features: { captionChars: 12, hashtagCount: 1 } });
        videos.push(v);
    }
    return { creator, videos };
};

const fakeTwelveLabs = () => {
    const deleted = [];
    return {
        deleted,
        model: 'pegasus-test',
        createFromFile: async () => ({ id: `file-${deleted.length}-${Math.random()}`, status: 'ready' }),
        createFromUrl: async () => ({ id: `url-${Math.random()}`, status: 'processing' }),
        waitReady: async () => {},
        scenes: async () => [
            { startTime: 0, endTime: 2, onScreenText: 'WAIT FOR IT', visualDescription: 'close-up of a man talking to the camera', primaryAction: 'talks', purpose: 'hook' },
            { startTime: 2, endTime: 12, onScreenText: '', visualDescription: 'kitchen', primaryAction: 'bakes', purpose: 'payoff' },
        ],
        transcript: async () => [{ text: 'you need this trick', tStart: 0.3, tEnd: 1.5 }],
        deleteAsset: async (id) => { deleted.push(id); },
    };
};

test('deep run: picks a hit and a miss per creator, analyzes them, keeps no file, records failures, merges features', async () => {
    const a = await seedCreator('ca', [9000, 1500, 800, 100]);
    const b = await seedCreator('cb', [7000, 150], { niche: 'tech' });
    const statsCalls = [];
    const provider = {
        name: 'fake',
        async videoStats({ ids }) {
            statsCalls.push(ids);
            return {
                stats: ids.map((externalId) => ({ externalId, views: 12345 })),
                // cb-1 (b's miss) comes back without a file link.
                extras: ids.map((externalId) => ({
                    externalId, videoUrl: externalId === 'cb-1' ? null : `https://v16-webapp-prime.tiktok.com/${externalId}.mp4`,
                    captions: [{ text: 'hello there', tStart: 0.4, tEnd: 1 }], subtitle: { language: 'eng-US' }, topComments: [{ text: 'part 2', likes: 3 }],
                })),
                used: ids.length,
            };
        },
    };
    const tl = fakeTwelveLabs();
    const download = async (url, token, dest) => {
        if (url.includes('cb-0')) throw new Error('download 403'); // falls back to Twelve Labs fetching the link
        await fs.writeFile(dest, 'x'.repeat(20000));
        return { path: dest, bytes: 20000 };
    };
    const measure = async () => ({ info: { durationSec: 12, hasAudio: true, width: 720, height: 1280, fps: 30 }, cuts: [2, 5, 8], silences: [{ start: 9, end: 12 }], loudnessLufs: -13 });

    const out = await runDeepAnalysis({ provider, limit: 10, concurrency: 2, now: NOW, deps: { twelveLabs: tl, download, measure } });
    assert.equal(out.picked, 4);
    assert.equal(out.used, 4);
    assert.equal(out.analyzed, 3);
    assert.equal(out.exactCuts, 2);
    assert.equal(out.viaUrl, 1);
    assert.equal(out.failed, 1);
    assert.equal(tl.deleted.length, 3, 'every Twelve Labs asset is deleted');

    const hit = await SocialVideoAnalysis.findOne({ externalId: 'ca-0' }).lean();
    assert.equal(hit.role, 'hit');
    assert.equal(hit.cutsSource, 'ffmpeg');
    assert.deepEqual(hit.cuts, [2, 5, 8]);
    assert.equal(hit.timeline.length, 4);
    assert.equal(hit.timeline[0].said, 'you need this trick');
    assert.equal(hit.timeline[0].onScreenText, 'WAIT FOR IT');
    assert.equal(hit.features.shotCountExact, 4);
    assert.equal(hit.features.silenceShare, 0.25);
    assert.ok(Math.abs(hit.outperformance - Math.log(9001 / 1001)) < 0.001);
    const miss = await SocialVideoAnalysis.findOne({ externalId: 'ca-3' }).lean();
    assert.equal(miss.role, 'miss');
    const viaUrl = await SocialVideoAnalysis.findOne({ externalId: 'cb-0' }).lean();
    assert.equal(viaUrl.cutsSource, 'pegasus');
    assert.equal(viaUrl.features.shotCountExact, undefined);

    const vf = await VideoFeatures.findOne({ subjectId: a.videos[0]._id }).lean();
    assert.ok(vf.deepAt);
    assert.equal(vf.features.captionChars, 12, 'existing features kept');
    assert.equal(vf.features.firstSpeechSec, 0.3, 'Twelve Labs transcript features');
    assert.equal(vf.features.speechFromCaptions, false);

    const failed = await SocialVideo.findOne({ externalId: 'cb-1' }).lean();
    assert.equal(failed.deep.status, 'failed');
    assert.match(failed.deep.error, /no video link/);
    const refreshed = await SocialVideo.findOne({ externalId: 'ca-0' }).lean();
    assert.equal(refreshed.latest.views, 12345, 'the link fetch is also a new reading');
    assert.equal(refreshed.captions[0].text, 'hello there');
    assert.equal(refreshed.captionsLang, 'eng-US');
    assert.equal(refreshed.deep.status, 'done');
    assert.equal(await OutcomeSnapshot.countDocuments({ subjectId: a.videos[0]._id }), 1);

    // Next run: ca's remaining videos (1500 vs 800) are too close to pair; nothing analyzed twice.
    const again = await runDeepAnalysis({ provider, limit: 10, now: NOW, deps: { twelveLabs: fakeTwelveLabs(), download, measure } });
    assert.equal(again.picked, 0);

    const overview = await deepOverview();
    assert.equal(overview.analyzed, 3);
    assert.equal(overview.failed, 1);
    assert.equal(overview.exactCuts, 2);
    const detail = await deepDetail(String(hit._id));
    assert.equal(detail.creator.handle, 'ca_h');
    assert.equal(detail.video.topComments[0].text, 'part 2');
    assert.equal(await deepDetail('nope'), null);
    void b;
});

test('deep run: skipped without a provider or Twelve Labs key', async () => {
    assert.equal((await runDeepAnalysis({ provider: null })).skipped, 'no provider configured');
    const prev = process.env.TWELVE_LABS_API_KEY;
    delete process.env.TWELVE_LABS_API_KEY;
    assert.equal((await runDeepAnalysis({ provider: { videoStats: async () => ({}) } })).skipped, 'TWELVE_LABS_API_KEY not set');
    if (prev !== undefined) process.env.TWELVE_LABS_API_KEY = prev;
});

test('re-checks keep TikTok captions and comments; caption speech features only where there is no deep analysis', async () => {
    const creator = await SocialCreator.create({ platform: 'tiktok', externalId: 'rc', handle: 'rc_h' });
    const v = await SocialVideo.create({
        platform: 'tiktok', externalId: 'rc-1', creatorId: creator._id, url: 'https://www.tiktok.com/@rc/video/1', durationSec: 20,
        postedAt: new Date(NOW - 3 * DAY), provider: 'fake', discoveredVia: 'search', nextCheckAt: new Date(NOW - 1000),
    });
    await VideoFeatures.create({ subjectType: 'social', subjectId: v._id, platform: 'tiktok', featureVersion: 1, features: { captionChars: 5 } });
    const provider = {
        name: 'fake',
        searchVideos: async () => ({ videos: [], creators: [], used: 0 }),
        creatorVideos: async () => ({ videos: [], creator: null, used: 0 }),
        videoStats: async ({ ids }) => ({
            stats: ids.map((externalId) => ({ externalId, views: 500 })),
            extras: ids.map((externalId) => ({ externalId, captions: [{ text: 'one two three four', tStart: 1.2, tEnd: 2 }], subtitle: { language: 'eng-US' }, region: 'US', topComments: [] })),
            used: ids.length,
        }),
    };
    const out = await runCollection({ provider, budget: 100, now: NOW, plan: [] });
    assert.equal(out.captions, 1);
    const saved = await SocialVideo.findById(v._id).lean();
    assert.equal(saved.captions.length, 1);
    assert.equal(saved.region, 'US');
    const vf = await VideoFeatures.findOne({ subjectId: v._id }).lean();
    assert.equal(vf.features.firstSpeechSec, 1.2);
    assert.equal(vf.features.speechFromCaptions, true);
    assert.equal(vf.features.captionChars, 5);
});

test('measureVideo: exact cuts, audio and duration from a real clip (bundled ffmpeg)', async () => {
    const { ffmpeg } = await import('../src/lib/ffmpeg.js');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vx-deep-test-'));
    try {
        const file = path.join(dir, 'clip.mp4');
        await ffmpeg([
            '-f', 'lavfi', '-i', 'color=c=red:s=320x568:d=2:r=30', '-f', 'lavfi', '-i', 'color=c=blue:s=320x568:d=2:r=30',
            '-f', 'lavfi', '-i', 'color=c=green:s=320x568:d=2:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
            '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0[v];[3]apad=whole_dur=6[a]', '-map', '[v]', '-map', '[a]',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '6', file,
        ]);
        const m = await measureVideo(file);
        assert.ok(Math.abs(m.info.durationSec - 6) < 0.2);
        assert.equal(m.info.hasAudio, true);
        assert.equal(m.cuts.length, 2);
        assert.ok(Math.abs(m.cuts[0] - 2) < 0.1 && Math.abs(m.cuts[1] - 4) < 0.1, `cuts at ${m.cuts}`);
        assert.ok(m.silences.some((s) => s.start > 2.5 && s.start < 3.5), 'the silent second half is found');
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test('downloadVideo: refuses non-TikTok links, redirects off TikTok, non-video replies and oversized files', async () => {
    const dest = path.join(os.tmpdir(), `vx-dl-${Date.now()}.mp4`);
    await assert.rejects(downloadVideo('https://evil.example.com/a.mp4', null, dest), /not a TikTok media host/);
    const reply = (headers, body = 'x'.repeat(20000), url = 'https://v16.tiktokcdn.com/a.mp4') => async () => ({
        ok: true, status: 200, url, headers: { get: (k) => headers[k.toLowerCase()] ?? null },
        body: new Blob([body]).stream(),
    });
    await assert.rejects(downloadVideo('https://v16.tiktokcdn.com/a.mp4', null, dest, { fetchImpl: reply({}, 'x', 'https://evil.example.com/') }), /redirected off TikTok/);
    await assert.rejects(downloadVideo('https://v16.tiktokcdn.com/a.mp4', null, dest, { fetchImpl: reply({ 'content-type': 'text/html' }) }), /returned text\/html/);
    await assert.rejects(downloadVideo('https://v16.tiktokcdn.com/a.mp4', null, dest, { fetchImpl: reply({ 'content-type': 'video/mp4', 'content-length': String(400 * 1024 * 1024) }) }), /too large/);
    const ok = await downloadVideo('https://v16.tiktokcdn.com/a.mp4', 'tok', dest, { fetchImpl: reply({ 'content-type': 'video/mp4' }) });
    assert.equal(ok.bytes, 20000);
    await fs.rm(dest, { force: true });
});
