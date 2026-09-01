//! Background fetching, the same shape as trainer.rs: `request` returns at
//! once and the fetching runs on its own thread with its own database connection,
//! so a request never waits on a few hundred sequential HTTP calls.
//!
//! Unlike training, requests are *not* coalesced. A sync carries parameters
//! (a window, a range, a points floor), so a second request while one runs
//! cannot be folded into it — it is refused as `busy` and the caller can retry.
//! Only one run at a time either way: two would fight over the same days.

use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Condvar, Mutex};

use serde_json::{json, Value};

use crate::dates::{now_millis, now_seconds};
use crate::db::open_db;
use crate::hn::Algolia;
use crate::http_client::HttpFetcher;
use crate::service::{sync, ModelCache, SyncRequest};
use crate::trainer::panic_message;

#[derive(Default)]
struct SyncState {
    running: bool,
    started_at: Option<i64>, // unix millis
    options: Option<Value>,  // what the current (or last) run was asked to do
    progress: Option<Value>, // most recent { day, count, failed? }
    runs: u64,
    last: Option<Value>, // result of the most recent completed run
    last_error: Option<String>,
}

pub struct Syncer {
    state: Mutex<SyncState>,
    idle: Condvar,
    db_url: String,
    cache: Arc<ModelCache>,
}

impl Syncer {
    /// The state, with poison recovery — same reasoning as `Trainer::state`.
    fn state(&self) -> std::sync::MutexGuard<'_, SyncState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn new(db_url: String, cache: Arc<ModelCache>) -> Arc<Syncer> {
        Arc::new(Syncer {
            state: Mutex::new(SyncState::default()),
            idle: Condvar::new(),
            db_url,
            cache,
        })
    }

    /// Start a sync unless one is running. Returns the status either way.
    pub fn request(self: &Arc<Self>, req: SyncRequest) -> Value {
        let mut state = self.state();
        if state.running {
            let mut out = status_json(&state);
            out["status"] = json!("busy");
            return out;
        }
        state.running = true;
        state.started_at = Some(now_millis());
        state.options = Some(req.to_json());
        state.progress = None;
        let syncer = Arc::clone(self);
        std::thread::spawn(move || syncer.run(req));
        let mut out = status_json(&state);
        out["status"] = json!("started");
        out
    }

    fn run(self: Arc<Self>, req: SyncRequest) {
        let started = now_millis();
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            let conn = open_db(&self.db_url);
            let fetcher = HttpFetcher::default();
            let source = Algolia { fetch: &fetcher };
            let progress_sink = &self;
            sync(&conn, &self.cache, &req, &source, &mut |p| {
                progress_sink.state().progress =
                    Some(serde_json::to_value(p).expect("progress json"));
            })
        }));
        let mut state = self.state();
        state.runs += 1;
        match result {
            Ok(Ok(outcome)) => {
                let mut value = serde_json::to_value(&outcome).expect("sync json");
                value["ms"] = json!(now_millis() - started);
                value["finishedAt"] = json!(now_seconds());
                state.last = Some(value);
                state.last_error = None;
            }
            Ok(Err(message)) => {
                eprintln!("sync failed: {message}");
                state.last_error = Some(message);
            }
            Err(payload) => {
                let message = panic_message(payload);
                eprintln!("sync failed: {message}");
                state.last_error = Some(message);
            }
        }
        state.running = false;
        state.started_at = None;
        self.idle.notify_all();
    }

    pub fn status(&self) -> Value {
        status_json(&self.state())
    }

    /// Block until no sync is running (tests, CLI).
    pub fn wait_idle(&self) {
        let mut state = self.state();
        while state.running {
            state = self
                .idle
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
}

fn status_json(state: &SyncState) -> Value {
    json!({
        "running": state.running,
        "startedAt": state.started_at,
        "options": state.options,
        "progress": state.progress,
        "runs": state.runs,
        "last": state.last,
        "lastError": state.last_error,
    })
}
