/**
 * The matrix engine (docs/learning-engine/PLAN.md, section 16). Pure and synchronous; trainer.js loads the data
 * and runs this in a worker thread so the API never waits on it.
 *
 * Notation: n videos, p feature columns, X (n x p) standardized design matrix, y (n) label =
 * ln((views + 1) / (creator baseline + 1)) capped at ±ln 50, w (n) weights, D (n x g) creator indicator matrix.
 *
 *  1. Within-creator projection  M = I - D (D^T W D)^-1 D^T W.  X~ = M X, y~ = M y subtract each creator's
 *     weighted mean, so every coefficient is learned from differences between videos of the SAME creator
 *     (account size, audience and niche cancel). Computed by group means, never as an n x n matrix.
 *  2. Ridge regression  beta = (X~^T W X~ + lambda I)^-1 X~^T W y~, lambda by K-fold CV with whole creators per
 *     fold. exp(beta_j) = views multiplier for +1 standard deviation of feature j, other features held fixed.
 *  3. Statistical network  Sigma* = (1 - d) S + d mu I (Ledoit-Wolf shrinkage of the covariance of [X~, y~]),
 *     Omega = Sigma*^-1, partial correlation rho_ij = -Omega_ij / sqrt(Omega_ii Omega_jj): which features are
 *     directly linked (to each other and to performance) once all the others are accounted for.
 *  4. Components  eigen-decomposition of corr(X~) = V Lambda V^T: a few "editing styles" that summarize many
 *     correlated features, and how each style relates to performance.
 *  5. Neural network  y^ = tanh(X~ W1 + b1) W2 + b2 (one hidden layer, Adam, L2, early stopping on held-out
 *     creators): can learn interactions ridge cannot. Kept only if it beats ridge on the same held-out creators.
 */
import { accumulateGram, finishGram, identity, inverseSPD, rng, solveSPD, symmetricEigen, zeros } from './linalg.js';

const round = (x, places = 4) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** places) / 10 ** places);

// ---------------------------------------------------------------- design matrix

/** Features that are heavy-tailed counts: modelled on a log scale. */
const LOG_KEYS = new Set(['captionChars', 'hashtagCount', 'openingWords', 'wordsBeforeFirstCut', 'sceneCount', 'shotCountExact', 'hookTextWords', 'soundUsesPrior14d', 'softCutCount']);
/** Hour / weekday are circular: 23:00 is next to 00:00. */
const CYCLIC = { postHourUtc: 24, postWeekdayUtc: 7 };
/** Bookkeeping keys that are never inputs. */
const SKIP = new Set(['speechFromCaptions']);

/**
 * Builds the standardized design matrix.
 * rows: [{ features: {k: number|boolean|string}, y, w, group }]
 * Numeric/boolean keys present in >= minCoverage of rows become columns (mean-imputed, plus a "<key> missing"
 * column when coverage < 98%); string keys become one-hot columns for levels with >= minLevel rows.
 * Returns { X, y, w, groups, columns, spec } where spec can transform new rows identically (transformRow).
 */
export const buildDesign = (rows, { minCoverage = 0.2, minLevel = 20, categorical = [] } = {}) => {
    const n = rows.length;
    const numericKeys = new Map();
    const catKeys = new Map();
    for (const r of rows) {
        for (const [k, v] of Object.entries(r.features ?? {})) {
            if (SKIP.has(k) || v == null) continue;
            if (typeof v === 'string' || categorical.includes(k)) {
                if (!catKeys.has(k)) catKeys.set(k, new Map());
                catKeys.get(k).set(String(v), (catKeys.get(k).get(String(v)) ?? 0) + 1);
            } else if (typeof v === 'boolean' || Number.isFinite(v)) {
                numericKeys.set(k, (numericKeys.get(k) ?? 0) + 1);
            }
        }
    }
    const numeric = [];
    for (const [key, count] of [...numericKeys.entries()].sort()) {
        if (count / n < minCoverage) continue;
        const raw = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : Number(v));
        if (CYCLIC[key]) {
            for (const fn of ['sin', 'cos']) numeric.push({ key, fn, period: CYCLIC[key], coverage: count / n });
        } else {
            numeric.push({ key, fn: LOG_KEYS.has(key) ? 'log' : null, coverage: count / n, raw });
        }
    }
    const transform = (spec, v) => {
        if (v == null || (typeof v !== 'boolean' && !Number.isFinite(Number(v)))) return null;
        const x = typeof v === 'boolean' ? (v ? 1 : 0) : Number(v);
        if (spec.fn === 'log') return Math.sign(x) * Math.log1p(Math.abs(x));
        if (spec.fn === 'sin') return Math.sin((2 * Math.PI * x) / spec.period);
        if (spec.fn === 'cos') return Math.cos((2 * Math.PI * x) / spec.period);
        return x;
    };
    const cats = [...catKeys.entries()].sort().map(([key, levels]) => ({
        key, levels: [...levels.entries()].filter(([, c]) => c >= minLevel).map(([l]) => l).sort(),
    })).filter((c) => c.levels.length >= 2);

    // Column means for imputation, then mean/sd for standardization.
    const columns = [];
    const specCols = [];
    for (const s of numeric) {
        const vals = rows.map((r) => transform(s, r.features?.[s.key])).filter((v) => v != null);
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        specCols.push({ type: 'num', key: s.key, fn: s.fn, period: s.period, impute: mean });
        columns.push(s.fn === 'sin' || s.fn === 'cos' ? `${s.key}:${s.fn}` : s.key);
        if (s.coverage < 0.98 && !(s.fn === 'cos')) {
            specCols.push({ type: 'missing', key: s.key });
            columns.push(`${s.key}:missing`);
        }
    }
    for (const c of cats) for (const level of c.levels) { specCols.push({ type: 'cat', key: c.key, level }); columns.push(`${c.key}=${level}`); }

    const rawRow = (features) => specCols.map((c) => {
        const v = features?.[c.key];
        if (c.type === 'num') return transform(c, v) ?? c.impute;
        if (c.type === 'missing') return v == null ? 1 : 0;
        return String(v) === c.level ? 1 : 0;
    });
    const p = specCols.length;
    const raw = rows.map((r) => rawRow(r.features));
    for (let j = 0; j < p; j++) {
        let m = 0;
        for (let i = 0; i < n; i++) m += raw[i][j];
        m /= n || 1;
        let v = 0;
        for (let i = 0; i < n; i++) v += (raw[i][j] - m) ** 2;
        specCols[j].mean = m;
        specCols[j].sd = Math.sqrt(v / Math.max(1, n - 1));
    }
    // Drop constant columns.
    const keep = specCols.map((c, j) => (c.sd > 1e-9 ? j : -1)).filter((j) => j >= 0);
    const X = zeros(n, keep.length);
    for (let i = 0; i < n; i++) keep.forEach((j, jj) => { X.data[i * keep.length + jj] = (raw[i][j] - specCols[j].mean) / specCols[j].sd; });
    const spec = { columns: keep.map((j) => specCols[j]) };
    return {
        X,
        y: Float64Array.from(rows.map((r) => r.y)),
        w: Float64Array.from(rows.map((r) => (Number.isFinite(r.w) ? r.w : 1))),
        groups: rows.map((r) => String(r.group)),
        columns: keep.map((j) => columns[j]),
        spec,
    };
};

/** The standardized vector for a new video, using a stored spec. */
export const transformRow = (spec, features) => spec.columns.map((c) => {
    const v = features?.[c.key];
    let x;
    if (c.type === 'num') {
        if (v == null || (typeof v !== 'boolean' && !Number.isFinite(Number(v)))) x = c.impute;
        else {
            const n = typeof v === 'boolean' ? (v ? 1 : 0) : Number(v);
            x = c.fn === 'log' ? Math.sign(n) * Math.log1p(Math.abs(n)) : c.fn === 'sin' ? Math.sin((2 * Math.PI * n) / c.period) : c.fn === 'cos' ? Math.cos((2 * Math.PI * n) / c.period) : n;
        }
    } else if (c.type === 'missing') x = v == null ? 1 : 0;
    else x = String(v) === c.level ? 1 : 0;
    return (x - c.mean) / c.sd;
});

// ---------------------------------------------------------------- within-creator projection

/**
 * X~ = M X and y~ = M y with M = I - D (D^T W D)^-1 D^T W: subtracts each creator's weighted mean.
 * Creators with a single video carry no within-creator information and are dropped.
 * Returns { X, y, w, groups, kept } (kept = original row indexes).
 */
export const withinCreators = (X, y, w, groups) => {
    const idx = new Map();
    groups.forEach((g, i) => { if (!idx.has(g)) idx.set(g, []); idx.get(g).push(i); });
    const kept = [];
    for (const list of idx.values()) if (list.length >= 2) kept.push(...list);
    kept.sort((a, b) => a - b);
    const p = X.cols;
    const Xd = zeros(kept.length, p);
    const yd = new Float64Array(kept.length);
    const wd = new Float64Array(kept.length);
    const gd = [];
    const pos = new Map(kept.map((orig, k) => [orig, k]));
    for (const list of idx.values()) {
        if (list.length < 2) continue;
        let sw = 0;
        const mx = new Float64Array(p);
        let my = 0;
        for (const i of list) {
            sw += w[i];
            my += w[i] * y[i];
            for (let j = 0; j < p; j++) mx[j] += w[i] * X.data[i * p + j];
        }
        if (!(sw > 0)) continue;
        for (let j = 0; j < p; j++) mx[j] /= sw;
        my /= sw;
        for (const i of list) {
            const k = pos.get(i);
            for (let j = 0; j < p; j++) Xd.data[k * p + j] = X.data[i * p + j] - mx[j];
            yd[k] = y[i] - my;
            wd[k] = w[i];
            gd[k] = groups[i];
        }
    }
    return { X: Xd, y: yd, w: wd, groups: gd, kept };
};

// ---------------------------------------------------------------- ridge + grouped cross-validation

/** Stable fold of a creator: the same creator is always in the same fold. */
export const foldOf = (group, k) => {
    let h = 2166136261;
    for (const ch of String(group)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return (h >>> 0) % k;
};

const subsetGram = (X, y, w, mask) => {
    const G = zeros(X.cols, X.cols);
    const v = new Float64Array(X.cols);
    const wm = Float64Array.from(w, (wi, i) => (mask(i) ? wi : 0));
    accumulateGram(G, v, X, y, wm);
    return { G: finishGram(G), v };
};

export const ridgeSolve = (G, v, lambda) => {
    const p = G.rows;
    const A = zeros(p, p);
    A.data.set(G.data);
    for (let j = 0; j < p; j++) A.data[j * p + j] += lambda;
    return solveSPD(A, v);
};

export const predictLinear = (X, beta) => {
    const out = new Float64Array(X.rows);
    for (let i = 0; i < X.rows; i++) {
        let s = 0;
        for (let j = 0; j < X.cols; j++) s += X.data[i * X.cols + j] * beta[j];
        out[i] = s;
    }
    return out;
};

/**
 * Accuracy of within-creator predictions on held-out rows.
 *   rmse / rmseBaseline: error vs predicting "the creator's usual" (0); skill = 1 - rmse / rmseBaseline
 *   within2x: share of videos predicted within a factor of 2 of their real deviation
 *   pairAccuracy: for two videos of the same creator, how often the model ranks them correctly (0.5 = coin)
 */
export const evaluate = (y, pred, w, groups, idx = null) => {
    const rows = idx ?? Array.from(y, (_, i) => i);
    let sw = 0; let se = 0; let se0 = 0; let in2 = 0;
    for (const i of rows) {
        sw += w[i];
        se += w[i] * (y[i] - pred[i]) ** 2;
        se0 += w[i] * y[i] ** 2;
        if (Math.abs(y[i] - pred[i]) <= Math.LN2) in2 += w[i];
    }
    const byGroup = new Map();
    for (const i of rows) { if (!byGroup.has(groups[i])) byGroup.set(groups[i], []); byGroup.get(groups[i]).push(i); }
    let agree = 0; let total = 0;
    for (const list of byGroup.values()) {
        for (let a = 0; a < list.length; a++) {
            for (let b = a + 1; b < list.length; b++) {
                const dy = y[list[a]] - y[list[b]];
                if (Math.abs(dy) < 0.1) continue;
                total += 1;
                const dp = pred[list[a]] - pred[list[b]];
                if (dp === 0) agree += 0.5;
                else if (Math.sign(dp) === Math.sign(dy)) agree += 1;
            }
        }
    }
    const rmse = sw ? Math.sqrt(se / sw) : null;
    const rmseBaseline = sw ? Math.sqrt(se0 / sw) : null;
    return {
        n: rows.length,
        rmse: round(rmse),
        rmseBaseline: round(rmseBaseline),
        skill: rmse != null && rmseBaseline ? round(1 - rmse / rmseBaseline) : null,
        within2x: sw ? round(in2 / sw) : null,
        pairAccuracy: total ? round(agree / total) : null,
        pairs: total,
    };
};

/** Picks lambda by K-fold CV with whole creators per fold; returns the CV table and out-of-fold predictions. */
export const crossValidateRidge = (X, y, w, groups, { k = 5, lambdas = [0.3, 1, 3, 10, 30, 100, 300, 1000] } = {}) => {
    const folds = groups.map((g) => foldOf(g, k));
    const full = subsetGram(X, y, w, () => true);
    const oof = Object.fromEntries(lambdas.map((l) => [l, new Float64Array(y.length)]));
    for (let f = 0; f < k; f++) {
        if (!folds.some((x) => x === f)) continue;
        const test = subsetGram(X, y, w, (i) => folds[i] === f);
        // Training gram = full - test (no second pass over the data).
        const G = zeros(X.cols, X.cols);
        for (let t = 0; t < G.data.length; t++) G.data[t] = full.G.data[t] - test.G.data[t];
        const v = Float64Array.from(full.v, (x, j) => x - test.v[j]);
        for (const l of lambdas) {
            const beta = ridgeSolve(G, v, l);
            for (let i = 0; i < y.length; i++) {
                if (folds[i] !== f) continue;
                let s = 0;
                for (let j = 0; j < X.cols; j++) s += X.data[i * X.cols + j] * beta[j];
                oof[l][i] = s;
            }
        }
    }
    const table = lambdas.map((l) => ({ lambda: l, ...evaluate(y, oof[l], w, groups) }));
    const best = table.reduce((a, b) => ((b.rmse ?? Infinity) < (a.rmse ?? Infinity) ? b : a));
    return { lambda: best.lambda, table, oof: oof[best.lambda], full };
};

/** Full ridge fit with chosen lambda: coefficients with plain readings. */
export const fitRidge = (X, y, w, groups, columns, opts = {}) => {
    const cv = crossValidateRidge(X, y, w, groups, opts);
    const beta = ridgeSolve(cv.full.G, cv.full.v, cv.lambda);
    const coefficients = columns.map((c, j) => ({ column: c, beta: round(beta[j]), multiplier: round(Math.exp(beta[j]), 3) }))
        .sort((a, b) => Math.abs(b.beta) - Math.abs(a.beta));
    return { lambda: cv.lambda, beta, coefficients, cv: cv.table, metrics: evaluate(y, cv.oof, w, groups), oof: cv.oof };
};

// ---------------------------------------------------------------- statistical network

/**
 * Ledoit-Wolf shrinkage of the weighted covariance of the columns of Z toward mu I (mu = mean variance).
 * Returns { S (p x p), delta }.
 */
export const ledoitWolf = (Z, w = null) => {
    const n = Z.rows;
    const p = Z.cols;
    const wt = w ?? new Float64Array(n).fill(1);
    let sw = 0;
    for (let i = 0; i < n; i++) sw += wt[i];
    const mean = new Float64Array(p);
    for (let i = 0; i < n; i++) for (let j = 0; j < p; j++) mean[j] += wt[i] * Z.data[i * p + j];
    for (let j = 0; j < p; j++) mean[j] /= sw;
    const S = zeros(p, p);
    const C = zeros(n, p);
    for (let i = 0; i < n; i++) for (let j = 0; j < p; j++) C.data[i * p + j] = Z.data[i * p + j] - mean[j];
    accumulateGram(S, null, C, null, wt);
    finishGram(S);
    for (let t = 0; t < S.data.length; t++) S.data[t] /= sw;
    let mu = 0;
    for (let j = 0; j < p; j++) mu += S.data[j * p + j];
    mu /= p;
    // d^2 = ||S - mu I||^2 ; b^2 = (1/n^2) sum_i ||x_i x_i^T - S||^2 (Ledoit & Wolf 2004), with weights.
    let d2 = 0;
    for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) d2 += (S.data[a * p + b] - (a === b ? mu : 0)) ** 2;
    let b2 = 0;
    const nEff = sw ** 2 / Array.from(wt).reduce((s, x) => s + x * x, 0);
    for (let i = 0; i < n; i++) {
        let s = 0;
        for (let a = 0; a < p; a++) {
            const ca = C.data[i * p + a];
            for (let b = 0; b < p; b++) s += (ca * C.data[i * p + b] - S.data[a * p + b]) ** 2;
        }
        b2 += (wt[i] / sw) * s;
    }
    b2 = Math.min(d2, b2 / nEff);
    const delta = d2 > 0 ? b2 / d2 : 1;
    const out = zeros(p, p);
    for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) out.data[a * p + b] = (1 - delta) * S.data[a * p + b] + (a === b ? delta * mu : 0);
    return { S: out, delta: round(delta), nEff };
};

/** Partial correlations from a covariance matrix: rho_ij = -Omega_ij / sqrt(Omega_ii Omega_jj). */
export const partialCorrelations = (S) => {
    const p = S.rows;
    const O = inverseSPD(S);
    const P = zeros(p, p);
    for (let a = 0; a < p; a++) {
        for (let b = 0; b < p; b++) {
            P.data[a * p + b] = a === b ? 1 : -O.data[a * p + b] / Math.sqrt(O.data[a * p + a] * O.data[b * p + b]);
        }
    }
    return P;
};

/**
 * The feature network: partial correlations of [X~, y~], significant edges only (Fisher z with p - 2 controls,
 * |z| > zCrit), and every feature's direct link to performance.
 */
export const featureNetwork = (X, y, w, columns, { zCrit = 3.29, maxEdges = 60 } = {}) => {
    const n = X.rows;
    const p = X.cols;
    const Z = zeros(n, p + 1);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < p; j++) Z.data[i * (p + 1) + j] = X.data[i * p + j];
        Z.data[i * (p + 1) + p] = y[i];
    }
    const { S, delta, nEff } = ledoitWolf(Z, w);
    const P = partialCorrelations(S);
    const se = 1 / Math.sqrt(Math.max(1, nEff - (p - 1) - 3));
    const zOf = (r) => Math.atanh(Math.max(-0.999999, Math.min(0.999999, r))) / se;
    const names = [...columns, 'PERFORMANCE'];
    const q = p + 1;
    const edges = [];
    for (let a = 0; a < q; a++) {
        for (let b = a + 1; b < q; b++) {
            const r = P.data[a * q + b];
            const z = zOf(r);
            if (Math.abs(z) >= zCrit) edges.push({ a: names[a], b: names[b], partialCorrelation: round(r, 3), z: round(z, 2) });
        }
    }
    edges.sort((e1, e2) => Math.abs(e2.partialCorrelation) - Math.abs(e1.partialCorrelation));
    const toPerformance = columns.map((c, j) => {
        const r = P.data[j * q + p];
        return { column: c, partialCorrelation: round(r, 3), z: round(zOf(r), 2), significant: Math.abs(zOf(r)) >= zCrit };
    }).sort((a, b) => Math.abs(b.partialCorrelation) - Math.abs(a.partialCorrelation));
    return { shrinkage: delta, effectiveN: round(nEff, 1), edges: edges.slice(0, maxEdges), toPerformance };
};

// ---------------------------------------------------------------- components (editing styles)

/** Principal components of corr(X~): explained variance, top loadings, and each style's link to performance. */
export const styleComponents = (X, y, w, columns, { k = 6, top = 6 } = {}) => {
    const n = X.rows;
    const p = X.cols;
    if (p < 2 || n < 3) return [];
    const { S } = ledoitWolf(X, w);
    const sd = Array.from({ length: p }, (_, j) => Math.sqrt(S.data[j * p + j]) || 1);
    const R = zeros(p, p);
    for (let a = 0; a < p; a++) for (let b = 0; b < p; b++) R.data[a * p + b] = S.data[a * p + b] / (sd[a] * sd[b]);
    const { values, vectors } = symmetricEigen(R);
    const total = values.reduce((s, v) => s + Math.max(0, v), 0) || 1;
    const out = [];
    for (let c = 0; c < Math.min(k, p); c++) {
        const loadings = columns.map((col, j) => ({ column: col, loading: vectors.data[j * p + c] }));
        const scores = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            let s = 0;
            for (let j = 0; j < p; j++) s += (X.data[i * p + j] / sd[j]) * vectors.data[j * p + c];
            scores[i] = s;
        }
        let sw = 0; let sxy = 0; let sxx = 0; let syy = 0;
        for (let i = 0; i < n; i++) { sw += w[i]; sxy += w[i] * scores[i] * y[i]; sxx += w[i] * scores[i] ** 2; syy += w[i] * y[i] ** 2; }
        out.push({
            component: c + 1,
            explained: round(Math.max(0, values[c]) / total, 3),
            correlationWithPerformance: sxx && syy ? round(sxy / Math.sqrt(sxx * syy), 3) : null,
            loadings: loadings.sort((a, b) => Math.abs(b.loading) - Math.abs(a.loading)).slice(0, top).map((l) => ({ column: l.column, loading: round(l.loading, 3) })),
        });
    }
    return out;
};

// ---------------------------------------------------------------- neural network

/**
 * One-hidden-layer network trained with mini-batch Adam on weighted squared error + L2.
 * Forward pass per batch B (b x p): H = tanh(B W1 + 1 b1^T), y^ = H W2 + b2 (matrix products).
 * Backward: g = 2 w (y^ - y) / sum w; dW2 = H^T g; dH = g W2^T * (1 - H^2); dW1 = B^T dH + 2 l2 W1.
 * Early stopping on `valIdx` (held-out creators). Deterministic for a given seed.
 */
export const trainMLP = (X, y, w, { trainIdx, valIdx, hidden = 16, epochs = 80, batch = 64, lr = 0.005, l2 = 1e-3, patience = 10, seed = 7 } = {}) => {
    const p = X.cols;
    const rand = rng(seed);
    const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
    const W1 = Float64Array.from({ length: p * hidden }, () => gauss() * Math.sqrt(1 / p));
    const b1 = new Float64Array(hidden);
    const W2 = Float64Array.from({ length: hidden }, () => gauss() * Math.sqrt(1 / hidden));
    let b2 = 0;
    const params = [W1, b1, W2];
    const m = params.map((a) => new Float64Array(a.length));
    const v = params.map((a) => new Float64Array(a.length));
    let mb2 = 0; let vb2 = 0;
    const beta1 = 0.9; const beta2 = 0.999; const eps = 1e-8;
    let step = 0;
    const H = new Float64Array(batch * hidden);
    const forwardOne = (i, h) => {
        let out = b2;
        for (let u = 0; u < hidden; u++) {
            let s = b1[u];
            for (let j = 0; j < p; j++) s += X.data[i * p + j] * W1[j * hidden + u];
            const t = Math.tanh(s);
            if (h) h[u] = t;
            out += t * W2[u];
        }
        return out;
    };
    const loss = (idx) => {
        let sw = 0; let se = 0;
        for (const i of idx) { const e = forwardOne(i) - y[i]; se += w[i] * e * e; sw += w[i]; }
        return sw ? se / sw : 0;
    };
    const order = [...trainIdx];
    let best = { loss: Infinity, W1: null, b1: null, W2: null, b2: 0, epoch: 0 };
    let bad = 0;
    const history = [];
    for (let epoch = 0; epoch < epochs; epoch++) {
        for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
        for (let s0 = 0; s0 < order.length; s0 += batch) {
            const idx = order.slice(s0, s0 + batch);
            const gW1 = new Float64Array(p * hidden);
            const gb1 = new Float64Array(hidden);
            const gW2 = new Float64Array(hidden);
            let gb2 = 0;
            let sw = 0;
            for (const i of idx) sw += w[i];
            if (!sw) continue;
            idx.forEach((i, r) => {
                const h = H.subarray(r * hidden, (r + 1) * hidden);
                const g = (2 * w[i] * (forwardOne(i, h) - y[i])) / sw;
                gb2 += g;
                for (let u = 0; u < hidden; u++) {
                    gW2[u] += g * h[u];
                    const dh = g * W2[u] * (1 - h[u] * h[u]);
                    gb1[u] += dh;
                    for (let j = 0; j < p; j++) gW1[j * hidden + u] += X.data[i * p + j] * dh;
                }
            });
            for (let t = 0; t < W1.length; t++) gW1[t] += 2 * l2 * W1[t];
            for (let t = 0; t < W2.length; t++) gW2[t] += 2 * l2 * W2[t];
            step += 1;
            const grads = [gW1, gb1, gW2];
            const c1 = 1 - beta1 ** step;
            const c2 = 1 - beta2 ** step;
            params.forEach((P, k) => {
                for (let t = 0; t < P.length; t++) {
                    m[k][t] = beta1 * m[k][t] + (1 - beta1) * grads[k][t];
                    v[k][t] = beta2 * v[k][t] + (1 - beta2) * grads[k][t] ** 2;
                    P[t] -= (lr * (m[k][t] / c1)) / (Math.sqrt(v[k][t] / c2) + eps);
                }
            });
            mb2 = beta1 * mb2 + (1 - beta1) * gb2;
            vb2 = beta2 * vb2 + (1 - beta2) * gb2 ** 2;
            b2 -= (lr * (mb2 / c1)) / (Math.sqrt(vb2 / c2) + eps);
        }
        const val = loss(valIdx);
        history.push({ epoch, train: round(loss(trainIdx.slice(0, 2000))), val: round(val) });
        if (val < best.loss - 1e-6) {
            best = { loss: val, W1: Float64Array.from(W1), b1: Float64Array.from(b1), W2: Float64Array.from(W2), b2, epoch };
            bad = 0;
        } else if (++bad >= patience) break;
    }
    if (best.W1) { W1.set(best.W1); b1.set(best.b1); W2.set(best.W2); b2 = best.b2; }
    const predict = (Xn) => {
        const out = new Float64Array(Xn.rows);
        for (let i = 0; i < Xn.rows; i++) {
            let o = b2;
            for (let u = 0; u < hidden; u++) {
                let s = b1[u];
                for (let j = 0; j < Xn.cols; j++) s += Xn.data[i * Xn.cols + j] * W1[j * hidden + u];
                o += Math.tanh(s) * W2[u];
            }
            out[i] = o;
        }
        return out;
    };
    return { predict, bestEpoch: best.epoch, history: history.slice(-20), weights: { hidden, W1: Array.from(W1, (x) => round(x, 5)), b1: Array.from(b1, (x) => round(x, 5)), W2: Array.from(W2, (x) => round(x, 5)), b2: round(b2, 5) } };
};

// ---------------------------------------------------------------- serving (shadow)

/** Quantile of an ascending array (linear interpolation). */
const quantileSorted = (sorted, q) => {
    if (!sorted.length) return null;
    const i = (sorted.length - 1) * q;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

/**
 * How far real labels land from the out-of-fold prediction, as log factors: the 20th and 80th percentile
 * of y - y^ (y = label vs the creator's leave-one-out usual, y^ = prediction from a model that never saw
 * the creator). A served band is expected x exp(low) .. expected x exp(high), so about 60% of results fall
 * inside on paper; the promotion gate measures real coverage on users' videos.
 */
export const residualSpread = (y, pred, { low = 0.2, high = 0.8 } = {}) => {
    const r = [];
    for (let i = 0; i < pred.length; i++) if (Number.isFinite(y[i]) && Number.isFinite(pred[i])) r.push(y[i] - pred[i]);
    if (r.length < 10) return null;
    r.sort((a, b) => a - b);
    return { low: round(Math.min(0, quantileSorted(r, low))), high: round(Math.max(0, quantileSorted(r, high))), n: r.length };
};

/** Mean standardized vector of a creator's other videos (the "creator's usual" in feature space). */
export const creatorCentre = (spec, featureList = []) => {
    if (!spec?.columns?.length || !featureList.length) return null;
    const sum = new Float64Array(spec.columns.length);
    for (const f of featureList) transformRow(spec, f).forEach((x, j) => { sum[j] += x; });
    return Array.from(sum, (x) => x / featureList.length);
};

/**
 * The ridge model's predicted log deviation from the creator's usual for one video:
 * (x - centre) . beta, with centre = creatorCentre of the creator's other videos (0 = the training average
 * when the creator has no history). Returns null when the model cannot score the row.
 */
export const predictLogDeviation = ({ spec, beta }, features, { centre = null } = {}) => {
    if (!spec?.columns?.length || !Array.isArray(beta) || beta.length !== spec.columns.length) return null;
    const x = transformRow(spec, features);
    let s = 0;
    for (let j = 0; j < x.length; j++) s += (x[j] - (centre?.[j] ?? 0)) * beta[j];
    return Number.isFinite(s) ? s : null;
};

// ---------------------------------------------------------------- whole run

/**
 * Rows -> every analysis. Returns a plain object (stored as LearningModel).
 * opts.evalRows: input row indexes to return out-of-fold ridge predictions for (`evaluation`), so the trainer
 * can score the model on users' videos it never saw a creator's data for (promotion gate).
 */
export const runEngine = (rows, { k = 5, mlp = true, maxMlpRows = 15000, seed = 7, evalRows = null } = {}) => {
    const design = buildDesign(rows);
    const fe = withinCreators(design.X, design.y, design.w, design.groups);
    const creators = new Set(fe.groups).size;
    if (fe.X.rows < 30 || creators < 5 || fe.X.cols < 2) {
        return { skipped: `too little within-creator data (${fe.X.rows} videos from ${creators} creators with 2+ videos)`, n: fe.X.rows, creators };
    }
    const ridge = fitRidge(fe.X, fe.y, fe.w, fe.groups, design.columns, { k });
    const network = featureNetwork(fe.X, fe.y, fe.w, design.columns);
    const components = styleComponents(fe.X, fe.y, fe.w, design.columns);

    let neural = null;
    if (mlp && fe.X.rows >= 200) {
        // Hold out ~20% of creators (fold 0 of 5) for early stopping and the head-to-head with ridge.
        const all = Array.from({ length: fe.X.rows }, (_, i) => i);
        const val = all.filter((i) => foldOf(fe.groups[i], 5) === 0);
        let train = all.filter((i) => foldOf(fe.groups[i], 5) !== 0);
        if (train.length > maxMlpRows) train = train.filter((_, t) => t % Math.ceil(train.length / maxMlpRows) === 0);
        if (val.length >= 20) {
            const net = trainMLP(fe.X, fe.y, fe.w, { trainIdx: train, valIdx: val, seed });
            const pred = net.predict(fe.X);
            // Ridge refit without the held-out creators, scored on the same rows.
            const tr = subsetGram(fe.X, fe.y, fe.w, (i) => foldOf(fe.groups[i], 5) !== 0);
            const betaTr = ridgeSolve(tr.G, tr.v, ridge.lambda);
            const ridgePred = predictLinear(fe.X, betaTr);
            const nnMetrics = evaluate(fe.y, pred, fe.w, fe.groups, val);
            const ridgeMetrics = evaluate(fe.y, ridgePred, fe.w, fe.groups, val);
            neural = {
                metrics: nnMetrics,
                ridgeOnSameRows: ridgeMetrics,
                beatsRidge: (nnMetrics.rmse ?? Infinity) < (ridgeMetrics.rmse ?? Infinity) * 0.98,
                bestEpoch: net.bestEpoch,
                history: net.history,
                weights: net.weights,
            };
        }
    }
    // Out-of-fold predictions next to the raw labels (vs the leave-one-out usual), by original row index.
    const rawY = Float64Array.from(fe.kept, (orig) => design.y[orig]);
    const spread = residualSpread(rawY, ridge.oof);
    let evaluation = null;
    if (Array.isArray(evalRows)) {
        const wanted = new Set(evalRows);
        evaluation = [];
        fe.kept.forEach((orig, pos) => { if (wanted.has(orig)) evaluation.push({ row: orig, pred: round(ridge.oof[pos], 6) }); });
    }
    return {
        n: fe.X.rows,
        p: fe.X.cols,
        creators,
        spread,
        evaluation,
        columns: design.columns,
        spec: design.spec,
        lambda: ridge.lambda,
        ridge: { metrics: ridge.metrics, cv: ridge.cv, coefficients: ridge.coefficients, beta: Array.from(ridge.beta, (x) => round(x, 6)) },
        network,
        components,
        neural,
    };
};

export const _test = { subsetGram, identity };
