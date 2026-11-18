import { runDailyLearning, isLearningRunning, learningConfig } from '../service/learning/learning.service.js';
import { captureError } from '../service/ops-monitoring.service.js';

/**
 * POST /api/v1/learning/run (QStash schedule, signature verified upstream; LEARNING_ENABLED gates it).
 * Answers 202 at once and runs in the background, so QStash never times out and retries mid-run.
 */
export const runLearningWebhook = (req, res) => {
    if (!learningConfig().enabled) return res.status(503).json({ ok: false, error: 'learning_disabled' });
    if (isLearningRunning()) return res.status(202).json({ ok: true, status: 'already_running' });
    res.status(202).json({ ok: true, status: 'started' });
    runDailyLearning().catch((error) => {
        console.error('[learning] run failed:', error.message);
        try {
            captureError?.(error, { area: 'learning' });
        } catch {
            /* ignore */
        }
    });
};
