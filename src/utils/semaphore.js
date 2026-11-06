/**
 * Tiny counting semaphore: at most `limit` tasks run at once, the rest wait in order.
 * Used to cap simultaneous uploads to Twelve Labs (each holds a copy of the file in memory inside
 * the SDK), so a burst of large uploads queues instead of exhausting server memory.
 */
export const createSemaphore = (limit) => {
    const max = Math.max(1, Math.floor(Number(limit)) || 1);
    let active = 0;
    const waiting = [];

    const release = () => {
        active--;
        const next = waiting.shift();
        if (next) next();
    };

    return {
        /** Run `task` when a slot is free. */
        run: async (task) => {
            if (active >= max) await new Promise((resolve) => waiting.push(resolve));
            active++;
            try {
                return await task();
            } finally {
                release();
            }
        },
        stats: () => ({ active, waiting: waiting.length, limit: max }),
    };
};
