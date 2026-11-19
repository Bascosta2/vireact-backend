/** Worker thread entry: runs the matrix engine off the main event loop (trainer.js). */
import { parentPort, workerData } from 'node:worker_threads';
import { runEngine } from './engine.js';

try {
    parentPort.postMessage({ ok: true, result: runEngine(workerData.rows, workerData.opts) });
} catch (error) {
    parentPort.postMessage({ ok: false, error: String(error?.message ?? error) });
}
