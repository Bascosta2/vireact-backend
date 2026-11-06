import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import TwelveLabsClient from '../src/lib/twelve-labs.js';
import { waitForAssetReady, indexAssetWithRetry, ensureVideoIndexed } from '../src/service/video.service.js';

// The indexing code logs progress with emoji; on Windows that output can corrupt the node --test
// runner's channel and fail the file. The tests assert behavior, not logs, so silence them here.
console.log = () => {};
console.warn = () => {};

// Stub the shared SDK client in place (no network). Restored after each test.
const original = {
    assetsRetrieve: TwelveLabsClient.assets.retrieve,
    indexedCreate: TwelveLabsClient.indexes.indexedAssets.create,
    indexedRetrieve: TwelveLabsClient.indexes.indexedAssets.retrieve,
};
afterEach(() => {
    TwelveLabsClient.assets.retrieve = original.assetsRetrieve;
    TwelveLabsClient.indexes.indexedAssets.create = original.indexedCreate;
    TwelveLabsClient.indexes.indexedAssets.retrieve = original.indexedRetrieve;
});

const sequence = (values) => {
    let i = 0;
    return async () => values[Math.min(i++, values.length - 1)];
};

test('waitForAssetReady checks right away when the status is unknown', async () => {
    let calls = 0;
    TwelveLabsClient.assets.retrieve = async () => {
        calls++;
        return { status: 'ready' };
    };
    const started = Date.now();
    await waitForAssetReady('asset_1', null, { pollMs: 5000 });
    assert.equal(calls, 1);
    assert.ok(Date.now() - started < 1000, 'no initial sleep when the status is unknown');
});

test('waitForAssetReady fails fast when Twelve Labs reports failed', async () => {
    TwelveLabsClient.assets.retrieve = async () => ({ status: 'failed' });
    await assert.rejects(waitForAssetReady('asset_1', null, { pollMs: 1 }), /could not process asset/);
});

test('indexAssetWithRetry persists the id via onCreated, then polls until ready', async () => {
    TwelveLabsClient.indexes.indexedAssets.create = async () => ({ id: 'idx_1', status: 'pending' });
    TwelveLabsClient.indexes.indexedAssets.retrieve = sequence([{ status: 'indexing' }, { status: 'indexing' }, { status: 'ready' }]);
    const created = [];
    const result = await indexAssetWithRetry('asset_1', 'index_1', { pollMs: 1, onCreated: (id) => created.push(id) });
    assert.deepEqual(created, ['idx_1']);
    assert.deepEqual(result, { indexedAssetId: 'idx_1', indexedStatus: 'ready' });
});

test('indexAssetWithRetry resumes an existing indexing run without indexing twice', async () => {
    let createCalls = 0;
    TwelveLabsClient.indexes.indexedAssets.create = async () => {
        createCalls++;
        return { id: 'should_not_be_used' };
    };
    TwelveLabsClient.indexes.indexedAssets.retrieve = sequence([{ status: 'indexing' }, { status: 'ready' }]);
    const result = await indexAssetWithRetry('asset_1', 'index_1', { pollMs: 1, existingIndexedAssetId: 'idx_existing' });
    assert.equal(createCalls, 0);
    assert.equal(result.indexedAssetId, 'idx_existing');
});

test('indexAssetWithRetry fails fast on a failed index and times out when it never finishes', async () => {
    TwelveLabsClient.indexes.indexedAssets.create = async () => ({ id: 'idx_1', status: 'pending' });
    TwelveLabsClient.indexes.indexedAssets.retrieve = async () => ({ status: 'failed' });
    await assert.rejects(indexAssetWithRetry('asset_1', 'index_1', { pollMs: 1 }), /indexing failed/);

    TwelveLabsClient.indexes.indexedAssets.retrieve = async () => ({ status: 'indexing' });
    await assert.rejects(indexAssetWithRetry('asset_1', 'index_1', { pollMs: 5, maxWaitMs: 30 }), /did not become ready/);
});

test('ensureVideoIndexed saves the pending id first and the video id when ready', async () => {
    process.env.TWELVELABS_USER_INDEX ||= 'index_test';
    TwelveLabsClient.assets.retrieve = async () => ({ status: 'ready' });
    TwelveLabsClient.indexes.indexedAssets.create = async () => ({ id: 'idx_9', status: 'ready' });
    const saves = [];
    const video = {
        twelveLabsAssetId: 'asset_9',
        twelveLabsVideoId: null,
        twelveLabsPendingIndexId: null,
        async save() {
            saves.push({ pending: this.twelveLabsPendingIndexId, videoId: this.twelveLabsVideoId });
        },
    };
    const id = await ensureVideoIndexed(video);
    assert.equal(id, 'idx_9');
    assert.equal(video.twelveLabsVideoId, 'idx_9');
    assert.equal(video.twelveLabsPendingIndexId, null);
    assert.deepEqual(saves, [
        { pending: 'idx_9', videoId: null },
        { pending: null, videoId: 'idx_9' },
    ]);
});

test('ensureVideoIndexed is a no-op for an already indexed video and rejects a video with no asset', async () => {
    assert.equal(await ensureVideoIndexed({ twelveLabsVideoId: 'done' }), 'done');
    await assert.rejects(ensureVideoIndexed({ twelveLabsVideoId: null, twelveLabsAssetId: null }), /did not reach Twelve Labs/);
});

test('buildScenesFromTranscript gives analyzers real times and the spoken hook line', async () => {
    const { buildScenesFromTranscript } = await import('../src/controller/video.controller.js');
    assert.deepEqual(buildScenesFromTranscript([]), []);
    const scenes = buildScenesFromTranscript([
        { text: 'Stop scrolling.', tStart: 0, tEnd: 1.2 },
        { text: 'Here is why.', tStart: 1.2, tEnd: 4 },
        { text: 'Follow for part two.', tStart: 4, tEnd: 6 },
    ]);
    assert.equal(scenes.length, 3);
    assert.equal(scenes[0].purpose, 'hook');
    assert.equal(scenes[0].primaryAction, 'Says "Stop scrolling."');
    assert.equal(scenes[2].purpose, 'cta');
    assert.deepEqual([scenes[1].startTime, scenes[1].endTime], [1.2, 4]);
});
