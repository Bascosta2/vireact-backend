import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ffmpeg, probe, parseSilences, parseLoudness, parseSceneCuts } from '../src/lib/ffmpeg.js';
import { prepareMedia, sheetInterval, MediaError } from '../src/service/editor/media-prep.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vireact-editor-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** 12 s, 1080x1920: red/blue/green scenes (cuts at 4 s and 8 s); a tone that is silent 2.5-4 s of every 4 s. */
async function makeClip(file, { seconds = 12, audio = true } = {}) {
    await ffmpeg([
        '-f', 'lavfi', '-i', `color=c=red:s=1080x1920:r=30:d=4`,
        '-f', 'lavfi', '-i', `color=c=blue:s=1080x1920:r=30:d=4`,
        '-f', 'lavfi', '-i', `color=c=green:s=1080x1920:r=30:d=${seconds - 8}`,
        ...(audio ? ['-f', 'lavfi', '-i', `aevalsrc='0.5*sin(2*PI*440*t)*lt(mod(t,4),2.5)':s=44100:d=${seconds}`] : []),
        '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
        '-map', '[v]', ...(audio ? ['-map', '3:a', '-c:a', 'aac'] : []),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        file,
    ]);
}

test('prepareMedia on a real clip: probe, proxy, silences, loudness, scene cuts, sheets, thumbnail', { timeout: 120_000 }, async () => {
    const src = path.join(tmp, 'clip.mp4');
    await makeClip(src);
    const stages = [];
    const out = await prepareMedia(src, path.join(tmp, 'work'), { onStage: (s) => stages.push(s) });

    assert.equal(out.info.width, 1080);
    assert.equal(out.info.height, 1920);
    assert.ok(Math.abs(out.info.durationSec - 12) < 0.2);
    assert.equal(out.info.hasAudio, true);

    const proxy = await probe(out.proxyPath);
    assert.equal(proxy.height, 1280, 'proxy long edge is 1280');
    assert.equal(proxy.width, 720);
    assert.ok(fs.statSync(out.audioPath).size > 1000);
    const master = await probe(out.masterPath);
    assert.deepEqual([master.width, master.height, master.fps], [1080, 1920, 30], 'render master is 1080x1920 at a constant 30 fps');
    assert.equal(master.hasAudio, true);
    assert.ok(fs.statSync(out.thumbPath).size > 500);

    // Silent stretches start near 2.5, 6.5 and 10.5 s.
    const starts = out.silences.map((s) => s.start);
    for (const expected of [2.5, 6.5, 10.5]) assert.ok(starts.some((s) => Math.abs(s - expected) < 0.15), `silence near ${expected}: ${starts}`);
    assert.ok(Number.isFinite(out.loudnessLufs) && out.loudnessLufs < 0);

    for (const expected of [4, 8]) assert.ok(out.sceneCuts.some((t) => Math.abs(t - expected) < 0.2), `scene cut near ${expected}: ${out.sceneCuts}`);

    // 12 frames at 1 fps in 3x3 tiles = 2 sheets: 0-9 s and 9-12 s.
    assert.equal(out.sheets.length, 2);
    assert.deepEqual(out.sheets.map((s) => [s.from, Math.round(s.to)]), [[0, 9], [9, 12]]);
    const sheet = await probe(out.sheets[0].path).catch(() => null);
    assert.ok(sheet && sheet.width > 0);
    assert.ok(stages.includes('sampling frames'));
});

test('prepareMedia rejects clips that are too short with a user-facing error', { timeout: 60_000 }, async () => {
    const src = path.join(tmp, 'short.mp4');
    await makeClip(src, { seconds: 10, audio: false });
    // Trim to 2 s.
    const short = path.join(tmp, 'short2.mp4');
    await ffmpeg(['-i', src, '-t', '2', '-c', 'copy', short]);
    await assert.rejects(prepareMedia(short, path.join(tmp, 'work2')), (err) => err instanceof MediaError && err.userFacing);
});

test('parsers and sheet interval', () => {
    assert.deepEqual(parseSilences('[silencedetect] silence_start: 1.5\n[silencedetect] silence_end: 2.25 | silence_duration: 0.75\nsilence_start: 9', 10), [
        { start: 1.5, end: 2.25 },
        { start: 9, end: 10 },
    ]);
    assert.equal(parseLoudness('frame...\nSummary:\n  Integrated loudness:\n    I:         -16.4 LUFS\n'), -16.4);
    assert.deepEqual(parseSceneCuts('[Parsed_showinfo_1 @ 0x1] n:   0 pts:  120 pts_time:4.0 duration'), [4]);
    assert.equal(sheetInterval(60), 1);
    assert.equal(sheetInterval(180), 2);
});
