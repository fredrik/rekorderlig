//! Background training. `request_train` returns at once; the fit + rescore runs
//! on its own thread with its own SQLite connection, and at most one runs at a
//! time. A request that arrives mid-run is coalesced into one follow-up run,
//! so votes cast while training are never lost — they just land in the next
//! revision. Any number of triggers in flight collapse into ≤ 2 runs.

use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};

use serde_json::{json, Value};

use crate::dates::{now_millis, now_seconds};
use crate::db::open_db;
use crate::model::FitOptions;
use crate::service::{train_and_score, ModelCache};

#[derive(Default)]
struct TrainState {
    running: bool,
    pending: bool,
    started_at: Option<i64>, // unix millis, like the Node backend reported
    runs: u64,
    last: Option<Value>, // result of the most recent completed run
    last_error: Option<String>,
}

pub struct Trainer {
    state: Mutex<TrainState>,
    idle: Condvar,
    db_path: PathBuf,
    cache: Arc<ModelCache>,
}

pub fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "training worker panicked".to_string()
    }
}

impl Trainer {
    pub fn new(db_path: PathBuf, cache: Arc<ModelCache>) -> Arc<Trainer> {
        Arc::new(Trainer {
            state: Mutex::new(TrainState::default()),
            idle: Condvar::new(),
            db_path,
            cache,
        })
    }

    /// Ask for a retrain. Returns `started` if a run began now, `queued` if one
    /// is already running.
    pub fn request(self: &Arc<Self>) -> Value {
        let mut state = self.state.lock().expect("train state");
        if state.running {
            state.pending = true;
            let mut out = status_json(&state);
            out["status"] = json!("queued");
            return out;
        }
        state.running = true;
        state.pending = false;
        state.started_at = Some(now_millis());
        let trainer = Arc::clone(self);
        std::thread::spawn(move || trainer.run_loop());
        let mut out = status_json(&state);
        out["status"] = json!("started");
        out
    }

    fn run_loop(self: Arc<Self>) {
        loop {
            let started = now_millis();
            // A panic in the run (a broken database, a bad payload) becomes the
            // reported error, the way the Node worker's crash did — the server
            // itself must keep serving.
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                let conn = open_db(&self.db_path);
                train_and_score(&conn, &self.cache, FitOptions::default()).to_json()
            }));
            let mut state = self.state.lock().expect("train state");
            state.runs += 1;
            match result {
                Ok(mut value) => {
                    value["ms"] = json!(now_millis() - started);
                    value["finishedAt"] = json!(now_seconds());
                    state.last = Some(value);
                    state.last_error = None;
                }
                Err(payload) => {
                    let message = panic_message(payload);
                    eprintln!("training failed: {message}");
                    state.last_error = Some(message);
                }
            }
            if state.pending {
                state.pending = false;
                state.started_at = Some(now_millis());
                continue;
            }
            state.running = false;
            state.started_at = None;
            self.idle.notify_all();
            break;
        }
    }

    pub fn status(&self) -> Value {
        status_json(&self.state.lock().expect("train state"))
    }

    /// Block until no training is running or pending (tests, CLI).
    pub fn wait_idle(&self) {
        let mut state = self.state.lock().expect("train state");
        while state.running || state.pending {
            state = self.idle.wait(state).expect("train wait");
        }
    }
}

fn status_json(state: &TrainState) -> Value {
    json!({
        "running": state.running,
        "pending": state.pending,
        "startedAt": state.started_at,
        "runs": state.runs,
        "last": state.last,
        "lastError": state.last_error,
    })
}
