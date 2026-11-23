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
