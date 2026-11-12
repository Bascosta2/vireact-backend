import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectTestDb, disconnectTestDb, fakeRes } from './helpers/test-db.js';
import { User } from '../src/model/user.model.js';
import { Subscription } from '../src/model/subscription.model.js';
import { EditProject, EDIT_STATUS } from '../src/model/edit-project.model.js';
import { ffmpeg } from '../src/lib/ffmpeg.js';
import { setStorageForTests } from '../src/lib/storage.js';
import { setClaudeForTests } from '../src/lib/anthropic.js';
import { setRenderClientForTests } from '../src/service/editor/render.service.js';
import { runEditJob, setEditJobPublisherForTests, sweepStuckEdits, STALE_JOB_MS } from '../src/service/editor/edit-job.service.js';
import { planEdit } from '../src/service/editor/edit-planner.service.js';
import { editorUsage } from '../src/service/editor/editor-access.service.js';
import {
    createEditProject, confirmEditUpload, getEditProject, updateEdits, regenerateEdit,
    startEditRender, getEditRender, deleteEditProject, getEditorUsage,
} from '../src/controller/editor.controller.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vireact-editor-int-'));
const objects = new Map(); // key -> local file path or Buffer
const published = [];
const deletedPrefixes = [];
let clip;

const fakeStorage = {
    presignUpload: async ({ key }) => `https://s3.test/upload/${key}`,
    presignDownload: async (key) => `https://s3.test/get/${key}`,
    head: async (key) => (objects.has(key) ? { sizeBytes: fs.statSync(objects.get(key)).size, contentType: 'video/mp4' } : null),
    downloadToFile: async (key, dest) => fs.promises.copyFile(objects.get(key), dest),
    uploadFile: async (file, key) => {
        const copy = path.join(tmp, key.replace(/[\\/]/g, '_'));
        await fs.promises.copyFile(file, copy);
        objects.set(key, copy);
        return { key, sizeBytes: fs.statSync(copy).size };
    },
    uploadBuffer: async () => ({}),
    readBuffer: async (key) => fs.promises.readFile(objects.get(key)),
    deletePrefix: async (prefix) => {
        deletedPrefixes.push(prefix);
        for (const k of [...objects.keys()]) if (k.startsWith(prefix)) objects.delete(k);
        return 0;
    },
};

// Speech in the tone parts of the generated clip (silent 2.5-4 s and 6.5-8 s).
const WORDS = [
    { w: 'Um', start: 0.3, end: 0.5 },
    { w: 'this', start: 0.8, end: 1.0 },
    { w: 'is', start: 1.05, end: 1.2 },
    { w: 'the', start: 1.25, end: 1.35 },
    { w: 'fastest', start: 1.4, end: 1.9 },
    { w: 'way', start: 4.2, end: 4.5 },
    { w: 'to', start: 4.55, end: 4.65 },
    { w: 'fix', start: 4.7, end: 5.0 },
    { w: 'it.', start: 5.05, end: 5.5 },
];

const claudeCalls = [];
const claudeStub = (params) => {
    claudeCalls.push(params);
    const text = JSON.stringify({
        summary: 'Cuts the pauses and opens on the fix.',
        hookStrategy: 'Lead with the fix so the payoff comes first.',
        segments: [
            { id: 's1', start: 4.1, end: 5.6, role: 'hook', reason: 'the payoff' },
            { id: 's2', start: 0.7, end: 2.0, role: 'body', reason: 'setup' },
            { id: 's3', start: 8.0, end: 10.0, role: 'cta', reason: 'ending' },
        ],
        acceptedCandidateIds: [],
        captions: { preset: 'bold_pop', emphasisWordIdx: [4, 7] },
        hookOverlay: { enabled: true, text: 'The 5 second fix', durationSec: 2 },
        zooms: [{ at: 4.7, duration: 0.6, scale: 1.15, focusX: 0.5, focusY: 0.4, reason: 'on the fix' }],
        textOverlays: [],
        framing: { mode: 'fill', focusX: 0.5 },
        music: { trackId: '', volume: 0.1, reason: 'speech-led' },
        sfx: [{ type: 'whoosh', at: 0.8 }],
        changes: [{ kind: 'reorder', label: 'Opened on the fix', why: 'The viewer sees the result first.', evidence: 'footage' }],
        expectedEffect: 'The viewer hears the fix in the first second.',
    });
    return { id: 'msg_test', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 50 } };
};

const testPlan = (args) => planEdit(args, {
    retrieve: async () => [],
    selectExemplars: async () => ({ exemplars: [], benchmarks: null }),
    loadTracks: async () => [],
});
const jobDeps = { transcribe: async () => ({ words: WORDS, language: 'en' }), plan: testPlan };

const call = async (handler, req) => {
    const res = fakeRes();
    let error = null;
    await handler({ params: {}, body: {}, query: {}, ...req }, res, (err) => { error = err; });
    return { res, error, data: res.body?.data ?? res.jsonBody?.data ?? res._json?.data };
};

const newUser = async (suffix, plan) => {
    const user = await User.create({ name: 'Ed', email: `editor-${suffix}-${Date.now()}@example.invalid`, password: 'pw-123456', isEmailVerified: true });
    const start = new Date(Date.now() - 2 * 86_400_000);
    await Subscription.create({ userId: user._id, plan, currentPeriodStart: start, currentPeriodEnd: new Date(start.getTime() + 30 * 86_400_000) });
    return user;
};

/** Create + "upload" + confirm a project, returning it queued. */
const queuedProject = async (user) => {
    const created = await call(createEditProject, { user, body: { fileName: 'take1.mp4', contentType: 'video/mp4', sizeBytes: fs.statSync(clip).size } });
    assert.equal(created.error, null, created.error?.message);
    const id = created.data.project.id;
    const doc = await EditProject.findById(id).lean();
    objects.set(doc.source.key, clip);
    const confirmed = await call(confirmEditUpload, { user, params: { id } });
    assert.equal(confirmed.error, null, confirmed.error?.message);
    return id;
};

const saved = {};
before(async () => {
    for (const k of ['AWS_S3_BUCKET_NAME', 'AWS_S3_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'ANTHROPIC_API_KEY', 'REMOTION_FUNCTION_NAME', 'REMOTION_SERVE_URL', 'REMOTION_REGION']) {
        saved[k] = process.env[k];
        process.env[k] = `test-${k.toLowerCase()}`;
    }
    await connectTestDb();
    await EditProject.createIndexes();
    setStorageForTests(fakeStorage);
    setClaudeForTests(claudeStub);
    setEditJobPublisherForTests(async (job) => { published.push(job); return 'msg'; });
    clip = path.join(tmp, 'clip.mp4');
    await ffmpeg([
        '-f', 'lavfi', '-i', 'color=c=red:s=720x1280:r=30:d=6',
        '-f', 'lavfi', '-i', 'color=c=blue:s=720x1280:r=30:d=6',
        '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*440*t)*lt(mod(t,4),2.5)':s=44100:d=12",
        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip,
    ]);
});
after(async () => {
    setStorageForTests(null);
    setClaudeForTests(null);
    setEditJobPublisherForTests(null);
    setRenderClientForTests(null);
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    await disconnectTestDb();
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('free user: one AI edit per month end to end (upload, prepare, Claude plan, ready, charged), then locked until next month', { timeout: 120_000 }, async () => {
    const user = await newUser('free', 'free');
    const usage0 = await editorUsage(user._id);
    assert.equal(usage0.limit, 1);
    assert.equal(usage0.remaining, 1);
    assert.equal(usage0.canStart, true);
    assert.equal(usage0.locked, false);

    const id = await queuedProject(user);
    assert.equal(published.at(-1).projectId, id);

    // Second project while the first is in flight: 409.
    const busy = await call(createEditProject, { user, body: { fileName: 'b.mp4', contentType: 'video/mp4', sizeBytes: 1000 } });
    assert.equal(busy.error?.statusCode, 409);

    const result = await runEditJob(id, jobDeps);
    assert.equal(result.ok, true, result.error);
    const doc = await EditProject.findById(id).lean();
    assert.equal(doc.status, EDIT_STATUS.READY);
    assert.equal(doc.inFlight, false);
    assert.equal(doc.billing.kind, 'plan');
    assert.ok(doc.media.frameSheets.length >= 1);
    assert.ok(doc.source.proxyKey && objects.has(doc.source.proxyKey));
    assert.ok(Math.abs(doc.source.durationSec - 12) < 0.3);
    assert.ok(doc.media.cutCandidates.some((c) => c.kind === 'filler'));

    // Claude got the transcript, cut candidates and every frame sheet as an image; system prompt is cached.
    const params = claudeCalls.at(-1);
    assert.equal(params.model, 'claude-opus-5-5');
    assert.equal(params.fallbacks, 'default');
    assert.deepEqual(params.thinking, { type: 'adaptive' });
    assert.equal(params.system[0].cache_control.type, 'ephemeral');
    const blocks = params.messages[0].content;
    assert.equal(blocks.filter((b) => b.type === 'image').length, doc.media.frameSheets.length);
    assert.match(blocks[0].text, /\[4\] 1\.40-1\.90 fastest/);
    assert.match(blocks[0].text, /CUT CANDIDATES/);

    const usage1 = await editorUsage(user._id);
    assert.equal(usage1.remaining, 0);
    assert.equal(usage1.locked, true);
    const now = new Date();
    assert.equal(new Date(usage1.resetsOn).getTime(), Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const locked = await call(createEditProject, { user, body: { fileName: 'c.mp4', contentType: 'video/mp4', sizeBytes: 1000 } });
    assert.equal(locked.error?.statusCode, 403);
    assert.equal(locked.error?.data?.code, 'UPGRADE_REQUIRED');
    // Next month the free edit is back.
    const nextMonth = await editorUsage(user._id, { now: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2)) });
    assert.equal(nextMonth.remaining, 1);
    assert.equal(nextMonth.canStart, true);

    // Detail: preview props are ready; another user can't see it.
    const detail = await call(getEditProject, { user, params: { id } });
    assert.equal(detail.error, null);
    assert.equal(detail.data.props.timeline[0].segId, 's1', 'hook plays first');
    assert.ok(detail.data.proxyUrl.includes(doc.source.proxyKey));
    assert.equal(detail.data.regenerationsLeft, 2);
    const stranger = await newUser('stranger', 'premium');
    const hidden = await call(getEditProject, { user: stranger, params: { id } });
    assert.equal(hidden.error?.statusCode, 404);

    // Review changes are sanitized; removing every segment is refused.
    const upd = await call(updateEdits, { user, params: { id }, body: { captionPreset: 'clean', hookOverlayOff: true, junk: 1 } });
    assert.equal(upd.error, null, upd.error?.message);
    assert.equal(upd.data.props.captions.preset, 'clean');
    assert.equal(upd.data.props.hook, null);
    const none = await call(updateEdits, { user, params: { id }, body: { disabledSegments: ['s1', 's2', 's3'] } });
    assert.equal(none.error?.statusCode, 400);

    // Regenerate: replans on prepared media, no extra charge, counted as a revision.
    const before2 = claudeCalls.length;
    const regen = await call(regenerateEdit, { user, params: { id }, body: { note: 'Keep the original order' } });
    assert.equal(regen.error, null, regen.error?.message);
    const replanned = await runEditJob(id, jobDeps);
    assert.equal(replanned.replanned, true);
    assert.equal(claudeCalls.length, before2 + 1);
    const lastMsgs = claudeCalls.at(-1).messages;
    assert.equal(lastMsgs.at(-1).role, 'user');
    assert.match(lastMsgs.at(-1).content, /Keep the original order/);
    const afterRegen = await EditProject.findById(id).lean();
    assert.equal(afterRegen.status, EDIT_STATUS.READY);
    assert.equal(afterRegen.revisions.length, 1);
    assert.deepEqual(afterRegen.edits, {}, 'review changes reset with the new plan');
    assert.equal(afterRegen.billing.kind, 'plan', 'not charged again');
    assert.equal((await editorUsage(user._id)).used, 1, 'a redo does not use another edit');
});

test('edits charged under the old lifetime free edit still count toward this month', async () => {
    const user = await newUser('legacy', 'free');
    await EditProject.collection.insertOne({
        userId: user._id,
        title: 'old',
        status: EDIT_STATUS.READY,
        inFlight: false,
        billing: { kind: 'trial', countedAt: new Date() },
        createdAt: new Date(),
    });
    const usage = await editorUsage(user._id);
    assert.equal(usage.used, 1);
    assert.equal(usage.canStart, false);
});

test('premium: a failed plan frees the slot and is not charged; usage counts only ready edits', { timeout: 120_000 }, async () => {
    const user = await newUser('premium', 'premium');
    const id = await queuedProject(user);
    const failing = { ...jobDeps, plan: async () => { throw new Error('model unavailable'); } };
    const result = await runEditJob(id, failing);
    assert.equal(result.ok, false);
    const doc = await EditProject.findById(id).lean();
    assert.equal(doc.status, EDIT_STATUS.FAILED);
    assert.equal(doc.inFlight, false);
    assert.equal(doc.billing.countedAt, null);
    assert.match(doc.error, /did not use up an edit/);
    const usage = await editorUsage(user._id);
    assert.equal(usage.used, 0);

    // The slot is free again, and a successful run is charged against the plan.
    const id2 = await queuedProject(user);
    assert.equal((await runEditJob(id2, jobDeps)).ok, true);
    assert.equal((await EditProject.findById(id2).lean()).billing.kind, 'plan');
    assert.equal((await editorUsage(user._id)).used, 1);
    const u = await call(getEditorUsage, { user });
    assert.equal(u.data.remaining, u.data.limit - 1);
});

test('sweeper re-queues a project whose worker died and fails it after 3 attempts', async () => {
    const user = await newUser('sweep', 'pro');
    const old = new Date(Date.now() - STALE_JOB_MS - 60_000);
    const p = await EditProject.create({ userId: user._id, status: EDIT_STATUS.PLANNING, heartbeatAt: old, attempts: 1, source: { key: 'k' } });
    const jobs = [];
    const r1 = await sweepStuckEdits({ publish: async (j) => jobs.push(j) });
    assert.equal(r1.requeued, 1);
    assert.equal((await EditProject.findById(p._id).lean()).status, EDIT_STATUS.QUEUED);
    assert.equal(jobs[0].projectId, String(p._id));

    await EditProject.updateOne({ _id: p._id }, { $set: { status: EDIT_STATUS.PREPROCESSING, heartbeatAt: old, attempts: 3 } });
    await sweepStuckEdits({ publish: async () => {} });
    const dead = await EditProject.findById(p._id).lean();
    assert.equal(dead.status, EDIT_STATUS.FAILED);
    assert.equal(dead.inFlight, false);
});

test('export renders on Lambda, reports progress and returns a download link; delete removes files', { timeout: 120_000 }, async () => {
    const user = await newUser('render', 'pro');
    const id = await queuedProject(user);
    assert.equal((await runEditJob(id, jobDeps)).ok, true);

    let polls = 0;
    const renderCalls = [];
    setRenderClientForTests({
        renderMediaOnLambda: async (args) => { renderCalls.push(args); return { renderId: 'r-1', bucketName: 'bucket' }; },
        getRenderProgress: async () => { polls += 1; return polls < 2 ? { done: false, overallProgress: 0.4 } : { done: true, overallProgress: 1, outputSizeInBytes: 1234 }; },
    });
    const started = await call(startEditRender, { user, params: { id } });
    assert.equal(started.error, null, started.error?.message);
    const { renderId } = started.data;
    assert.equal(renderCalls[0].composition, 'VireactEdit');
    assert.ok(renderCalls[0].inputProps.videoUrl.endsWith('/master.mp4'), 'renders from the normalized render master');
    assert.ok(renderCalls[0].outName.key.includes(`/renders/`));

    const p1 = await call(getEditRender, { user, params: { id, renderId } });
    assert.equal(p1.data.status, 'rendering');
    assert.equal(p1.data.progress, 40);
    const p2 = await call(getEditRender, { user, params: { id, renderId } });
    assert.equal(p2.data.status, 'done');
    assert.ok(p2.data.downloadUrl.includes(`${renderId}.mp4`));

    const del = await call(deleteEditProject, { user, params: { id } });
    assert.equal(del.error, null);
    const gone = await EditProject.findById(id).lean();
    assert.equal(gone.status, EDIT_STATUS.DELETED);
    assert.equal(gone.plan, null);
    assert.ok(gone.billing.countedAt, 'billing history kept so deleting does not refund an edit');
    assert.ok(deletedPrefixes.some((p) => p.includes(`/sources/${user._id}/${id}/`)));
    assert.equal((await call(getEditProject, { user, params: { id } })).error?.statusCode, 404);
});
