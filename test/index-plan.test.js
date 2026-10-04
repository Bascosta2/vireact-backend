import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planIndexes, applyPlan, formatPlan, isProtectedCollection } from '../src/db/index-plan.js';

const fakeModel = (collectionName, toCreate = [], toDrop = []) => {
    const created = [];
    return {
        modelName: collectionName,
        created,
        collection: {
            collectionName,
            createIndex: async (keys) => {
                const name = Object.entries(keys).map(([k, v]) => `${k}_${v}`).join('_');
                created.push(name);
                return name;
            },
        },
        diffIndexes: async () => ({ toCreate, toDrop }),
    };
};

test('knowledgebases is protected regardless of case', () => {
    assert.ok(isProtectedCollection('knowledgebases'));
    assert.ok(isProtectedCollection('KnowledgeBases'));
    assert.ok(!isProtectedCollection('library_items'));
});

test('planning refuses a model backed by knowledgebases', async () => {
    await assert.rejects(planIndexes([fakeModel('users'), fakeModel('knowledgebases')]), /protected collection/);
});

test('plan is create-only: extra DB indexes are reported, never dropped', async () => {
    const users = fakeModel('users', [[{ email: 1 }, { unique: true }]], ['legacy_1']);
    const plan = await planIndexes([users]);
    assert.deepEqual(plan[0].toCreate, [[{ email: 1 }, { unique: true }]]);
    assert.deepEqual(plan[0].extraInDb, ['legacy_1']);
    assert.match(formatPlan(plan), /left as-is\): legacy_1/);

    const created = await applyPlan([users], plan);
    assert.deepEqual(created, ['users.email_1']);
});

test('apply refuses a tampered plan that targets knowledgebases', async () => {
    const kb = fakeModel('knowledgebases');
    await assert.rejects(
        applyPlan([kb], [{ model: 'KnowledgeBase', collection: 'knowledgebases', toCreate: [[{ a: 1 }, {}]], extraInDb: [] }]),
        /protected collection/
    );
    assert.equal(kb.created.length, 0);
});
