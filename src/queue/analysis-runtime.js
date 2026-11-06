/**
 * In-process bookkeeping for analysis jobs running on this server instance.
 *
 * Used by graceful shutdown (stop taking jobs, hand running ones back to the queue) and by the
 * sweeper (never touch a job this instance is still running).
 */

const running = new Map(); // videoId -> start time (ms)
let shuttingDown = false;

export const isShuttingDown = () => shuttingDown;
export const markShuttingDown = () => {
    shuttingDown = true;
};

export const trackJobStart = (videoId) => running.set(String(videoId), Date.now());
export const trackJobEnd = (videoId) => running.delete(String(videoId));
export const runningJobIds = () => [...running.keys()];

/**
 * Wait until no jobs are running or the timeout passes.
 * @returns {Promise<string[]>} ids still running when the wait ended
 */
export const waitForRunningJobs = async (timeoutMs, pollMs = 250) => {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (running.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return runningJobIds();
};

/** Test helper. */
export const resetAnalysisRuntimeForTests = () => {
    running.clear();
    shuttingDown = false;
};
