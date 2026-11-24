import test from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const { createAnalysisAsset, TWELVE_LABS_DIRECT_MAX_BYTES } = await import('../src/service/video.service.js');
const { MAX_UPLOAD_BYTES } = await import('../src/middleware/fileUpload.js');

const fakeVideo = () => ({ saved: 0, analysisSourceKey: null, async save() { this.saved += 1; } });

test('the upload cap fits 2-3 minute phone videos; Twelve Labs direct uploads stay under its 200 MB limit', () => {
    assert.equal(MAX_UPLOAD_BYTES, 500 * 1024 * 1024);
    assert.ok(TWELVE_LABS_DIRECT_MAX_BYTES < 200 * 1024 * 1024);
});

test('a file under the direct limit goes straight to Twelve Labs', async () => {
    const calls = [];
    const video = fakeVideo();
    const asset = await createAnalysisAsset(
        { file: { path: '/tmp/a.mp4' }, fileToUpload: 'STREAM', fileSize: 80 * 1024 * 1024, filename: 'a.mp4', userId: 'u1', videoId: 'v1', video },
        { createDirect: async (f) => { calls.push(['direct', f]); return { id: 'asset1' }; }, createFromUrl: async () => { throw new Error('no'); }, storage: {} },
    );
    assert.deepEqual(asset, { id: 'asset1' });
    assert.deepEqual(calls, [['direct', 'STREAM']]);
    assert.equal(video.analysisSourceKey, null);
});

test('a large file goes to storage and Twelve Labs fetches it by a signed link', async () => {
    const calls = [];
    const video = fakeVideo();
    const stream = { destroyed: false, destroy() { this.destroyed = true; } };
    const storage = {
        uploadFile: async (p, key, type) => calls.push(['upload', p, key, type]),
        presignDownload: async (key, opts) => { calls.push(['sign', key, opts.expiresIn]); return `https://signed/${key}`; },
    };
    const asset = await createAnalysisAsset(
        { file: { path: '/tmp/big.MOV', mimetype: 'video/quicktime' }, fileToUpload: stream, fileSize: 420 * 1024 * 1024, filename: 'Big Take.MOV', userId: 'u1', videoId: 'v9', video },
        { storage, createDirect: async () => { throw new Error('must not upload directly'); }, createFromUrl: async (url) => { calls.push(['link', url]); return { id: 'asset9', status: 'processing' }; } },
    );
    assert.deepEqual(asset, { id: 'asset9', status: 'processing' });
    assert.equal(stream.destroyed, true, 'the unused read stream is closed');
    assert.equal(video.analysisSourceKey, 'editor/analysis/u1/v9/source.mov');
    assert.ok(video.saved >= 1, 'the key is saved for cleanup');
    assert.deepEqual(calls.map((c) => c[0]), ['upload', 'sign', 'link']);
    assert.equal(calls[1][2], 6 * 60 * 60, 'the link lives long enough for Twelve Labs to fetch it');
    assert.equal(calls[2][1], 'https://signed/editor/analysis/u1/v9/source.mov');
});

// GET /videos (full view): what each plan may see.
const { toPlanVisibleVideo } = await import('../src/service/video.service.js');
const { getUserVideos } = await import('../src/controller/video.controller.js');
const { Video } = await import('../src/model/video.model.js');
const { Subscription } = await import('../src/model/subscription.model.js');
const { fakeRes } = await import('./helpers/test-db.js');

const storedVideo = () => ({
    _id: 'v1',
    analysisStatus: 'failed',
    lastError: 'TwelveLabs 500: internal index tl-123 at /srv/app/worker.js:88',
    lastErrorAt: new Date('2026-11-01T00:00:00Z'),
    analysis: [
        { feature: 'hook', score: 70 },
        { feature: 'advanced_analytics', score: 88, psychologicalProfile: 'Pro-only insight' },
    ],
    timestampFeedback: [
        { id: 'f1', sourceFeature: 'hook' },
        { id: 'f2', sourceFeature: 'advanced_analytics' },
    ],
    scriptRewrites: [
        { lineId: 'r1', sourceFeature: 'pacing' },
        { lineId: 'r2', sourceFeature: 'advanced_analytics' },
    ],
    scriptSuggestions: { options: [{ id: 's1', title: 'Locked script', beats: [{ say: 'full text' }] }] },
});

test('full video view: Free and Premium never see Advanced Analytics or stored scripts; Pro sees its analysis', () => {
    for (const plan of ['free', 'premium', undefined, 'unknown-plan']) {
        const v = toPlanVisibleVideo(storedVideo(), plan);
        assert.deepEqual(v.analysis.map((a) => a.feature), ['hook'], `plan ${plan}`);
        assert.deepEqual(v.timestampFeedback.map((f) => f.id), ['f1']);
        assert.deepEqual(v.scriptRewrites.map((r) => r.lineId), ['r1']);
        assert.equal(v.scriptSuggestions, undefined);
        assert.ok(!JSON.stringify(v).includes('Pro-only insight'));
    }
    const pro = toPlanVisibleVideo(storedVideo(), 'pro');
    assert.deepEqual(pro.analysis.map((a) => a.feature), ['hook', 'advanced_analytics']);
    assert.equal(pro.timestampFeedback.length, 2);
    assert.equal(pro.scriptRewrites.length, 2);
    assert.equal(pro.scriptSuggestions, undefined, 'scripts come from the Scripts endpoint, gated there');
});

test('GET /videos full view: gated by the stored plan, raw errors replaced by a user-facing summary', async () => {
    const original = { find: Video.find, findOne: Subscription.findOne };
    console.warn = () => {};
    try {
        Video.find = () => ({ sort: () => ({ lean: async () => [storedVideo()] }) });
        for (const [plan, expected] of [['premium', ['hook']], ['pro', ['hook', 'advanced_analytics']]]) {
            Subscription.findOne = async () => ({ plan });
            const res = fakeRes();
            let err;
            await getUserVideos({ user: { _id: 'u1' }, query: {} }, res, (e) => { err = e; });
            assert.equal(err, undefined);
            const [video] = res.body.data.videos;
            assert.deepEqual(video.analysis.map((a) => a.feature), expected, plan);
            assert.equal(video.lastError, undefined);
            assert.equal(video.lastErrorAt, undefined);
            assert.match(video.errorSummary, /Re-analyze/);
            assert.ok(!JSON.stringify(res.body).includes('TwelveLabs 500'));
        }

        // Subscription unreadable: least access (Free), never a leak.
        Subscription.findOne = async () => { throw new Error('db down'); };
        const res = fakeRes();
        await getUserVideos({ user: { _id: 'u1' }, query: {} }, res, () => {});
        assert.deepEqual(res.body.data.videos[0].analysis.map((a) => a.feature), ['hook']);
    } finally {
        Video.find = original.find;
        Subscription.findOne = original.findOne;
    }
});
