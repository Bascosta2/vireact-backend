import { runResearchIngest, isIngestRunning, getResearchStats } from '../service/research-ingest/ingest.service.js';
import { researchConfig } from '../service/research-ingest/gates.js';
import { captureError } from '../service/ops-monitoring.service.js';

/**
 * POST /api/v1/research/run (QStash schedule, signature verified upstream).
 * Answers 202 right away and runs in the background so QStash never times out and retries
 * mid-run; the run is idempotent anyway (candidate ids are unique, batches are re-read safely).
 */
export const runResearchIngestWebhook = (req, res) => {
    if (!researchConfig().enabled) return res.status(503).json({ ok: false, error: 'research_ingest_disabled' });
    if (isIngestRunning()) return res.status(202).json({ ok: true, status: 'already_running' });
    res.status(202).json({ ok: true, status: 'started' });
    runResearchIngest({ apply: true, trigger: 'qstash', log: (line) => console.log(`[research-ingest] ${line}`) })
        .catch((error) => {
            console.error('[research-ingest] run failed:', error.message);
            try {
                captureError?.(error, { area: 'research_ingest' });
            } catch {
                /* ignore */
            }
        });
};

/** GET /api/v1/admin/research/stats (x-admin-key). Read-only. */
export const getResearchStatsAdmin = async (req, res, next) => {
    try {
        res.json({ ok: true, ...(await getResearchStats()) });
    } catch (error) {
        next(error);
    }
};
