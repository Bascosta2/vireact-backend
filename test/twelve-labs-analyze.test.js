import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import TwelveLabsClient from '../src/lib/twelve-labs.js';
import {
    PEGASUS_MODEL,
    buildVideoContext,
    isRetryableTwelveLabsError,
    analyzeVideoScenes,
    transcribeVideoWithPegasus,
    parsePegasusTranscript,
} from '../src/lib/twelve-labs-analyze.js';

const originalAnalyze = TwelveLabsClient.analyze;
afterEach(() => {
    TwelveLabsClient.analyze = originalAnalyze;
});

const apiError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

test('Pegasus 1.5 reads the asset directly (no index video id)', async () => {
    let captured;
    TwelveLabsClient.analyze = async (request) => {
        captured = request;
        return { data: 'SCENE: 1\nSTART_TIME: 0\nEND_TIME: 2' };
    };
    const text = await analyzeVideoScenes({ assetId: 'asset_1' }, 'PROMPT');
    assert.equal(text, 'SCENE: 1\nSTART_TIME: 0\nEND_TIME: 2');
    assert.equal(PEGASUS_MODEL, 'pegasus1.5');
    assert.equal(captured.modelName, 'pegasus1.5');
    assert.deepEqual(captured.video, { type: 'asset_id', assetId: 'asset_1' });
    assert.equal(captured.prompt, 'PROMPT');
    assert.equal('videoId' in captured, false);
});

test('falls back to the HLS stream URL when there is no asset', () => {
    assert.deepEqual(buildVideoContext({ streamUrl: 'https://x/v.m3u8' }), { type: 'url', url: 'https://x/v.m3u8' });
    assert.deepEqual(buildVideoContext({ assetId: 'a', streamUrl: 'https://x/v.m3u8' }), { type: 'asset_id', assetId: 'a' });
    assert.equal(buildVideoContext({}), null);
});

test('a 400 (e.g. a sunset model) is not retried; a 503 is retried once', async () => {
    let calls = 0;
    TwelveLabsClient.analyze = async () => {
        calls++;
        throw apiError(400, 'parameter_invalid');
    };
    await assert.rejects(analyzeVideoScenes({ assetId: 'a' }, 'P', { retryDelayMs: 1 }), /parameter_invalid/);
    assert.equal(calls, 1);

    calls = 0;
    TwelveLabsClient.analyze = async () => {
        calls++;
        if (calls === 1) throw apiError(503, 'unavailable');
        return { data: 'ok' };
    };
    assert.equal(await analyzeVideoScenes({ assetId: 'a' }, 'P', { retryDelayMs: 1 }), 'ok');
    assert.equal(calls, 2);
});

test('retry classification', () => {
    assert.equal(isRetryableTwelveLabsError(apiError(400, 'x')), false);
    assert.equal(isRetryableTwelveLabsError(apiError(404, 'x')), false);
    assert.equal(isRetryableTwelveLabsError(apiError(429, 'x')), true);
    assert.equal(isRetryableTwelveLabsError(apiError(502, 'x')), true);
    assert.equal(isRetryableTwelveLabsError(new Error('socket hang up')), true);
});

test('an empty Pegasus response is an error, not an empty breakdown', async () => {
    TwelveLabsClient.analyze = async () => ({ data: '   ', finishReason: 'length' });
    await assert.rejects(analyzeVideoScenes({ assetId: 'a' }, 'P', { attempts: 1 }), /empty response/);
});

test('Pegasus transcript: structured request, parsed into sorted segments, never throws', async () => {
    let captured;
    TwelveLabsClient.analyze = async (request) => {
        captured = request;
        return { data: '{"segments":[{"start":3.5,"end":5,"text":"second"},{"start":0,"end":3.4,"text":" first "},{"start":"x","end":1,"text":"bad"}]}' };
    };
    const segments = await transcribeVideoWithPegasus({ assetId: 'a' });
    assert.equal(captured.responseFormat.type, 'json_schema');
    assert.deepEqual(segments, [
        { text: 'first', tStart: 0, tEnd: 3.4 },
        { text: 'second', tStart: 3.5, tEnd: 5 },
    ]);

    TwelveLabsClient.analyze = async () => {
        throw apiError(500, 'boom');
    };
    assert.deepEqual(await transcribeVideoWithPegasus({ assetId: 'a' }, { attempts: 1 }), []);
    assert.deepEqual(parsePegasusTranscript('not json'), []);
    assert.deepEqual(parsePegasusTranscript('{"segments":[]}'), []);
});
