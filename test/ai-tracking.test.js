import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    withAiContext,
    getAiContext,
    lastGenerationId,
    recordGeneration,
    computeCost,
    openAiUsage,
    setAiCaptureForTests,
    SYSTEM_DISTINCT_ID,
} from '../src/lib/ai-tracking.js';
import { buildAiResponseFilter } from '../src/service/ai-response.service.js';
import openai from '../src/lib/openai.js';
import TwelveLabsClient from '../src/lib/twelve-labs.js';
import { requestStructuredCompletion, requestChatCompletion } from '../src/service/openai-response.service.js';
import { transcribeVideoWithPegasus } from '../src/lib/twelve-labs-analyze.js';

console.warn = () => {};
console.error = () => {};

const originalCreate = openai.chat.completions.create;
const originalAnalyze = TwelveLabsClient.analyze;
afterEach(() => {
    setAiCaptureForTests(null);
    openai.chat.completions.create = originalCreate;
    TwelveLabsClient.analyze = originalAnalyze;
    delete process.env.AI_MODEL_PRICES;
    delete process.env.POSTHOG_AI_PRIVACY_MODE;
});

const listen = () => {
    const events = [];
    setAiCaptureForTests((distinctId, event, properties) => events.push({ distinctId, event, properties }));
    return events;
};

test('context nests: children inherit and override, and each scope has its own last generation', async () => {
    await withAiContext({ feature: 'chat', userId: 'u1', traceId: 't1' }, async () => {
        assert.equal(getAiContext().feature, 'chat');
        await withAiContext({ attempt: 2 }, async () => {
            const ctx = getAiContext();
            assert.equal(ctx.userId, 'u1');
            assert.equal(ctx.traceId, 't1');
            assert.equal(ctx.attempt, 2);
            const id = recordGeneration({ provider: 'openai', model: 'm', label: 'x', input: 'hi', latencyMs: 5 });
            assert.equal(lastGenerationId(), id);
        });
        assert.equal(lastGenerationId(), null, 'parent scope unaffected');
    });
    assert.deepEqual(getAiContext(), {});
});

test('a generation becomes a PostHog $ai_generation event with tokens, latency in seconds and trace', async () => {
    const events = listen();
    await withAiContext({ feature: 'video_analysis', userId: 'user-1', videoId: 'vid-1', traceId: 'video-vid-1-abc' }, async () => {
        recordGeneration({
            provider: 'openai',
            model: 'gpt-6-luna',
            label: 'hook analysis',
            input: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'prompt' }],
            output: '{"score":7}',
            usage: { inputTokens: 1200, outputTokens: 300, cachedInputTokens: 200 },
            latencyMs: 1500,
            stopReason: 'stop',
            params: { temperature: 0.2, maxTokens: 3500 },
        });
    });
    assert.equal(events.length, 1);
    const { distinctId, event, properties: p } = events[0];
    assert.equal(event, '$ai_generation');
    assert.equal(distinctId, 'user-1');
    assert.equal(p.$ai_trace_id, 'video-vid-1-abc');
    assert.equal(p.$ai_span_name, 'hook_analysis');
    assert.equal(p.$ai_model, 'gpt-6-luna');
    assert.equal(p.$ai_provider, 'openai');
    assert.equal(p.$ai_input_tokens, 1200);
    assert.equal(p.$ai_output_tokens, 300);
    assert.equal(p.$ai_cache_read_input_tokens, 200);
    assert.equal(p.$ai_latency, 1.5);
    assert.equal(p.$ai_is_error, false);
    assert.deepEqual(p.$ai_output_choices, [{ role: 'assistant', content: '{"score":7}' }]);
    assert.equal(p.$ai_input.length, 2);
    assert.equal(p.feature, 'video_analysis');
    assert.equal(p.video_id, 'vid-1');
    assert.equal(p.$ai_total_cost_usd, undefined, 'no price configured: PostHog computes cost');
});

test('privacy mode keeps prompts and outputs out of PostHog; system work does not create person profiles', () => {
    process.env.POSTHOG_AI_PRIVACY_MODE = 'true';
    const events = listen();
    recordGeneration({ provider: 'openai', model: 'm', label: 'kb_web_search', input: 'secret', output: 'secret out', latencyMs: 10 });
    const p = events[0].properties;
    assert.equal(events[0].distinctId, SYSTEM_DISTINCT_ID);
    assert.equal(p.$ai_input, undefined);
    assert.equal(p.$ai_output_choices, undefined);
    assert.equal(p.$process_person_profile, false);
});

test('cost comes from AI_MODEL_PRICES (USD per 1M tokens), with cached input priced separately', () => {
    process.env.AI_MODEL_PRICES = JSON.stringify({ 'gpt-x': { input: 2, output: 8, cachedInput: 0.5 } });
    const cost = computeCost('gpt-x', { inputTokens: 1_000_000, outputTokens: 500_000, cachedInputTokens: 200_000 });
    assert.ok(Math.abs(cost.input - (0.8 * 2 + 0.2 * 0.5)) < 1e-9);
    assert.ok(Math.abs(cost.output - 4) < 1e-9);
    assert.equal(computeCost('unknown', { inputTokens: 5 }), null);
    process.env.AI_MODEL_PRICES = 'not json';
    assert.equal(computeCost('gpt-x', { inputTokens: 5 }), null);
});

test('OpenAI usage maps from both Chat Completions and Responses shapes', () => {
    assert.deepEqual(openAiUsage({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 } }),
        { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, reasoningTokens: 3 });
    assert.deepEqual(openAiUsage({ input_tokens: 7, output_tokens: 4, output_tokens_details: { reasoning_tokens: 1 } }),
        { inputTokens: 7, outputTokens: 4, cachedInputTokens: undefined, reasoningTokens: 1 });
});

test('structured completion records tokens on success and records a refusal as an error', async () => {
    const events = listen();
    openai.chat.completions.create = async (body) => ({
        id: 'resp_1',
        model: body.model,
        choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
    });
    const out = await requestStructuredCompletion({ messages: [{ role: 'user', content: 'x' }], schemaName: 'hook_analysis', jsonSchema: { type: 'object' } });
    assert.deepEqual(out, { ok: true });
    assert.equal(events[0].properties.$ai_span_name, 'hook_analysis');
    assert.equal(events[0].properties.$ai_input_tokens, 100);
    assert.equal(events[0].properties.$ai_input[0].role, 'system', 'system prompt included');

    openai.chat.completions.create = async () => ({ choices: [{ finish_reason: 'stop', message: { refusal: 'no' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
    await assert.rejects(requestStructuredCompletion({ messages: [{ role: 'user', content: 'x' }], schemaName: 's', jsonSchema: {} }), /refused/);
    assert.equal(events[1].properties.$ai_is_error, true);
    assert.match(events[1].properties.$ai_error, /refused/);
});

test('a failed API call is recorded as an error and still thrown', async () => {
    const events = listen();
    openai.chat.completions.create = async () => { const e = new Error('rate limited'); e.status = 429; throw e; };
    await assert.rejects(requestChatCompletion({ label: 'chat_intent', messages: [{ role: 'user', content: 'hi' }] }), /rate limited/);
    assert.equal(events[0].properties.$ai_span_name, 'chat_intent');
    assert.equal(events[0].properties.$ai_is_error, true);
    assert.equal(events[0].properties.$ai_http_status, 429);
});

test('Pegasus calls are recorded with Twelve Labs token usage', async () => {
    const events = listen();
    TwelveLabsClient.analyze = async () => ({ id: 'tl_1', data: '{"segments":[]}', finishReason: 'stop', usage: { inputTokens: 900, outputTokens: 40 } });
    await transcribeVideoWithPegasus({ assetId: 'asset-1' });
    const p = events[0].properties;
    assert.equal(p.$ai_provider, 'twelvelabs');
    assert.equal(p.$ai_span_name, 'transcription');
    assert.equal(p.$ai_input_tokens, 900);
    assert.equal(p.$ai_output_tokens, 40);
    assert.match(p.$ai_input[0].content, /asset:asset-1/);
});

test('admin filter: validates values and builds the Mongo query', () => {
    const now = Date.parse('2026-11-07T12:00:00Z');
    assert.deepEqual(buildAiResponseFilter({}, now), { filter: {} });
    assert.equal(buildAiResponseFilter({ status: 'weird' }).error, 'invalid status');
    assert.equal(buildAiResponseFilter({ rating: 'meh' }).error, 'invalid rating');
    assert.equal(buildAiResponseFilter({ from: 'nope' }).error, 'invalid date');
    const { filter } = buildAiResponseFilter({ feature: 'chat', status: 'error', validation: 'failed', rating: 'unreviewed', q: 'a.b', hours: '24' }, now);
    assert.equal(filter.feature, 'chat');
    assert.equal(filter.isError, true);
    assert.equal(filter['validation.status'], 'failed');
    assert.equal(filter['review.rating'], null);
    assert.equal(filter.outputPreview.$regex, 'a\\.b', 'search text is escaped');
    assert.equal(filter.createdAt.$gte.toISOString(), '2026-11-06T12:00:00.000Z');
});
