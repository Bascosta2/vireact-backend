import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDb, disconnectTestDb, fakeRes } from './helpers/test-db.js';
import { AiResponse } from '../src/model/ai-response.model.js';
import { withAiContext, recordGeneration, markGenerationValidation, lastGenerationId, setAiCaptureForTests } from '../src/lib/ai-tracking.js';
import { listAiResponsesAdmin, getAiResponseAdmin, getAiResponseStatsAdmin, reviewAiResponseAdmin } from '../src/controller/ai-response.controller.js';

console.warn = () => {};
setAiCaptureForTests(() => {}); // nothing leaves the process

before(async () => { await connectTestDb(); await AiResponse.syncIndexes(); });
after(async () => { await disconnectTestDb(); });

const waitFor = async (check, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const value = await check();
        if (value) return value;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('timed out');
};

const call = (handler, req) => new Promise((resolve, reject) => {
    const res = fakeRes();
    const origJson = res.json;
    res.json = (body) => { origJson(body); resolve(res); return res; };
    handler({ query: {}, params: {}, body: {}, ...req }, res, reject);
});

test('a generation is stored with its context, then marked by the quality gate', async () => {
    let id;
    await withAiContext({ feature: 'chat', userId: 'user-9', videoId: 'video-9', traceId: 'chat-trace-1' }, async () => {
        await withAiContext({ attempt: 1 }, async () => {
            recordGeneration({
                provider: 'openai', model: 'gpt-test', label: 'chat_response',
                input: [{ role: 'user', content: 'How is my hook?' }], output: 'Your hook is strong.',
                usage: { inputTokens: 50, outputTokens: 10 }, latencyMs: 800, stopReason: 'stop',
            });
            id = lastGenerationId();
            markGenerationValidation(id, { passed: false, issues: ['frameFeedback f1: missing timestamp'] });
        });
    });
    const doc = await waitFor(async () => {
        const d = await AiResponse.findById(id).lean();
        return d?.validation?.status ? d : null;
    });
    assert.equal(doc.feature, 'chat');
    assert.equal(doc.userId, 'user-9');
    assert.equal(doc.distinctId, 'user-9');
    assert.equal(doc.traceId, 'chat-trace-1');
    assert.equal(doc.totalTokens, 60);
    assert.equal(doc.outputPreview, 'Your hook is strong.');
    assert.equal(doc.validation.status, 'failed');
    assert.deepEqual(doc.validation.issues, ['frameFeedback f1: missing timestamp']);
    assert.ok(doc.expiresAt > new Date(), 'expires later');
});

test('admin list, detail, stats and review', async () => {
    await withAiContext({ feature: 'video_analysis', videoId: 'v-1', traceId: 'video-trace-2' }, async () => {
        recordGeneration({ provider: 'openai', model: 'gpt-test', label: 'hook_analysis', input: 'p1', output: 'good output', usage: { inputTokens: 100, outputTokens: 20 }, latencyMs: 1000 });
        recordGeneration({ provider: 'twelvelabs', model: 'pegasus-test', label: 'transcription', input: 'p2', error: new Error('boom'), latencyMs: 200 });
    });
    await waitFor(async () => (await AiResponse.countDocuments({ traceId: 'video-trace-2' })) === 2);

    const list = await call(listAiResponsesAdmin, { query: { feature: 'video_analysis' } });
    assert.equal(list.body.ok, true);
    assert.equal(list.body.total, 2);
    assert.equal(list.body.items[0].input, undefined, 'list omits full prompt');

    const errors = await call(listAiResponsesAdmin, { query: { status: 'error' } });
    assert.ok(errors.body.items.every((i) => i.isError));

    const bad = await call(listAiResponsesAdmin, { query: { status: 'nope' } });
    assert.equal(bad.statusCode, 400);

    const target = list.body.items.find((i) => i.label === 'hook_analysis');
    const detail = await call(getAiResponseAdmin, { params: { id: String(target._id) } });
    assert.equal(detail.body.item.output, 'good output');
    assert.equal(detail.body.trace.length, 2, 'whole trace listed');

    const missing = await call(getAiResponseAdmin, { params: { id: '0123456789abcdef01234567' } });
    assert.equal(missing.statusCode, 404);

    const stats = await call(getAiResponseStatsAdmin, { query: { hours: '1' } });
    assert.ok(stats.body.totals.calls >= 2);
    assert.ok(stats.body.totals.errors >= 1);
    assert.ok(stats.body.facets.features.includes('video_analysis'));

    const review = await call(reviewAiResponseAdmin, { params: { id: String(target._id) }, body: { rating: 'bad', note: 'too vague' } });
    assert.equal(review.body.review.kept, true);
    let doc = await AiResponse.findById(target._id).lean();
    assert.equal(doc.review.rating, 'bad');
    assert.equal(doc.expiresAt, undefined, 'reviewed responses are kept');

    await call(reviewAiResponseAdmin, { params: { id: String(target._id) }, body: { rating: null, note: '' } });
    doc = await AiResponse.findById(target._id).lean();
    assert.ok(doc.expiresAt instanceof Date, 'cleared review goes back on the retention clock');

    const invalid = await call(reviewAiResponseAdmin, { params: { id: String(target._id) }, body: { rating: 'meh' } });
    assert.equal(invalid.statusCode, 400);
});
