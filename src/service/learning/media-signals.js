/**
 * Signals measured from a video file without AI (docs/learning-engine/PLAN.md, section 15.1). Pure functions;
 * the ffmpeg passes that produce their input live in deep-analyzer.js measureVideo.
 *
 *   per-frame metadata  scene-change score, brightness (YAVG), saturation (SATAVG), motion (YDIF)
 *   cuts                adaptive: a hard threshold, plus soft cuts that stand far above the local baseline
 *   audio envelope      RMS level every ~46 ms -> onsets (beats / hits), tempo, and whether cuts land on them
 *   language            stopwords + script detection, for captions and transcripts
 */

const round = (x, places = 3) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** places) / 10 ** places);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
    const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
    if (!s.length) return null;
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const std = (xs) => {
    const m = mean(xs);
    return m == null ? null : Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

// ---- ffmpeg `metadata=mode=print` output

/** Parses ffmpeg metadata print blocks into [{ t, ...values }] (keys without their lavfi prefix). */
export const parseMetadataPrint = (text) => {
    const out = [];
    let cur = null;
    for (const line of String(text ?? '').split('\n')) {
        const head = line.match(/pts_time:\s*(-?[\d.]+)/);
        if (head) {
            cur = { t: Number(head[1]) };
            out.push(cur);
            continue;
        }
        const kv = line.match(/^lavfi\.([\w.]+)=(.*)$/);
        if (kv && cur) {
            const key = kv[1].replace(/^(signalstats|astats\.Overall)\./, '').replace(/^scene_score$/, 'scene');
            const v = kv[2].trim() === '-inf' ? -Infinity : Number(kv[2]);
            cur[key] = Number.isNaN(v) ? null : v;
        }
    }
    return out.filter((f) => Number.isFinite(f.t)).sort((a, b) => a.t - b.t);
};

// ---- cuts

export const CUT_DEFAULTS = Object.freeze({ hard: 0.3, soft: 0.08, ratio: 6, window: 15, floor: 0.004, minGap: 0.2 });

/**
 * Cut times from per-frame scene scores. A frame is a cut when its score is at least `hard`, or when it is
 * at least `soft`, the local peak (±2 frames) and `ratio` times the local typical score (median of ±window
 * frames). The second rule finds soft cuts between similar shots that a single threshold misses, without
 * firing on sustained motion (where the local typical score is high too).
 */
export const detectCuts = (frames = [], opts = {}) => {
    const o = { ...CUT_DEFAULTS, ...opts };
    const f = frames.filter((x) => Number.isFinite(x?.t) && Number.isFinite(x?.scene));
    const s = f.map((x) => x.scene);
    const cuts = [];
    for (let i = 1; i < f.length; i++) {
        const v = s[i];
        if (v < Math.min(o.soft, o.hard)) continue;
        let isCut = v >= o.hard;
        if (!isCut && v >= o.soft) {
            const lo = Math.max(0, i - o.window);
            const hi = Math.min(f.length - 1, i + o.window);
            let peak = true;
            for (let k = Math.max(0, i - 2); k <= Math.min(f.length - 1, i + 2); k++) if (k !== i && s[k] > v) peak = false;
            const local = [];
            for (let k = lo; k <= hi; k++) if (Math.abs(k - i) > 2) local.push(s[k]);
            const typical = Math.max(o.floor, median(local) ?? 0);
            isCut = peak && v >= o.ratio * typical;
        }
        if (!isCut) continue;
        const t = f[i].t;
        if (cuts.length && t - cuts.at(-1).t < o.minGap) {
            if (v > cuts.at(-1).score) cuts[cuts.length - 1] = { t, score: v };
            continue;
        }
        cuts.push({ t, score: v });
    }
    return cuts.map((c) => round(c.t));
};

// ---- picture

/** Brightness, colour and motion over the video and in its first 3 seconds (0-255 scales from signalstats). */
export const frameStats = (frames = []) => {
    const f = frames.filter((x) => Number.isFinite(x?.t) && Number.isFinite(x?.YAVG));
    if (!f.length) return {};
    const hook = f.filter((x) => x.t < 3);
    const rest = f.filter((x) => x.t >= 3);
    const avg = (rows, k) => mean(rows.map((x) => x[k]).filter(Number.isFinite));
    const motionAll = avg(f, 'YDIF');
    const motionHook = hook.length ? avg(hook, 'YDIF') : null;
    const motionRest = rest.length ? avg(rest, 'YDIF') : null;
    return {
        brightness: round(avg(f, 'YAVG'), 1),
        brightnessFirst3s: hook.length ? round(avg(hook, 'YAVG'), 1) : null,
        saturation: round(avg(f, 'SATAVG'), 1),
        motion: round(motionAll, 2),
        motionFirst3s: round(motionHook, 2),
        motionHookRatio: motionHook != null && motionRest > 0.05 ? round(motionHook / motionRest, 2) : null,
        motionVariability: round(std(f.map((x) => x.YDIF).filter(Number.isFinite)), 2),
    };
};

// ---- audio

/** RMS level envelope [{ t, db }] from astats metadata (silence -> -100 dB). */
export const envelopeFrom = (frames = []) => frames
    .filter((x) => Number.isFinite(x?.t) && x.RMS_level != null)
    .map((x) => ({ t: x.t, db: Number.isFinite(x.RMS_level) ? Math.max(-100, x.RMS_level) : -100 }));

/**
 * Onsets: sudden rises in loudness (drum hits, beats, word starts). Spectral-flux style novelty on the RMS
 * envelope, adaptive threshold, local peaks, at least `minGap` seconds apart.
 */
export const detectOnsets = (env = [], { minGap = 0.1, minRiseDb = 6 } = {}) => {
    if (env.length < 5) return [];
    // Threshold over the whole novelty curve (quiet windows included), so clean, equal beats all pass.
    const nov = env.map((e, i) => (i ? Math.max(0, e.db - env[i - 1].db) : 0));
    const thr = Math.max(minRiseDb, (mean(nov) ?? 0) + 1.5 * (std(nov) ?? 0));
    const out = [];
    for (let i = 1; i < env.length; i++) {
        if (nov[i] < thr) continue;
        if (nov[i] < (nov[i - 1] ?? 0) || nov[i] < (nov[i + 1] ?? 0)) continue;
        if (env[i].db < -60) continue;
        const t = env[i - 1].t; // the rise starts in the previous window
        if (out.length && t - out.at(-1) < minGap) continue;
        out.push(round(t));
    }
    return out;
};

/** Tempo in BPM from the onset times (autocorrelation of an onset train, 60-200 BPM), or null. */
export const estimateTempo = (onsets = [], durationSec = null, { step = 0.01 } = {}) => {
    const d = Number(durationSec) > 0 ? Number(durationSec) : (onsets.at(-1) ?? 0) + 0.5;
    if (onsets.length < 8 || d <= 0) return null;
    const n = Math.ceil(d / step) + 1;
    const train = new Float64Array(n);
    // Each onset is a small triangle (±30 ms) so slightly uneven hits still line up.
    for (const t of onsets) {
        const c = Math.round(t / step);
        for (let k = -3; k <= 3; k++) if (c + k >= 0 && c + k < n) train[c + k] += 1 - Math.abs(k) / 4;
    }
    let best = null;
    let bestScore = 0;
    for (let lag = Math.round(0.3 / step); lag <= Math.round(1.0 / step); lag++) {
        let sum = 0;
        for (let i = 0; i + lag < n; i++) sum += train[i] * train[i + lag];
        const score = sum / (n - lag);
        if (score > bestScore * 1.0001) { bestScore = score; best = lag; }
    }
    return best ? round(60 / (best * step), 1) : null;
};

/**
 * Do cuts land on onsets? share = cuts within ±tol of an onset; chance = the share expected if cuts were
 * placed at random given how dense the onsets are; lift = share / chance (1 = no relation, 2 = twice chance).
 */
export const beatAlignment = (cuts = [], onsets = [], durationSec = null, { tol = 0.07 } = {}) => {
    const d = Number(durationSec);
    if (cuts.length < 3 || onsets.length < 8 || !(d > 0)) return {};
    const near = (t) => onsets.some((o) => Math.abs(o - t) <= tol);
    const share = cuts.filter(near).length / cuts.length;
    const chance = Math.min(1, (onsets.length / d) * 2 * tol);
    return { cutsOnBeatShare: round(share, 2), cutsOnBeatLift: chance > 0 ? round(share / chance, 2) : null };
};

/** All audio-envelope features at once. */
export const audioRhythm = (env = [], cuts = [], durationSec = null) => {
    const onsets = detectOnsets(env);
    const d = Number(durationSec) > 0 ? Number(durationSec) : env.at(-1)?.t ?? null;
    return {
        onsetRate: d > 0 ? round(onsets.length / d, 2) : null,
        tempoBpm: estimateTempo(onsets, d),
        ...beatAlignment(cuts, onsets, d),
    };
};

// ---- language

const STOP = {
    en: 'the and you that this for with your are was have what just not but it is to of in my me so on be at all do if',
    es: 'el la de que y en los las por con para una un es lo su como pero mi te se del al me ya más muy',
    pt: 'o a de que e do da em um uma para com não os as no na se por mais você é meu isso',
    de: 'der die das und ist nicht ich du mit auf für ein eine zu den dem es sie wir auch was wie bei',
    fr: 'le la les et de des un une est pas je tu que qui pour avec dans sur ce mon il elle vous',
    it: 'il lo la gli le e di che non un una per con sono mi ti si del della questo come più ma',
};
const STOP_SETS = Object.fromEntries(Object.entries(STOP).map(([k, v]) => [k, new Set(v.split(' '))]));
const SCRIPTS = [
    ['ko', /[가-힯]/g], ['ja', /[぀-ヿ]/g], ['zh', /[一-鿿]/g], ['ru', /[Ѐ-ӿ]/g],
    ['ar', /[؀-ۿ]/g], ['th', /[฀-๿]/g], ['hi', /[ऀ-ॿ]/g],
];

/**
 * Best-guess language code of a caption or transcript, or null when there is too little text to tell.
 * Hashtags, mentions and links are ignored.
 */
export const detectLanguage = (text) => {
    const clean = String(text ?? '').replace(/https?:\/\/\S+|[#@][\p{L}\p{N}_]+/gu, ' ');
    for (const [code, re] of SCRIPTS) {
        const hits = clean.match(re)?.length ?? 0;
        if (hits >= 4) return code;
    }
    const tokens = clean.toLowerCase().match(/\p{L}+/gu) ?? [];
    if (tokens.length < 4) return null;
    const scores = Object.entries(STOP_SETS)
        .map(([code, set]) => [code, tokens.filter((t) => set.has(t)).length / tokens.length])
        .sort((a, b) => b[1] - a[1]);
    const [[code, top], [, second]] = scores;
    return top >= 0.08 && top >= 1.5 * second ? code : null;
};
