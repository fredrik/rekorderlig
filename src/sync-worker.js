/**
 * Worker-thread entry point: fetch from HN on a private connection so the HTTP
 * thread keeps serving while a sync runs. Day-by-day progress is streamed back
 * to the parent, then one final result (or error); see syncer.js.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from './db.js';
import { sync } from './service.js';

const conn = openDb(workerData.dbPath);
try {
  const started = Date.now();
  const result = await sync(conn, {
    ...workerData.options,
    onProgress: (progress) => parentPort.postMessage({ progress }),
  });
  result.ms = Date.now() - started;
  parentPort.postMessage({ ok: true, result });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message ?? String(err) });
} finally {
  conn.close();
}
