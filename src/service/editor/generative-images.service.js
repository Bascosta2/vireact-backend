/**
 * Step 3 of the story-first pipeline: per-subject image generation.
 *
 * Takes a confirmed storyboard whose `subjects[]` registry is populated, and for each unique subject
 * generates one image in the style's aesthetic through a generative image provider (Flux via
 * Replicate by default). Each image is cached by (styleId, subject.name, subject.description,
 * providerId) so identical subjects across projects reuse bytes, and so a re-render after the
 * creator switched styles only re-generates images for the subjects whose inputs changed.
 *
 * Shipped dark: EDITOR_GENIMG_ENABLED must be "true" AND the provider token must be set AND the
 * user's plan must grant quota before any provider call runs. When any of these fail, this service
 * is a no-op; the storyboard still renders normally through the Remotion fallback.
 *
 * The orchestrator never throws into the caller: every failure is recorded on the subject's
 * `assetError` field and the caller moves on.
 */

import crypto from 'node:crypto';
import { EditProject } from '../../model/edit-project.model.js';
import { editorKey, isStorageConfigured, storage } from '../../lib/storage.js';
import { skillFor } from './skills.js';
import {
    DEFAULT_SIZE,
    PLAN_QUOTAS,
    buildImagePrompt,
    dailyBudgetUsd,
    estimatedCostForProvider,
    getImageProvider,
    imageGenEnabled,
    subjectIsSafe,
} from './providers/image-provider.js';

/** Unique id for a generated image: changes when the subject, style, or provider version changes. */
export function subjectAssetSig({ styleId, subject, providerId }) {
    const material = `${providerId}\u0000${styleId}\u0000${String(subject?.name ?? '').toLowerCase().trim()}\u0000${String(subject?.description ?? '').toLowerCase().trim()}`;
    return crypto.createHash('sha1').update(material).digest('hex').slice(0, 16);
}

/**
 * Deterministic seed derived from the asset signature so re-generating the same subject in the same
 * style yields a byte-identical image (within the provider's determinism guarantees).
 */
export function seedForSig(sig) {
    return parseInt(sig.slice(0, 8), 16) % 2_147_483_647;
}

/** Per-plan quota surface (plan tier → monthly image budget). */
export const quotaForPlan = (plan) => PLAN_QUOTAS[String(plan ?? '').toLowerCase()] ?? 0;

/** Count generative-image usages this month for a user (reads EditProject storyboard meta). */
export async function monthlyImageUsage(userId, now = new Date()) {
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const docs = await EditProject.find(
        { userId, 'storyboard.subjectImagesMonth': month },
        { 'storyboard.subjectImagesCount': 1 },
    ).lean();
    return docs.reduce((sum, d) => sum + Number(d?.storyboard?.subjectImagesCount ?? 0), 0);
}

/** Sum estimated USD spend today across projects that recorded subject-image spend. */
export async function dailyImageSpendUsd(now = new Date()) {
    const day = now.toISOString().slice(0, 10);
    const docs = await EditProject.find(
        { 'storyboard.subjectImagesDay': day },
        { 'storyboard.subjectImagesSpendUsd': 1 },
    ).lean();
    return docs.reduce((sum, d) => sum + Number(d?.storyboard?.subjectImagesSpendUsd ?? 0), 0);
}

/**
 * Called by chooseStoryboard after the storyboard is confirmed. Marks the project pending and kicks
 * off generation in the background (or inline for tests). Returns an object describing what was
 * scheduled; never throws.
 */
export async function scheduleSubjectImages({ project, userPlan = 'free', inline = false, deps = {} } = {}) {
    if (!imageGenEnabled()) return { scheduled: false, reason: 'disabled' };
    const provider = deps.provider ?? getImageProvider();
    if (!provider) return { scheduled: false, reason: 'no_provider' };
    if (!isStorageConfigured() && !deps.storage) return { scheduled: false, reason: 'no_storage' };
    const quota = quotaForPlan(userPlan);
    if (quota <= 0) return { scheduled: false, reason: 'no_quota' };
    const used = await monthlyImageUsage(project.userId);
    if (quota - used <= 0) return { scheduled: false, reason: 'quota_exhausted' };

    const spend = await dailyImageSpendUsd();
    if (spend >= dailyBudgetUsd()) return { scheduled: false, reason: 'budget_exhausted' };

    if (inline) return runSubjectImages({ projectId: project._id, deps });

    await EditProject.updateOne(
        { _id: project._id },
        { $set: { 'storyboard.subjectImagesPending': true, 'storyboard.subjectImagesRequestedAt': new Date() } },
    );

    // Fire-and-forget in-process. QStash can take over later; for the dark ship this is enough so
    // pending subjects actually get images without a new webhook route.
    setImmediate(() => {
        runSubjectImages({ projectId: project._id, deps }).catch((err) => {
            console.error(`[Editor] subject images failed for ${project._id}:`, err?.message ?? err);
        });
    });
    return { scheduled: true, reason: 'queued' };
}

/**
 * Run the generation now, in-process. Called inline from scheduleSubjectImages (tests) or from the
 * background kick. Iterates every unique subject in the storyboard, calls the provider, uploads the
 * bytes to S3, and writes the key back to the subject entry via Mongo markModified (because
 * `storyboard` is a Mixed type on the EditProject schema).
 */
export async function runSubjectImages({ projectId, deps = {} }) {
    const provider = deps.provider ?? getImageProvider();
    const store = deps.storage ?? storage;
    if (!provider) return { ran: false, reason: 'no_provider' };
    const project = await EditProject.findById(projectId);
    if (!project) return { ran: false, reason: 'no_project' };
    const subjects = project.storyboard?.subjects ?? project.storyboard?.final?.subjects ?? [];
    if (!subjects.length) return { ran: false, reason: 'no_subjects' };
    const style = skillFor(project.skill);
    const styleId = project.skill ?? '';
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const day = now.toISOString().slice(0, 10);
    const unitCost = estimatedCostForProvider(provider.id);

    let generated = 0;
    let spendUsd = 0;
    const updated = subjects.map((sb) => ({ ...sb }));
    for (let k = 0; k < updated.length; k += 1) {
        const subject = updated[k];
        if (subject?.assetKey) continue;
        if (!subjectIsSafe(subject)) {
            updated[k] = { ...subject, assetError: 'subject_text_not_safe' };
            continue;
        }
        // Re-check budget between subjects so a long storyboard cannot blow past the daily cap.
        const liveSpend = await dailyImageSpendUsd(now);
        if (liveSpend + spendUsd + unitCost > dailyBudgetUsd()) {
            updated[k] = { ...subject, assetError: 'budget_exhausted' };
            continue;
        }
        const sig = subjectAssetSig({ styleId, subject, providerId: provider.id });
        const key = editorKey('subjects', String(project.userId), String(project._id), `${sig}.png`);
        try {
            const bytes = await provider.generate({
                prompt: buildImagePrompt(subject, style),
                seed: seedForSig(sig),
                width: DEFAULT_SIZE,
                height: DEFAULT_SIZE,
            });
            await store.uploadBuffer(bytes, key, 'image/png');
            updated[k] = { ...subject, assetKey: key, assetProvider: provider.id, assetSig: sig, assetReady: true, assetError: '' };
            generated += 1;
            spendUsd += unitCost;
        } catch (err) {
            updated[k] = { ...subject, assetError: String(err?.message ?? err).slice(0, 240) };
        }
    }

    project.storyboard = {
        ...(project.storyboard ?? {}),
        subjects: updated,
        subjectImagesMonth: month,
        subjectImagesDay: day,
        subjectImagesCount: Number(project.storyboard?.subjectImagesCount ?? 0) + generated,
        subjectImagesSpendUsd: Number(project.storyboard?.subjectImagesSpendUsd ?? 0) + spendUsd,
        subjectImagesPending: false,
        subjectImagesFinishedAt: new Date(),
    };
    project.markModified('storyboard');
    await project.save();
    return { ran: true, generated, total: updated.length, spendUsd };
}

/** Surfaces the per-subject asset state for the project detail view. */
export function subjectsForDetail(storyboard) {
    const subjects = storyboard?.subjects ?? storyboard?.final?.subjects ?? [];
    return subjects.map((sb) => ({
        name: sb?.name ?? '',
        description: sb?.description ?? '',
        role: sb?.role ?? '',
        visualId: sb?.visualId ?? '',
        assetReady: Boolean(sb?.assetReady),
        assetError: sb?.assetError ?? '',
    }));
}
