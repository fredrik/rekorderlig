/**
 * Background training. `requestTrain` returns at once; the fit + rescore runs
 * in a worker thread on its own SQLite connection, and at most one runs at a
 * time. A request that arrives mid-run is coalesced into one follow-up run,
 * so votes cast while training are never lost — they just land in the next
 * revision. Any number of triggers in flight collapse into ≤ 2 runs.
 */
import { Worker } from 'node:worker_threads';
import { dbPath } from './db.js';
import { resetModelCache } from './service.js';

const state = {
  running: false,
  pending: false,
  startedAt: null,
  last: null,         // result of the most recent completed run
  lastError: null,
  runs: 0,
};

const waiters = [];

function startWorker() {
  state.running = true;
  state.pending = false;
  state.startedAt = Date.now();
  const worker = new Worker(new URL('./train-worker.js', import.meta.url), {
    workerData: { dbPath: dbPath() },
  });
  // Each worker reports exactly once: 'message' normally, 'error'/'exit' only
  // when it died without one. Without the flag a coalesced follow-up run
  // (started from inside finish) would be blamed for this worker's exit.
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
      console.error('training failed:', msg.error);
    }
    // The worker wrote a new model revision; make the main thread reload it.
    resetModelCache();
    if (state.pending) startWorker();
    else while (waiters.length) waiters.shift()();
  };
  worker.once('message', finish);
  worker.once('error', (err) => finish({ ok: false, error: err.message ?? String(err) }));
  worker.once('exit', (code) => finish({ ok: false, error: `training worker exited with code ${code}` }));
}

/** Ask for a retrain. Returns `started` if a run began now, `queued` if one is already running. */
export function requestTrain() {
  if (state.running) {
    state.pending = true;
    return { status: 'queued', ...trainStatus() };
  }
  startWorker();
  return { status: 'started', ...trainStatus() };
}

export function trainStatus() {
  return {
    running: state.running,
    pending: state.pending,
    startedAt: state.startedAt,
    runs: state.runs,
    last: state.last,
    lastError: state.lastError,
  };
}

/** Resolve once no training is running or pending (tests, CLI). */
export function trainingIdle() {
  if (!state.running && !state.pending) return Promise.resolve();
  return new Promise((resolve) => waiters.push(resolve));
}
