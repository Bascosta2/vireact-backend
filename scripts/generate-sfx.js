/**
 * Builds the editor's built-in sound effects (synthesized with ffmpeg, so they are original and free
 * to use). They ship with the web app at public/sfx/<type>.mp3 and play whenever the sound library has
 * no uploaded effect of that type.
 *
 *   node scripts/generate-sfx.js ../vireact-frontend/public/sfx
 *
 * Types must match SFX_TYPES in src/service/editor/edl.js.
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
};

const outDir = path.resolve(process.argv[2] ?? '../vireact-frontend/public/sfx');
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
    const wav = path.join(outDir, `${type}.tmp.wav`);
    // Shape and fade the very edges so nothing clicks.
    run(['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc='${expr}':s=${RATE}:d=${d}`, '-af', `${af},afade=t=in:d=0.003,afade=t=out:st=${Math.max(0, d - 0.02)}:d=0.02,aformat=channel_layouts=stereo`, wav]);
    const stats = run(['-i', wav, '-af', 'volumedetect', '-f', 'null', '-']);
    const gain = Math.min(TARGET_MEAN - db(stats, 'mean'), PEAK_CEILING - db(stats, 'max'));
    run(['-loglevel', 'error', '-y', '-i', wav, '-af', `volume=${gain.toFixed(2)}dB,alimiter=limit=0.89:level=false`, '-c:a', 'libmp3lame', '-b:a', '160k', file]);
    fs.unlinkSync(wav);
    console.log(`${type}.mp3  ${d}s  gain ${gain.toFixed(1)} dB  ${fs.statSync(file).size} bytes`);
}
