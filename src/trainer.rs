//! Background training. `request` returns at once; the fit + rescore runs on
//! its own thread with its own database connection, and at most one runs at a
//! time. The queue is of *users*: a request for a user already running or
//! already queued is coalesced into the one follow-up run they have coming, so
//! votes cast while training are never lost — they just land in the next
//! revision. Any number of triggers in flight collapse into ≤ 2 runs per user.
//!
//! Status is per user, and has to be: `train.js` polls until nothing is
//! running or pending *for it* and then asks for its round summary. If
//! "running" meant anyone's run, one user's poll would return while another's
//! retrain was the one in flight, the summary would read `trained: false`, and
//! the round would be marked spent with the old model's numbers in it.

use std::collections::{HashMap, VecDeque};
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Condvar, Mutex};

use serde_json::{json, Value};

use crate::dates::{now_millis, now_seconds};
use crate::db::{open_db, User};
use crate::model::FitOptions;
use crate::service::{train_and_score, ModelCache};

#[derive(Default)]
struct TrainState {
    running: Option<User>,
    pending: VecDeque<User>,
    started_at: Option<i64>, // unix millis, like the Node backend reported
    runs: HashMap<User, u64>,
    last: HashMap<User, Value>, // result of each user's most recent completed run
    last_error: HashMap<User, String>,
}

impl TrainState {
    fn is_pending(&self, user: User) -> bool {
        self.pending.contains(&user)
    }
}

pub struct Trainer {
    state: Mutex<TrainState>,
    idle: Condvar,
    db_url: String,
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
    /// The state, with poison recovery: every write to it happens in small
    /// infallible sections (the run itself is behind catch_unwind), so on the
    /// off chance one panicked the fields are still plain, consistent values.
    fn state(&self) -> std::sync::MutexGuard<'_, TrainState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn new(db_url: String, cache: Arc<ModelCache>) -> Arc<Trainer> {
        Arc::new(Trainer {
            state: Mutex::new(TrainState::default()),
            idle: Condvar::new(),
            db_url,
            cache,
        })
    }

    /// Ask for a retrain of `user`'s model. Returns `started` if a run began
    /// now, `queued` if one is already running (theirs or anyone's).
    pub fn request(self: &Arc<Self>, user: User) -> Value {
        let mut state = self.state();
        if state.running.is_some() {
            // Once in the queue is enough, whether the run in flight is theirs
            // or someone else's: the run that dequeues them trains on every
            // vote recorded by then, however many triggers asked for it.
            if !state.is_pending(user) {
                state.pending.push_back(user);
            }
            let mut out = status_json(&state, user);
            out["status"] = json!("queued");
            return out;
        }
        state.running = Some(user);
        state.started_at = Some(now_millis());
        let trainer = Arc::clone(self);
        std::thread::spawn(move || trainer.run_loop(user));
        let mut out = status_json(&state, user);
        out["status"] = json!("started");
        out
    }

    fn run_loop(self: Arc<Self>, first: User) {
        let mut user = first;
        loop {
            let started = now_millis();
            // A panic in the run (a broken database, a bad payload) becomes the
            // reported error, the way the Node worker's crash did — the server
            // itself must keep serving.
            let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                let conn = open_db(&self.db_url);
                train_and_score(&conn, &self.cache, user, FitOptions::default()).to_json()
            }));
            let mut state = self.state();
            *state.runs.entry(user).or_insert(0) += 1;
            match result {
                Ok(mut value) => {
                    value["ms"] = json!(now_millis() - started);
                    value["finishedAt"] = json!(now_seconds());
                    state.last.insert(user, value);
                    state.last_error.remove(&user);
                }
                Err(payload) => {
                    let message = panic_message(payload);
                    eprintln!("training failed for user {}: {message}", user.0);
                    state.last_error.insert(user, message);
                }
            }
            if let Some(next) = state.pending.pop_front() {
                user = next;
                state.running = Some(user);
                state.started_at = Some(now_millis());
                continue;
            }
            state.running = None;
            state.started_at = None;
            self.idle.notify_all();
            break;
        }
    }

    /// One user's view of the trainer: whether *their* run is in flight or
    /// queued, and what their last one said.
    pub fn status(&self, user: User) -> Value {
        status_json(&self.state(), user)
    }

    /// Block until no training is running or pending, for anyone (tests, CLI).
    pub fn wait_idle(&self) {
        let mut state = self.state();
        while state.running.is_some() || !state.pending.is_empty() {
            state = self
                .idle
                .wait(state)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
}

fn status_json(state: &TrainState, user: User) -> Value {
    let running = state.running == Some(user);
    json!({
        "running": running,
        "pending": state.is_pending(user),
        "startedAt": if running { state.started_at } else { None },
        "runs": state.runs.get(&user).copied().unwrap_or(0),
        "last": state.last.get(&user),
        "lastError": state.last_error.get(&user),
    })
}
