import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildCompletionParams, modelForRole, isReasoningModel, embeddingModel, videoModel } from '../src/config/ai-models.js';

const saved = { ...process.env };
afterEach(() => {
    for (const key of Object.keys(process.env)) if (key.startsWith('AI_')) delete process.env[key];
    for (const [key, value] of Object.entries(saved)) if (key.startsWith('AI_')) process.env[key] = value;
});
const clearAiEnv = () => { for (const key of Object.keys(process.env)) if (key.startsWith('AI_')) delete process.env[key]; };

test('role defaults: luna for analysis, terra for writing, none-effort classifier', () => {
    clearAiEnv();
    assert.deepEqual(modelForRole('structured'), { model: 'gpt-6-luna', reasoningEffort: 'low' });
    assert.deepEqual(modelForRole('writer'), { model: 'gpt-6.1-terra', reasoningEffort: 'low' });
    assert.deepEqual(modelForRole('classifier'), { model: 'gpt-6-luna', reasoningEffort: 'none' });
    assert.equal(embeddingModel(), 'text-embedding-3-large');
    assert.equal(videoModel(), 'pegasus1.6');
});

test('environment variables override a role without code changes', () => {
    clearAiEnv();
    process.env.AI_MODEL_WRITER = 'gpt-6.1-sol';
    process.env.AI_REASONING_WRITER = 'medium';
    assert.deepEqual(modelForRole('writer'), { model: 'gpt-6.1-sol', reasoningEffort: 'medium' });
});

test('reasoning models get max_completion_tokens with headroom and never max_tokens (the API rejects it)', () => {
    clearAiEnv();
    const params = buildCompletionParams({ role: 'structured', temperature: 0.2, maxTokens: 3500 });
    assert.equal(params.model, 'gpt-6-luna');
    assert.equal(params.reasoning_effort, 'low');
    assert.equal(params.max_completion_tokens, 5000);
    assert.equal('max_tokens' in params, false);
    assert.equal('temperature' in params, false, 'temperature only at effort none');

    const classifier = buildCompletionParams({ role: 'classifier', temperature: 0.1, maxTokens: 20 });
    assert.deepEqual(classifier, { model: 'gpt-6-luna', reasoning_effort: 'none', max_completion_tokens: 20, temperature: 0.1 });
});

test('classic models keep max_tokens and temperature', () => {
    assert.equal(isReasoningModel('gpt-4.1-mini'), false);
    assert.deepEqual(buildCompletionParams({ model: 'gpt-4.1-mini', temperature: 0.3, maxTokens: 100 }), { model: 'gpt-4.1-mini', max_tokens: 100, temperature: 0.3 });
    assert.equal(isReasoningModel('gpt-5-mini'), true);
    assert.equal(isReasoningModel('o3'), true);
});
