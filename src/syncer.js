/**
 * Background fetching, the same shape as trainer.js: `requestSync` returns at
 * once and the fetching runs in a worker thread on its own SQLite connection,
 * so a request never waits on a few hundred sequential HTTP calls.
 *
 * Unlike training, requests are *not* coalesced. A sync carries parameters
 * (a window, a range, a points floor), so a second request while one runs
 * cannot be folded into it — it is refused as `busy` and the caller can retry.
 * Only one run at a time either way: two would fight over the same days.
 */
import { Worker } from 'node:worker_threads';
import { dbPath } from './db.js';

const state = {
  running: false,
  startedAt: null,
  options: null,      // what the current (or last) run was asked to do
  progress: null,     // most recent { day, count, failed? }
  last: null,         // result of the most recent completed run
  lastError: null,
  runs: 0,
};

const waiters = [];

/** Start a sync unless one is running. Returns the status either way. */
export function requestSync(options = {}) {
  if (state.running) return { status: 'busy', ...syncStatus() };

  state.running = true;
  state.startedAt = Date.now();
  state.options = options;
  state.progress = null;
  const worker = new Worker(new URL('./sync-worker.js', import.meta.url), {
    workerData: { dbPath: dbPath(), options },
  });
  // The worker streams progress and reports exactly once at the end:
  // 'message' with a result normally, 'error'/'exit' only if it died first.
  let done = false;
  const finish = (msg) => {
    if (done) return;
    done = true;
    state.running = false;
    state.startedAt = null;
    state.runs++;
    if (msg.ok) {
      state.last = { ...msg.result, finishedAt: Math.floor(Date.now() / 1000) };
      state.lastError = null;
    } else {
      state.lastError = msg.error;
      console.error('sync failed:', msg.error);
    }
    while (waiters.length) waiters.shift()();
  };
  worker.on('message', (msg) => {
    if (msg.progress) state.progress = msg.progress;
    else finish(msg);
  });
  worker.once('error', (err) => finish({ ok: false, error: err.message ?? String(err) }));
  worker.once('exit', (code) => finish({ ok: false, error: `sync worker exited with code ${code}` }));

  return { status: 'started', ...syncStatus() };
}

export function syncStatus() {
  return {
    running: state.running,
    startedAt: state.startedAt,
    options: state.options,
    progress: state.progress,
    runs: state.runs,
    last: state.last,
    lastError: state.lastError,
  };
}

/** Resolve once no sync is running (tests, CLI). */
export function syncIdle() {
  if (!state.running) return Promise.resolve();
  return new Promise((resolve) => waiters.push(resolve));
}
