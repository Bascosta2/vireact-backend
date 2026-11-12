import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * Thin wrappers around the bundled ffmpeg/ffprobe binaries (ffmpeg-static, ffprobe-static), so the
 * Railway image needs no system packages. Every call has a timeout and never uses a shell.
 */

const require = createRequire(import.meta.url);
const FFMPEG = process.env.FFMPEG_PATH || require('ffmpeg-static');
const FFPROBE = process.env.FFPROBE_PATH || require('ffprobe-static').path;

const run = (bin, args, { timeoutMs = 10 * 60 * 1000 } = {}) =>
    new Promise((resolve, reject) => {
        const child = spawn(bin, args, { windowsHide: true });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => {
            stdout += d;
        });
        child.stderr.on('data', (d) => {
            stderr += d;
            if (stderr.length > 4_000_000) stderr = stderr.slice(-2_000_000);
        });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`${bin.split(/[\\/]/).pop()} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(`${bin.split(/[\\/]/).pop()} exited with ${code}: ${stderr.split('\n').filter(Boolean).slice(-3).join(' | ')}`));
        });
    });

export const ffmpeg = (args, opts) => run(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...args], opts);
export const ffprobe = (args, opts) => run(FFPROBE, args, opts);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const parseRate = (r) => {
    const [a, b] = String(r || '').split('/').map(Number);
    return a && b ? Math.round((a / b) * 100) / 100 : num(r);
};

/** Duration, display size (rotation applied), fps and whether there is an audio track. */
export async function probe(filePath) {
    const { stdout } = await ffprobe(['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath], { timeoutMs: 60_000 });
    const info = JSON.parse(stdout);
    const video = (info.streams || []).find((s) => s.codec_type === 'video');
    const audio = (info.streams || []).find((s) => s.codec_type === 'audio');
    if (!video) throw new Error('No video track found in this file');
    const rotation = Math.abs(num(video.tags?.rotate) ?? num(video.side_data_list?.find((d) => d.rotation != null)?.rotation) ?? 0) % 360;
    const swap = rotation === 90 || rotation === 270;
    return {
        durationSec: num(info.format?.duration) ?? num(video.duration),
        width: swap ? video.height : video.width,
        height: swap ? video.width : video.height,
        fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate),
        rotation,
        hasAudio: Boolean(audio),
    };
}

/** silencedetect ranges in seconds. */
export function parseSilences(stderr, durationSec) {
    const out = [];
    let start = null;
    for (const line of stderr.split('\n')) {
        const s = line.match(/silence_start:\s*(-?[\d.]+)/);
        if (s) start = Math.max(0, Number(s[1]));
        const e = line.match(/silence_end:\s*([\d.]+)/);
        if (e && start != null) {
            out.push({ start, end: Number(e[1]) });
            start = null;
        }
    }
    if (start != null && durationSec) out.push({ start, end: durationSec });
    return out.map((r) => ({ start: Math.round(r.start * 1000) / 1000, end: Math.round(r.end * 1000) / 1000 }));
}

/** Scene-change timestamps from showinfo output. */
export function parseSceneCuts(stderr) {
    const out = [];
    for (const line of stderr.split('\n')) {
        if (!line.includes('Parsed_showinfo')) continue;
        const m = line.match(/pts_time:\s*([\d.]+)/);
        if (m) out.push(Math.round(Number(m[1]) * 1000) / 1000);
    }
    return out;
}

/** Integrated loudness (LUFS) from the ebur128 summary. */
export function parseLoudness(stderr) {
    const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
    const m = summary.match(/I:\s*(-?[\d.]+)\s*LUFS/);
    return m ? Number(m[1]) : null;
}
