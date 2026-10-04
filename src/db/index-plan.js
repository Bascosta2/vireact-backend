/**
 * Explicit index management (MONGO_AUTO_INDEX is off by default).
 * Plans are create-only: indexes that exist in the database but not in a
 * schema are reported, never dropped. The knowledge base is excluded outright
 * because any index change there affects RAG for every user.
 */

export const PROTECTED_COLLECTIONS = Object.freeze(['knowledgebases']);

export const isProtectedCollection = (name) => PROTECTED_COLLECTIONS.includes(String(name).toLowerCase());

/**
 * @param {Array<import('mongoose').Model>} models
 * @returns {Promise<Array<{ model: string, collection: string, toCreate: Array<[object, object]>, extraInDb: string[] }>>}
 */
export async function planIndexes(models) {
    const plan = [];
    for (const model of models) {
        const collection = model.collection.collectionName;
        if (isProtectedCollection(collection)) {
            throw new Error(`Refusing to plan indexes for protected collection "${collection}".`);
        }
        const { toCreate, toDrop } = await model.diffIndexes({ indexOptionsToCreate: true });
        plan.push({ model: model.modelName, collection, toCreate, extraInDb: toDrop });
    }
    return plan;
}

export function formatPlan(plan) {
    const lines = [];
    for (const entry of plan) {
        lines.push(`${entry.collection} (${entry.model})`);
        if (entry.toCreate.length === 0) lines.push('  create: (none)');
        for (const [keys, options] of entry.toCreate) {
            const opts = Object.keys(options || {}).length ? ` ${JSON.stringify(options)}` : '';
            lines.push(`  create: ${JSON.stringify(keys)}${opts}`);
        }
        for (const name of entry.extraInDb) lines.push(`  in DB but not in schema (left as-is): ${name}`);
    }
    return lines.join('\n');
}

export async function applyPlan(models, plan) {
    const byCollection = new Map(models.map((m) => [m.collection.collectionName, m]));
    const created = [];
    for (const entry of plan) {
        if (isProtectedCollection(entry.collection)) {
            throw new Error(`Refusing to modify protected collection "${entry.collection}".`);
        }
        const model = byCollection.get(entry.collection);
        for (const [keys, options] of entry.toCreate) {
            const name = await model.collection.createIndex(keys, { ...options, background: true });
            created.push(`${entry.collection}.${name}`);
        }
    }
    return created;
}
