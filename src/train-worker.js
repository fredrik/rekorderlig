/**
 * Worker-thread entry point: retrain on a private connection so the HTTP
 * thread keeps serving while the model fits and the corpus is rescored.
 * Result (or error) is posted back to the parent; see trainer.js.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from './db.js';
import { trainAndScore } from './service.js';

const conn = openDb(workerData.dbPath);
try {
  const started = Date.now();
  const result = trainAndScore(conn);
  result.ms = Date.now() - started;
  parentPort.postMessage({ ok: true, result });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message ?? String(err) });
} finally {
  conn.close();
}
