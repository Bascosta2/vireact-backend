import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const L = await import('../src/service/learning/model/linalg.js');
const E = await import('../src/service/learning/model/engine.js');

const close = (a, b, tol = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b}`);

test('linalg: matmul, gram, Cholesky solve and SPD inverse agree with known answers', () => {
    const A = L.fromRows([[1, 2], [3, 4], [5, 6]]);
    const B = L.fromRows([[1, 0, 2], [0, 1, 1]]);
    assert.deepEqual(L.toRows(L.matmul(A, B)), [[1, 2, 4], [3, 4, 10], [5, 6, 16]]);
    const { G, v } = L.gram(A, Float64Array.from([1, 1, 1]));
    assert.deepEqual(L.toRows(G), [[35, 44], [44, 56]]);
    assert.deepEqual(Array.from(v), [9, 12]);
    assert.deepEqual(L.toRows(G), L.toRows(L.matmul(L.transpose(A), A)), 'X^T X by the gram routine equals the product');
    const S = L.fromRows([[4, 2, 0.6], [2, 5, 1], [0.6, 1, 3]]);
    const x = L.solveSPD(S, Float64Array.from([1, 2, 3]));
    const back = L.matvec(S, x);
    [1, 2, 3].forEach((b, i) => close(back[i], b, 1e-10));
    const I = L.matmul(S, L.inverseSPD(S));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) close(I.data[i * 3 + j], i === j ? 1 : 0, 1e-10);
});

test('linalg: Jacobi eigen-decomposition reconstructs the matrix, eigenvalues sorted', () => {
    const S = L.fromRows([[4, 1, 2], [1, 3, 0.5], [2, 0.5, 5]]);
    const { values, vectors } = L.symmetricEigen(S);
    assert.ok(values[0] >= values[1] && values[1] >= values[2]);
    close(values.reduce((a, b) => a + b, 0), 12, 1e-9, 'trace preserved');
    // V diag(values) V^T == S
    const D = L.zeros(3, 3);
    values.forEach((v, i) => { D.data[i * 3 + i] = v; });
    const R = L.matmul(L.matmul(vectors, D), L.transpose(vectors));
    for (let t = 0; t < 9; t++) close(R.data[t], S.data[t], 1e-9);
});

/** Synthetic creators: views depend on creator size (cancels) plus a real effect of `fastCut`. */
const synth = ({ creators = 40, per = 8, effect = 0.6, seed = 3 } = {}) => {
    const r = L.rng(seed);
    const rows = [];
    for (let c = 0; c < creators; c++) {
        const size = r() * 4; // creator effect, correlated with style below (confounder)
        for (let k = 0; k < per; k++) {
            const fastCut = r() * 2 + size * 0.5; // big creators cut faster: naive regression is biased
            const noise = r() * 2 - 1;
            const textShare = r();
            rows.push({ features: { fastCut, textShare, niche: c % 2 ? 'food' : 'tech' }, y: size + effect * fastCut + 0.3 * noise, w: 1, group: `c${c}` });
        }
    }
    return rows;
};

test('design matrix: standardized columns, imputation with missing flags, one-hot levels, cyclic hours', () => {
    const rows = [
        { features: { a: 1, postHourUtc: 23, cat: 'x' }, y: 0, group: 'g' },
        { features: { a: 3, postHourUtc: 1, cat: 'y' }, y: 0, group: 'g' },
        { features: { postHourUtc: 12, cat: 'x' }, y: 0, group: 'g' },
        { features: { a: 5, postHourUtc: 6, cat: 'y', flag: true }, y: 0, group: 'g' },
    ];
    const d = E.buildDesign(rows, { minCoverage: 0.5, minLevel: 1 });
    assert.ok(d.columns.includes('a'));
    assert.ok(d.columns.includes('a:missing'));
    assert.ok(d.columns.includes('postHourUtc:sin') && d.columns.includes('postHourUtc:cos'), d.columns.join());
    assert.ok(d.columns.includes('cat=x') && d.columns.includes('cat=y'));
    assert.ok(!d.columns.includes('flag'), 'below coverage');
    const j = d.columns.indexOf('a');
    let m = 0;
    for (let i = 0; i < 4; i++) m += d.X.data[i * d.X.cols + j];
    close(m, 0, 1e-12, 'mean 0 after standardizing');
    const again = E.transformRow(d.spec, rows[1].features);
    for (let t = 0; t < d.X.cols; t++) close(again[t], d.X.data[1 * d.X.cols + t], 1e-12, 'serving transform equals training');
});

test('within-creator projection removes creator size: the real effect is recovered where naive pooling is biased', () => {
    const rows = synth({ effect: 0.6 });
    const d = E.buildDesign(rows);
    const j = d.columns.indexOf('fastCut');
    const sd = d.spec.columns[j].sd;
    // Naive ridge on pooled data (no projection) is inflated by the size confounder.
    const pooled = L.gram(d.X, Float64Array.from(d.y, (y) => y - d.y.reduce((a, b) => a + b, 0) / d.y.length));
    const naive = E.ridgeSolve(pooled.G, pooled.v, 1e-6)[j] / sd;
    const fe = E.withinCreators(d.X, d.y, d.w, d.groups);
    // Each creator's mean is now zero.
    const sums = new Map();
    fe.groups.forEach((g, i) => sums.set(g, (sums.get(g) ?? 0) + fe.y[i]));
    for (const s of sums.values()) close(s, 0, 1e-9);
    const g = L.gram(fe.X, fe.y, fe.w);
    const beta = E.ridgeSolve(g.G, g.v, 1e-6)[j] / sd;
    close(beta, 0.6, 0.06, 'within-creator estimate');
    assert.ok(naive > 0.75, `naive pooled estimate is biased upward (${naive})`);
});

test('ridge CV with whole creators per fold; lambda -> 0 equals least squares; metrics beat the creator-usual baseline', () => {
    const rows = synth({ creators: 60, per: 6, effect: 0.8 });
    const d = E.buildDesign(rows);
    const fe = E.withinCreators(d.X, d.y, d.w, d.groups);
    const r = E.fitRidge(fe.X, fe.y, fe.w, fe.groups, d.columns, { k: 5 });
    assert.equal(r.coefficients[0].column, 'fastCut');
    assert.ok(r.metrics.skill > 0.5, JSON.stringify(r.metrics));
    assert.ok(r.metrics.pairAccuracy > 0.8);
    assert.ok(r.cv.length === 8);
    const folds = new Map();
    fe.groups.forEach((g) => { const f = E.foldOf(g, 5); if (!folds.has(g)) folds.set(g, f); assert.equal(folds.get(g), f); });
    // Least squares via normal equations equals ridge with lambda ~ 0.
    const g = L.gram(fe.X, fe.y, fe.w);
    const ols = E.ridgeSolve(g.G, g.v, 1e-9);
    const XtX = L.matmul(L.transpose(fe.X), fe.X);
    const check = L.matvec(XtX, ols);
    for (let t = 0; t < check.length; t++) close(check[t], g.v[t], 1e-6);
});

test('network: partial correlations find a chain a -> b -> y and not the indirect a -- y link', () => {
    const r = L.rng(11);
    const n = 3000;
    const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
    const X = L.zeros(n, 3);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const a = gauss();
        const b = 0.8 * a + 0.6 * gauss();
        const c = gauss();
        X.data[i * 3] = a; X.data[i * 3 + 1] = b; X.data[i * 3 + 2] = c;
        y[i] = 0.7 * b + 0.5 * gauss();
    }
    const net = E.featureNetwork(X, y, new Float64Array(n).fill(1), ['a', 'b', 'c']);
    const link = (name) => net.toPerformance.find((t) => t.column === name);
    assert.ok(link('b').significant && link('b').partialCorrelation > 0.5);
    assert.ok(!link('a').significant, `a is only linked through b (${link('a').partialCorrelation})`);
    assert.ok(!link('c').significant);
    assert.ok(net.edges.some((e) => e.a === 'a' && e.b === 'b'));
    assert.ok(net.shrinkage >= 0 && net.shrinkage <= 1);
});

test('components: two correlated groups of features form the first two styles', () => {
    // Groups of different size (3 and 2 features) so the two eigenvalues differ and the styles are unique.
    const r = L.rng(5);
    const n = 800;
    const p = 5;
    const X = L.zeros(n, p);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const s1 = r() - 0.5;
        const s2 = r() - 0.5;
        for (let j = 0; j < 3; j++) X.data[i * p + j] = s1 + 0.05 * (r() - 0.5);
        for (let j = 3; j < 5; j++) X.data[i * p + j] = s2 + 0.05 * (r() - 0.5);
        y[i] = s1;
    }
    const comps = E.styleComponents(X, y, new Float64Array(n).fill(1), ['cut1', 'cut2', 'cut3', 'text1', 'text2'], { k: 2 });
    assert.ok(comps[0].explained + comps[1].explained > 0.95);
    assert.ok(comps[0].explained > 0.55 && comps[0].explained < 0.65, 'first style explains ~3/5');
    const style = (c, k) => c.loadings.slice(0, k).map((l) => l.column).sort().join(',');
    assert.equal(style(comps[0], 3), 'cut1,cut2,cut3');
    assert.equal(style(comps[1], 2), 'text1,text2');
    assert.ok(Math.abs(comps[0].correlationWithPerformance) > 0.9, 'the cut style is the one tied to performance');
    assert.ok(Math.abs(comps[1].correlationWithPerformance) < 0.15);
});

test('neural network learns an interaction that a linear model cannot', () => {
    const r = L.rng(9);
    const n = 1500;
    const X = L.zeros(n, 2);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const a = r() * 2 - 1;
        const b = r() * 2 - 1;
        X.data[i * 2] = a; X.data[i * 2 + 1] = b;
        y[i] = a * b * 2; // pure interaction: zero linear signal
    }
    const w = new Float64Array(n).fill(1);
    const all = Array.from({ length: n }, (_, i) => i);
    const net = E.trainMLP(X, y, w, { trainIdx: all.filter((i) => i % 5), valIdx: all.filter((i) => !(i % 5)), epochs: 150, hidden: 12, lr: 0.01, patience: 25 });
    const pred = net.predict(X);
    const groups = all.map(() => 'g');
    const m = E.evaluate(y, pred, w, groups, all.filter((i) => !(i % 5)));
    assert.ok(m.skill > 0.6, JSON.stringify(m));
    const g = L.gram(X, y, w);
    const lin = E.predictLinear(X, E.ridgeSolve(g.G, g.v, 1e-6));
    assert.ok(E.evaluate(y, lin, w, groups).skill < 0.05, 'linear model finds nothing');
});

test('runEngineInWorker: same result off the main thread', async () => {
    const { runEngineInWorker } = await import('../src/service/learning/model/trainer.js');
    const rows = synth({ creators: 30, per: 6 });
    const inWorker = await runEngineInWorker(rows, { mlp: false });
    const inline = E.runEngine(rows, { mlp: false });
    assert.equal(inWorker.n, inline.n);
    assert.deepEqual(inWorker.ridge.beta, inline.ridge.beta);
});

test('runEngine: end to end, and skips politely with too little data', () => {
    const out = E.runEngine(synth({ creators: 50, per: 6 }), { mlp: true });
    assert.equal(out.creators, 50);
    assert.ok(out.ridge.metrics.skill > 0.4);
    assert.ok(out.network.toPerformance.length === out.p);
    assert.ok(out.components.length > 0);
    assert.ok(out.neural && typeof out.neural.beatsRidge === 'boolean');
    assert.match(E.runEngine(synth({ creators: 2, per: 2 })).skipped, /too little/);
});

// ---------------------------------------------------------------- shadow mode (promotion + serving)

const S = await import('../src/service/learning/model/shadow.js');

test('engine: out-of-fold predictions for chosen rows, a residual spread, and serving matches the fit', () => {
    const rows = synth({ creators: 40, per: 6 });
    const out = E.runEngine(rows, { mlp: false, evalRows: [0, 1, 2, 7] });
    assert.deepEqual(out.evaluation.map((e) => e.row), [0, 1, 2, 7]);
    assert.ok(out.evaluation.every((e) => Number.isFinite(e.pred)));
    assert.ok(out.spread.low <= 0 && out.spread.high >= 0 && out.spread.n === out.n);
    assert.equal(E.runEngine(rows, { mlp: false }).evaluation, null, 'no evaluation unless asked');
    // A faster cut predicts more views than a slower one for the same creator centre.
    const model = { spec: out.spec, beta: out.ridge.beta };
    const centre = E.creatorCentre(out.spec, rows.slice(0, 6).map((r) => r.features));
    const fast = E.predictLogDeviation(model, { ...rows[0].features, fastCut: 3 }, { centre });
    const slow = E.predictLogDeviation(model, { ...rows[0].features, fastCut: 0.5 }, { centre });
    assert.ok(fast > slow);
    assert.equal(E.predictLogDeviation({ spec: out.spec, beta: [1] }, {}), null, 'mismatched model cannot score');
});

test('shadow: band inverts the label, flag defaults off', () => {
    assert.deepEqual(S.shadowBand({ baselineViews: 999, logDeviation: 0, spread: { low: -Math.LN2, high: Math.LN2 } }), { low: 499, expected: 999, high: 1999 });
    assert.equal(S.shadowBand({ baselineViews: null, logDeviation: 0 }), null);
    assert.equal(S.shadowEnabled({}), false);
    assert.equal(S.shadowEnabled({ LEARNING_SHADOW_PREDICTIONS: 'true' }), true);
});

const fakeModelStore = () => {
    const calls = [];
    return {
        calls,
        updateOne: async (filter, update) => { calls.push(['updateOne', filter, update]); },
        updateMany: async (filter, update) => { calls.push(['updateMany', filter, update]); },
    };
};

test('promotion: uses evaluate.js promotionDecision on the same videos; a failing model stays candidate', async () => {
    const model = { spec: { columns: [{ type: 'num', key: 'viralityScore', impute: 60, mean: 60, sd: 10 }] }, beta: [0.3], spread: { low: -0.9, high: 0.9 } };
    // Too few results: never promoted, whatever the errors.
    const few = Array.from({ length: 10 }, (_, i) => ({ actual: 1000 + i, baseline: 1000, pred: 0, champion: { low: 10, expected: 100, high: 300 } }));
    const check = S.promotionCheck({ testRows: few, model });
    assert.equal(check.promote, false);
    assert.match(check.reasons.join(' '), /needs at least 50 test results/);
    assert.equal(check.champion.n, check.challenger.n, 'scored on the same rows');
    assert.equal(check.ownerCases.length, 2);
    const store = fakeModelStore();
    const applied = await S.applyPromotion({ id: 'm2', check, model: store });
    assert.equal(applied.status, 'candidate');
    assert.equal(store.calls.length, 1, 'no other model touched: the previous shadow model keeps running');
    assert.equal(store.calls[0][2].$set.status, undefined);
});

test('promotion: a passing model becomes shadow and the previous shadow model is retired', async () => {
    const store = fakeModelStore();
    const check = { promote: true, reasons: [], champion: { n: 60 }, challenger: { n: 60 }, ownerCases: [] };
    const applied = await S.applyPromotion({ id: 'm3', check, model: store, now: Date.UTC(2026, 10, 23) });
    assert.equal(applied.status, 'shadow');
    assert.deepEqual(store.calls.map((c) => c[0]), ['updateOne', 'updateMany'], 'promote first, then retire the others');
    assert.equal(store.calls[0][2].$set.status, 'shadow');
    assert.deepEqual(store.calls[1][1], { kind: 'matrix_engine', status: 'shadow', _id: { $ne: 'm3' } });
    assert.equal(store.calls[1][2].$set.status, 'retired');
});

test('promotion after training: evaluation rows joined to the live bands users saw', async () => {
    const rows = synth({ creators: 40, per: 6 }).map((r, i) => (i % 3 ? r : { ...r, meta: { subjectId: `v${i}`, actual: 500, baseline: 400 } }));
    const evalRows = rows.flatMap((r, i) => (r.meta ? [i] : []));
    const result = E.runEngine(rows.map(({ y, w, group, features }) => ({ y, w, group, features })), { mlp: false, evalRows });
    const store = fakeModelStore();
    let asked = null;
    const out = await S.promoteAfterTraining({
        id: 'm4', result, rows,
        deps: { model: store, liveBands: async (ids) => { asked = ids; return new Map(ids.map((id) => [id, { low: 100, expected: 400, high: 1200 }])); } },
    });
    assert.equal(asked.length, evalRows.length);
    assert.equal(out.champion.n, evalRows.length);
    assert.equal(out.challenger.n, evalRows.length);
    assert.equal(typeof out.promote, 'boolean');
});

test('shadow hook: off by default, never throws, never touches the video', async () => {
    const video = { _id: 'v1', predictedViewsLow: 100, predictedViewsExpected: 400, predictedViewsHigh: 1200, creatorPlatform: 'tiktok' };
    const before = JSON.stringify(video);
    let touched = false;
    const off = await S.recordShadowPrediction(video, { env: {}, deps: { loadModel: async () => { touched = true; } } });
    assert.match(off.skipped, /off/);
    assert.equal(touched, false);
    const on = { LEARNING_SHADOW_PREDICTIONS: 'true' };
    const reported = [];
    const failed = await S.recordShadowPrediction(video, { env: on, deps: { loadModel: async () => { throw new Error('db down'); }, report: (e) => reported.push(e.message) } });
    assert.equal(failed.error, 'db down');
    assert.deepEqual(reported, ['db down']);
    assert.match((await S.recordShadowPrediction(video, { env: on, deps: { loadModel: async () => null } })).skipped, /no promoted model/);
    const model = { id: 'm5', version: 5, spec: { columns: [{ type: 'num', key: 'viralityScore', impute: 60, mean: 60, sd: 10 }] }, beta: [0.5], spread: { low: -1, high: 1 } };
    let saved = null;
    const ok = await S.recordShadowPrediction(video, {
        env: on,
        deps: {
            loadModel: async () => model,
            loadInputs: async () => ({ features: { viralityScore: 70 }, baseline: { views: 999, method: 'followers', n: 0 }, centreFeatures: [] }),
            save: async (id, record) => { saved = record; },
        },
    });
    assert.equal(ok.recorded.expected, Math.round(1000 * Math.exp(0.5) - 1));
    assert.equal(saved.modelVersion, 5);
    assert.deepEqual(saved.formula, { low: 100, expected: 400, high: 1200 });
    assert.equal(JSON.stringify(video), before, 'what the user sees is unchanged');
});
