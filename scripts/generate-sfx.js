/**
 * Builds the editor's built-in sound effects (synthesized with ffmpeg, so they are original and free
 * to use). They ship with the web app at public/sfx/<type>.mp3 and play whenever the sound library has
 * no uploaded effect of that type.
 *
 *   node scripts/generate-sfx.js ../vireact-frontend/public/sfx           (only the files that are missing)
 *   node scripts/generate-sfx.js ../vireact-frontend/public/sfx --force   (rebuild every file)
 *
 * Types must match SFX_TYPES in src/service/editor/edl.js; each recipe's `d` is the length the
 * composition lists in SFX_SECONDS (vireact-frontend/src/remotion/EditComposition.tsx).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { SFX_TYPES } from '../src/service/editor/edl.js';

const RATE = 44100;
const noise = '(random(0)*2-1)';

/** expression (aevalsrc, t in seconds), duration, and an ffmpeg filter chain to shape it. */
const SOUNDS = {
    // Air rushing past: noise that swells and fades, swept by a phaser.
    whoosh: { d: 0.7, expr: `0.9*${noise}*sin(PI*t/0.7)^2`, af: 'highpass=f=250,lowpass=f=4500,aphaser=type=t:speed=1.6:decay=0.6' },
    swoosh: { d: 0.35, expr: `0.9*${noise}*sin(PI*t/0.35)^3`, af: 'highpass=f=1600,lowpass=f=9000' },
    // Short tone with a fast pitch drop.
    pop: { d: 0.14, expr: '0.95*sin(2*PI*(520*t-1600*t*t))*exp(-26*t)', af: 'highpass=f=80' },
    click: { d: 0.05, expr: `0.9*${noise}*exp(-160*t)`, af: 'highpass=f=2000' },
    // Bell: a few partials with different decays.
    ding: { d: 1.4, expr: '0.5*sin(2*PI*1320*t)*exp(-3*t)+0.22*sin(2*PI*2640*t)*exp(-4.5*t)+0.12*sin(2*PI*3960*t)*exp(-7*t)+0.1*sin(2*PI*1980*t)*exp(-5*t)', af: 'aecho=0.8:0.5:60:0.25' },
    // Rising chime run.
    sparkle: {
        d: 1.0,
        expr: [[2093, 0], [2637, 0.07], [3136, 0.14], [3951, 0.21], [4186, 0.28]]
            .map(([fq, at]) => `0.22*sin(2*PI*${fq}*(t-${at}))*exp(-9*(t-${at}))*gte(t,${at})`).join('+'),
        af: 'aecho=0.8:0.6:45:0.3',
    },
    // Low thud with a gritty attack.
    boom: { d: 1.6, expr: `0.95*sin(2*PI*(68*t-22*t*t))*exp(-2.6*t)+0.45*${noise}*exp(-14*t)`, af: 'lowpass=f=900' },
    hit: { d: 0.45, expr: `0.8*sin(2*PI*(170*t-130*t*t))*exp(-9*t)+0.55*${noise}*exp(-38*t)`, af: 'lowpass=f=5000' },
    // Tension build: rising tone and noise, cut off at the top.
    riser: { d: 1.5, expr: `0.4*sin(2*PI*(180*t+330*t*t))*(t/1.5)^2+0.32*${noise}*(t/1.5)^3`, af: 'highpass=f=250,afade=t=out:st=1.44:d=0.06' },
    bass_drop: { d: 1.4, expr: '0.95*sin(2*PI*(115*t-38*t*t))*exp(-1.5*t)', af: 'asoftclip=type=tanh' },
    // Chopped, bit-crushed noise and a stuttering tone.
    glitch: { d: 0.45, expr: `0.55*${noise}*gt(sin(2*PI*27*t),0)*exp(-3*t)+0.3*sin(2*PI*880*t)*gt(sin(2*PI*13*t),0.3)`, af: 'acrusher=bits=5:mode=log:aa=0' },
    // Camera: two mechanical clicks.
    shutter: { d: 0.3, expr: `0.85*${noise}*(exp(-110*t)+0.7*exp(-110*(t-0.09))*gte(t,0.09))`, af: 'bandpass=f=3200:w=1.2' },
    // Keyboard: a run of clicks with uneven strength.
    typing: { d: 1.1, expr: `0.75*${noise}*exp(-170*mod(t,0.083))*(0.55+0.45*sin(2*PI*3.3*t))*lt(t,1.0)`, af: 'highpass=f=1400,lowpass=f=8000' },
    // Two-note chime.
    notify: { d: 0.75, expr: '0.45*sin(2*PI*988*t)*exp(-7*t)*lt(t,0.17)+0.45*sin(2*PI*1319*(t-0.15))*exp(-5*(t-0.15))*gte(t,0.15)', af: 'aecho=0.8:0.4:50:0.2' },

    // --- Movement ---
    // A quick, thin flick of air.
    swish: { d: 0.22, expr: `0.9*${noise}*sin(PI*t/0.22)^2`, af: 'highpass=f=3000,lowpass=f=11000' },
    // Air and a tone that accelerate, then stop dead.
    whip: { d: 0.3, expr: `0.8*${noise}*(t/0.3)^3*lt(t,0.27)+0.35*sin(2*PI*(400*t+3000*t*t))*(t/0.3)^2*lt(t,0.27)`, af: 'highpass=f=1200,aphaser=type=t:speed=2:decay=0.4' },
    sweep_up: { d: 0.6, expr: `0.5*sin(2*PI*(220*t+900*t*t))*sin(PI*t/0.6)+0.35*${noise}*sin(PI*t/0.6)^2`, af: 'highpass=f=200,lowpass=f=7000' },
    sweep_down: { d: 0.6, expr: `0.5*sin(2*PI*(1300*t-900*t*t))*sin(PI*t/0.6)+0.35*${noise}*sin(PI*t/0.6)^2`, af: 'highpass=f=200,lowpass=f=7000' },
    // Reversed cymbal: swells into the cut.
    reverse: { d: 1.0, expr: `0.8*${noise}*exp(5*(t-1))*lt(t,0.97)`, af: 'highpass=f=1800,lowpass=f=10000' },
    // Rocket: rumble and rushing air that build.
    launch: { d: 1.3, expr: `0.7*${noise}*(t/1.3)^2+0.4*sin(2*PI*(70*t+90*t*t))*(t/1.3)`, af: 'highpass=f=90,lowpass=f=3800,aphaser=type=t:speed=0.8:decay=0.5,afade=t=out:st=1.1:d=0.2' },

    // --- Impacts ---
    thud: { d: 0.4, expr: `0.95*sin(2*PI*(95*t-60*t*t))*exp(-12*t)+0.25*${noise}*exp(-60*t)`, af: 'lowpass=f=700' },
    // Cinematic hit: sub, a crack and a short tail.
    impact: { d: 1.3, expr: `0.9*sin(2*PI*(60*t-14*t*t))*exp(-3.2*t)+0.6*${noise}*exp(-22*t)+0.2*${noise}*exp(-4*t)`, af: 'lowpass=f=2400,aecho=0.8:0.5:90:0.3' },
    kick: { d: 0.3, expr: `0.95*sin(2*PI*(150*t-260*t*t))*exp(-13*t)+0.3*${noise}*exp(-200*t)`, af: 'lowpass=f=1500' },
    // Finger snap: two tight transients.
    snap: { d: 0.12, expr: `0.9*${noise}*(exp(-220*t)+0.8*exp(-160*(t-0.012))*gte(t,0.012))`, af: 'bandpass=f=2600:w=1.5' },
    // Hand clap: three quick bursts and a short tail.
    clap: { d: 0.3, expr: `0.8*${noise}*(exp(-300*t)+exp(-300*(t-0.011))*gte(t,0.011)+exp(-300*(t-0.023))*gte(t,0.023)+0.9*exp(-28*(t-0.034))*gte(t,0.034))`, af: 'highpass=f=500,bandpass=f=1400:w=0.9' },

    // --- Interface ---
    tick: { d: 0.07, expr: `0.7*sin(2*PI*2400*t)*exp(-90*t)+0.5*${noise}*exp(-400*t)`, af: 'highpass=f=1200' },
    tap: { d: 0.09, expr: `0.9*sin(2*PI*(420*t-900*t*t))*exp(-55*t)+0.3*${noise}*exp(-300*t)`, af: 'lowpass=f=3000' },
    blip: { d: 0.14, expr: '0.6*sin(2*PI*(880*t+2400*t*t))*exp(-16*t)+0.2*sin(4*PI*(880*t+2400*t*t))*exp(-22*t)', af: 'highpass=f=200' },
    bubble: { d: 0.2, expr: '0.9*sin(2*PI*(380*t+2600*t*t))*sin(PI*t/0.2)^2', af: 'highpass=f=150,lowpass=f=5000' },
    // Water drop: a falling plink, then a rising one.
    drip: { d: 0.35, expr: '0.85*sin(2*PI*(1500*t-5200*t*t))*exp(-22*t)*lt(t,0.12)+0.5*sin(2*PI*(700*(t-0.1)+2400*(t-0.1)*(t-0.1)))*exp(-18*(t-0.1))*gte(t,0.1)', af: 'aecho=0.8:0.4:35:0.25' },
    // Paper: a soft fluttering sweep.
    page: { d: 0.28, expr: `0.8*${noise}*sin(PI*t/0.28)^2*(0.6+0.4*sin(2*PI*38*t))`, af: 'bandpass=f=4200:w=0.8' },

    // --- Tones ---
    // Three soft rising notes.
    chime: {
        d: 1.5,
        expr: [[1047, 0], [1319, 0.12], [1568, 0.24]]
            .map(([fq, at]) => `(0.3*sin(2*PI*${fq}*(t-${at}))+0.08*sin(4*PI*${fq}*(t-${at})))*exp(-4.5*(t-${at}))*gte(t,${at})`).join('+'),
        af: 'aecho=0.8:0.6:70:0.3',
    },
    bell: { d: 2.0, expr: '0.45*sin(2*PI*523*t)*exp(-1.8*t)+0.25*sin(2*PI*1046*t)*exp(-2.6*t)+0.16*sin(2*PI*1570*t)*exp(-3.6*t)+0.1*sin(2*PI*2640*t)*exp(-6*t)+0.08*sin(2*PI*784*t)*exp(-2.2*t)', af: 'aecho=0.8:0.5:80:0.25' },
    // Airy high partials that flutter.
    shimmer: {
        d: 1.3,
        expr: [[3136, 7], [3951, 9], [4699, 11], [5274, 13], [6272, 6]]
            .map(([fq, rate]) => `0.14*sin(2*PI*${fq}*t)*(0.6+0.4*sin(2*PI*${rate}*t))*sin(PI*t/1.3)`).join('+'),
        af: 'aecho=0.8:0.7:60:0.4',
    },
    // Rising arpeggio that lands on the octave.
    success: {
        d: 1.0,
        expr: [[523, 0, 7], [659, 0.09, 7], [784, 0.18, 7], [1047, 0.27, 4]]
            .map(([fq, at, decay]) => `0.3*sin(2*PI*${fq}*(t-${at}))*exp(-${decay}*(t-${at}))*gte(t,${at})`).join('+'),
        af: 'aecho=0.8:0.5:55:0.25',
    },
    // Classic two-note coin.
    coin: { d: 0.7, expr: '0.5*(sin(2*PI*988*t)+0.3*sin(2*PI*1976*t))*lt(t,0.08)+0.5*(sin(2*PI*1319*t)+0.3*sin(2*PI*2638*t))*gte(t,0.08)*exp(-6*(t-0.08))', af: 'highpass=f=300' },
    // Cash register: a clunk, then the bell.
    cash: {
        d: 1.0,
        expr: `0.6*${noise}*exp(-70*t)+0.5*sin(2*PI*(160*t-200*t*t))*exp(-30*t)+0.3*${noise}*exp(-90*(t-0.1))*gte(t,0.1)`
            + '+(0.4*sin(2*PI*2093*(t-0.12))+0.25*sin(2*PI*3136*(t-0.12))+0.15*sin(2*PI*4186*(t-0.12)))*exp(-5*(t-0.12))*gte(t,0.12)',
        af: 'highpass=f=120,aecho=0.8:0.4:40:0.2',
    },
    // Game-style climb: five quick notes, the last one rings.
    power_up: {
        d: 0.7,
        expr: [392, 523, 659, 784].map((fq, k) => `0.4*(sin(2*PI*${fq}*t)+0.3*sin(6*PI*${fq}*t))*between(t,${(k * 0.1).toFixed(1)},${(k * 0.1 + 0.1).toFixed(1)})`).join('+')
            + '+0.4*(sin(2*PI*1047*t)+0.3*sin(6*PI*1047*t))*gte(t,0.4)*exp(-4*(t-0.4))',
        af: 'lowpass=f=5000',
    },

    // --- Tension and twists ---
    // Low drone that swells, two notes beating against each other.
    suspense: { d: 2.0, expr: `0.5*sin(2*PI*110*t)*(t/2)+0.4*sin(2*PI*116.5*t)*(t/2)+0.2*sin(2*PI*220*t+3*sin(2*PI*0.7*t))*(t/2)^2+0.1*${noise}*(t/2)^2`, af: 'lowpass=f=1800,afade=t=out:st=1.85:d=0.15' },
    // TV static burst.
    static: { d: 0.35, expr: `0.8*${noise}*(0.5+0.5*gt(sin(2*PI*50*t),0))*sin(PI*t/0.35)`, af: 'highpass=f=900,acrusher=bits=6:mode=log:aa=0' },
    // Electric zap: a wobbling falling tone and crackle.
    zap: { d: 0.3, expr: `0.6*sin(2*PI*(2400*t-3600*t*t)+6*sin(2*PI*90*t))*exp(-9*t)+0.4*${noise}*gt(sin(2*PI*60*t),0.2)*exp(-10*t)`, af: 'highpass=f=400,acrusher=bits=8:mode=log:aa=0' },
    // Wrong answer: two low buzzes, the second lower.
    error: {
        d: 0.5,
        expr: '0.5*(sin(2*PI*196*t)+0.33*sin(2*PI*588*t)+0.2*sin(2*PI*980*t))*lt(t,0.2)'
            + '+0.5*(sin(2*PI*147*t)+0.33*sin(2*PI*441*t)+0.2*sin(2*PI*735*t))*gte(t,0.24)*exp(-3*(t-0.24))',
        af: 'lowpass=f=2500',
    },
    // Two short beeps.
    alert: { d: 0.55, expr: '(0.5*sin(2*PI*1175*t)+0.2*sin(2*PI*2350*t))*exp(-9*mod(t,0.22))*lt(t,0.44)', af: 'aecho=0.8:0.3:40:0.2' },
    power_down: { d: 0.7, expr: '0.6*(sin(2*PI*(700*t-420*t*t))+0.3*sin(6*PI*(700*t-420*t*t)))*(1-t/0.7)', af: 'lowpass=f=3500' },
    // A synapse firing: soft thump with a bright flick on top.
    pulse: { d: 0.45, expr: '0.8*sin(2*PI*(110*t-40*t*t))*exp(-14*t)+0.35*sin(2*PI*(1400*t+1800*t*t))*exp(-22*t)+0.2*sin(2*PI*2800*(t-0.08))*exp(-30*(t-0.08))*gte(t,0.08)', af: 'aecho=0.8:0.5:45:0.3' },
    // Lub-dub.
    heartbeat: { d: 0.9, expr: `0.95*sin(2*PI*(110*t-90*t*t))*exp(-20*t)+0.3*${noise}*exp(-60*t)+(0.8*sin(2*PI*(125*(t-0.28)-100*(t-0.28)*(t-0.28)))*exp(-24*(t-0.28))+0.25*${noise}*exp(-70*(t-0.28)))*gte(t,0.28)`, af: 'lowpass=f=500' },
};

const args = process.argv.slice(2);
const force = args.includes('--force');
const outDir = path.resolve(args.find((a) => !a.startsWith('--')) ?? '../vireact-frontend/public/sfx');
fs.mkdirSync(outDir, { recursive: true });

const missing = SFX_TYPES.filter((t) => !SOUNDS[t]);
if (missing.length) throw new Error(`No recipe for: ${missing.join(', ')}`);

const run = (args) => {
    const r = spawnSync(ffmpegPath, ['-hide_banner', ...args], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stderr;
};
const db = (log, key) => Number((new RegExp(`${key}_volume: (-?[0-9.]+) dB`).exec(log) ?? [])[1]);

// Even loudness: raise each sound toward an average of -19 dB without its peak passing -1 dB.
const TARGET_MEAN = -19;
const PEAK_CEILING = -1;

for (const type of SFX_TYPES) {
    const { d, expr, af } = SOUNDS[type];
    const file = path.join(outDir, `${type}.mp3`);
    if (!force && fs.existsSync(file)) continue;
    const wav = path.join(outDir, `${type}.tmp.wav`);
    // Shape and fade the very edges so nothing clicks.
    run(['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=${RATE}:d=${d}`, '-af', `${af},afade=t=in:d=0.003,afade=t=out:st=${Math.max(0, d - 0.02)}:d=0.02,aformat=channel_layouts=stereo`, wav]);
    const stats = run(['-i', wav, '-af', 'volumedetect', '-f', 'null', '-']);
    const gain = Math.min(TARGET_MEAN - db(stats, 'mean'), PEAK_CEILING - db(stats, 'max'));
    run(['-loglevel', 'error', '-y', '-i', wav, '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.89:level=false`, '-c:a', 'libmp3lame', '-b:a', '160k', file]);
    fs.unlinkSync(wav);
    console.log(`${type}.mp3  ${d}s  gain ${gain.toFixed(1)} dB  ${fs.statSync(file).size} bytes`);
}
