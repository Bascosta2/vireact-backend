/**
 * Small dense linear algebra for the learning engine (docs/learning-engine/PLAN.md, section 16).
 *
 * Matrices are row-major Float64Array with explicit (rows, cols). Sizes here are modest: n up to ~10^5
 * videos, p up to ~150 features, so the heavy products are X^T W X (p x p, O(n p^2)) and the network's
 * p x p inverses (O(p^3)). Everything is exact (no approximation) and deterministic.
 */

export const zeros = (rows, cols) => ({ rows, cols, data: new Float64Array(rows * cols) });

export const fromRows = (arr) => {
    const rows = arr.length;
    const cols = rows ? arr[0].length : 0;
    const m = zeros(rows, cols);
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) m.data[i * cols + j] = arr[i][j];
    return m;
};

export const toRows = (m) => Array.from({ length: m.rows }, (_, i) => Array.from(m.data.subarray(i * m.cols, (i + 1) * m.cols)));

export const identity = (n, scale = 1) => {
    const m = zeros(n, n);
    for (let i = 0; i < n; i++) m.data[i * n + i] = scale;
    return m;
};

/** C = A B (i-k-j order: streams rows of B, cache friendly). */
export const matmul = (A, B) => {
    if (A.cols !== B.rows) throw new Error(`matmul: ${A.rows}x${A.cols} by ${B.rows}x${B.cols}`);
    const C = zeros(A.rows, B.cols);
    const { data: a } = A;
    const { data: b } = B;
    const c = C.data;
    for (let i = 0; i < A.rows; i++) {
        const ci = i * B.cols;
        for (let k = 0; k < A.cols; k++) {
            const aik = a[i * A.cols + k];
            if (aik === 0) continue;
            const bk = k * B.cols;
            for (let j = 0; j < B.cols; j++) c[ci + j] += aik * b[bk + j];
        }
    }
    return C;
};

export const transpose = (A) => {
    const T = zeros(A.cols, A.rows);
    for (let i = 0; i < A.rows; i++) for (let j = 0; j < A.cols; j++) T.data[j * A.rows + i] = A.data[i * A.cols + j];
    return T;
};

/** y = A x for a vector x. */
export const matvec = (A, x) => {
    const y = new Float64Array(A.rows);
    for (let i = 0; i < A.rows; i++) {
        let s = 0;
        const o = i * A.cols;
        for (let j = 0; j < A.cols; j++) s += A.data[o + j] * x[j];
        y[i] = s;
    }
    return y;
};

/**
 * Accumulates G += X[rows]^T W X[rows] and v += X[rows]^T W y over a row range (upper triangle, mirrored by
 * finishGram). Split into ranges so a caller can yield between chunks.
 */
export const accumulateGram = (G, v, X, y, w, from = 0, to = X.rows) => {
    const p = X.cols;
    const x = X.data;
    for (let i = from; i < to; i++) {
        const wi = w ? w[i] : 1;
        if (!wi) continue;
        const o = i * p;
        const yi = y ? y[i] : 0;
        for (let a = 0; a < p; a++) {
            const xa = x[o + a] * wi;
            if (xa === 0) continue;
            if (v) v[a] += xa * yi;
            const ga = a * p;
            for (let b = a; b < p; b++) G.data[ga + b] += xa * x[o + b];
        }
    }
};
export const finishGram = (G) => {
    const p = G.rows;
    for (let a = 0; a < p; a++) for (let b = a + 1; b < p; b++) G.data[b * p + a] = G.data[a * p + b];
    return G;
};
/** X^T W X and X^T W y in one pass. */
export const gram = (X, y = null, w = null) => {
    const G = zeros(X.cols, X.cols);
    const v = y ? new Float64Array(X.cols) : null;
    accumulateGram(G, v, X, y, w);
    return { G: finishGram(G), v };
};

/** Cholesky A = L L^T for symmetric positive definite A. Adds tiny jitter if needed. */
export const cholesky = (A) => {
    const n = A.rows;
    for (let attempt = 0, jitter = 0; attempt < 6; attempt++, jitter = jitter ? jitter * 10 : 1e-10 * (trace(A) / n || 1)) {
        const L = zeros(n, n);
        let ok = true;
        for (let i = 0; i < n && ok; i++) {
            for (let j = 0; j <= i; j++) {
                let s = A.data[i * n + j] + (i === j ? jitter : 0);
                for (let k = 0; k < j; k++) s -= L.data[i * n + k] * L.data[j * n + k];
                if (i === j) {
                    if (!(s > 0)) { ok = false; break; }
                    L.data[i * n + i] = Math.sqrt(s);
                } else {
                    L.data[i * n + j] = s / L.data[j * n + j];
                }
            }
        }
        if (ok) return L;
    }
    throw new Error('cholesky: matrix is not positive definite');
};

export const trace = (A) => {
    let s = 0;
    for (let i = 0; i < Math.min(A.rows, A.cols); i++) s += A.data[i * A.cols + i];
    return s;
};

/** Solves (L L^T) x = b. */
export const choleskySolve = (L, b) => {
    const n = L.rows;
    const z = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let s = b[i];
        for (let k = 0; k < i; k++) s -= L.data[i * n + k] * z[k];
        z[i] = s / L.data[i * n + i];
    }
    const x = new Float64Array(n);
    for (let i = n - 1; i >= 0; i--) {
        let s = z[i];
        for (let k = i + 1; k < n; k++) s -= L.data[k * n + i] * x[k];
        x[i] = s / L.data[i * n + i];
    }
    return x;
};

/** Solves the symmetric positive definite system A x = b. */
export const solveSPD = (A, b) => choleskySolve(cholesky(A), b);

/** Inverse of a symmetric positive definite matrix (column by column through one Cholesky factor). */
export const inverseSPD = (A) => {
    const n = A.rows;
    const L = cholesky(A);
    const inv = zeros(n, n);
    const e = new Float64Array(n);
    for (let j = 0; j < n; j++) {
        e.fill(0);
        e[j] = 1;
        const col = choleskySolve(L, e);
        for (let i = 0; i < n; i++) inv.data[i * n + j] = col[i];
    }
    return inv;
};

/**
 * Eigen-decomposition of a symmetric matrix by cyclic Jacobi rotations.
 * Returns eigenvalues (descending) and eigenvectors as columns of `vectors`.
 */
export const symmetricEigen = (S, { maxSweeps = 100, tol = 1e-12 } = {}) => {
    const n = S.rows;
    const a = Float64Array.from(S.data);
    const V = identity(n);
    const v = V.data;
    for (let sweep = 0; sweep < maxSweeps; sweep++) {
        let off = 0;
        for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] ** 2;
        if (off < tol) break;
        for (let p = 0; p < n; p++) {
            for (let q = p + 1; q < n; q++) {
                const apq = a[p * n + q];
                if (Math.abs(apq) < 1e-300) continue;
                const theta = (a[q * n + q] - a[p * n + p]) / (2 * apq);
                const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
                const c = 1 / Math.sqrt(t * t + 1);
                const s = t * c;
                for (let k = 0; k < n; k++) {
                    const akp = a[k * n + p];
                    const akq = a[k * n + q];
                    a[k * n + p] = c * akp - s * akq;
                    a[k * n + q] = s * akp + c * akq;
                }
                for (let k = 0; k < n; k++) {
                    const apk = a[p * n + k];
                    const aqk = a[q * n + k];
                    a[p * n + k] = c * apk - s * aqk;
                    a[q * n + k] = s * apk + c * aqk;
                }
                for (let k = 0; k < n; k++) {
                    const vkp = v[k * n + p];
                    const vkq = v[k * n + q];
                    v[k * n + p] = c * vkp - s * vkq;
                    v[k * n + q] = s * vkp + c * vkq;
                }
            }
        }
    }
    const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[j * n + j] - a[i * n + i]);
    const values = order.map((i) => a[i * n + i]);
    const vectors = zeros(n, n);
    order.forEach((src, dst) => { for (let k = 0; k < n; k++) vectors.data[k * n + dst] = v[k * n + src]; });
    return { values, vectors };
};

/** Deterministic PRNG (mulberry32) so training runs are reproducible. */
export const rng = (seed = 1) => {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};
