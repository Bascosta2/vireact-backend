/**
 * Runs the research agent with a run record, one run at a time per process, plus the optional
 * weekly schedule (KB_RESEARCH_AUTO=true). Scheduled runs only fill the review queue.
 */
import { KbResearchRun } from '../../model/kb-research-run.model.js';
import { runResearch, RESEARCH_TOPICS } from './research.service.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
let activeRun = null;

export const isResearchRunning = () => Boolean(activeRun);

/**
 * Start a run in the background. Returns immediately with the run id,
 * or `{ started: false }` when a run is already in progress.
 */
export const startResearchRun = async ({ topics, maxPages, trigger = 'admin' } = {}) => {
    if (activeRun) return { started: false, runId: activeRun };
    const chosen = Array.isArray(topics) && topics.length ? topics.filter((t) => RESEARCH_TOPICS.includes(t)) : [...RESEARCH_TOPICS];
    if (!chosen.length) return { started: false, error: 'no valid topics' };
    const pages = Math.min(40, Math.max(1, Number(maxPages) || 14));
    const runId = `kbr_${new Date().toISOString().slice(0, 10)}_${Math.random().toString(16).slice(2, 8)}`;
    activeRun = runId;
    try {
        await KbResearchRun.create({ runId, trigger, topics: chosen });
    } catch (error) {
        activeRun = null;
        throw error;
    }

    setImmediate(async () => {
        try {
            const result = await runResearch({ runId, topics: chosen, maxPages: pages, log: (line) => console.log(`[kb-research] ${line}`) });
            await KbResearchRun.updateOne(
                { runId },
                { status: 'done', finishedAt: new Date(), stats: result.stats, skippedSample: result.skipped.slice(0, 40) }
            );
        } catch (error) {
            console.error('[kb-research] run failed:', error.message);
            await KbResearchRun.updateOne({ runId }, { status: 'failed', finishedAt: new Date(), error: String(error.message).slice(0, 500) }).catch(() => {});
        } finally {
            activeRun = null;
        }
    });
    return { started: true, runId, topics: chosen, maxPages: pages };
};

/** Called periodically by the server. Starts a run when enabled and the last one is a week old. */
export const maybeRunScheduledResearch = async () => {
    if (String(process.env.KB_RESEARCH_AUTO || '').toLowerCase() !== 'true' || activeRun) return null;
    try {
        const last = await KbResearchRun.findOne().sort({ startedAt: -1 }).select('startedAt status').lean();
        // A run stuck in "running" (server restarted mid-run) still counts, so a crash cannot cause a retry loop.
        if (last && Date.now() - new Date(last.startedAt).getTime() < WEEK_MS) return null;
        return await startResearchRun({ trigger: 'schedule' });
    } catch (error) {
        console.error('[kb-research] schedule check failed:', error.message);
        return null;
    }
};
