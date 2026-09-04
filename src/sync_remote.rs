//! `rekorderlig sync-remote`: `trigger()` asks a *running* instance to sync by
//! POSTing `/api/sync`, then polls it to an exit code — the hourly machine's
//! whole job, so the trigger needs no `DATABASE_URL`. The app fetches nothing
//! on a timer and the Fly machine suspends to RAM between visits, so
//! freshness has to be poked in from outside — this is the poke, and an
//! hourly Fly scheduled machine is what runs it
//! (`scripts/fly-sync-machine.sh`). It replaced twenty lines of curl and jq
//! in a GitHub Actions workflow: the same sequence, moved into the binary so
//! the runtime image needs neither and the schedule can live next to the app
//! instead of in someone else's cron.
//!
//! Waiting is the point, not politeness. The poll traffic is what keeps Fly
//! from suspending the machine mid-fetch, and the exit code is the only
//! failure signal a scheduled machine has.
//!
//! This is the one place the binary talks to *itself* over HTTP rather than to
//! SQLite: the scheduled machine has no volume (a volume attaches to one
//! machine, and the app holds it), so `sync` is not an option there.

use std::time::{Duration, Instant};

use serde_json::{json, Value};

const UA: &str = "rekorderlig/1.0 (sync trigger)";

/// Attempts at the POST, over and above the first.
const POST_RETRIES: u32 = 3;

/// Where to poke, and how patiently.
pub struct RemoteSync {
    /// Base URL of the instance, e.g. `https://rekorderlig.fly.dev`.
    pub url: String,
    /// Matches the instance's `AUTH_TOKEN`; `None` when it runs open.
    pub token: Option<String>,
    /// Days back to fetch — 1 is today, which is all an hourly run needs.
    pub days: u32,
    pub poll_every: Duration,
    /// Ceiling on the whole wait. One day is seconds; this is headroom.
    pub give_up_after: Duration,
}

impl Default for RemoteSync {
    fn default() -> Self {
        RemoteSync {
            url: "http://127.0.0.1:4173".to_string(),
            token: None,
            days: 1,
            poll_every: Duration::from_secs(5),
            give_up_after: Duration::from_secs(600),
        }
    }
}

/// Same rule as the HN fetches (`http_client.rs`): 429 and 5xx are the remote
/// having a bad moment, a 4xx is this request being wrong and will not improve
/// by being asked again.
fn retryable(e: &ureq::Error) -> bool {
    match e {
        ureq::Error::Status(code, _) => *code == 429 || *code >= 500,
        ureq::Error::Transport(_) => true,
    }
}

fn describe(e: &ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, _) => format!("HTTP {code}"),
        ureq::Error::Transport(t) => t.to_string(),
    }
}

/// Trigger a sync on a running instance and wait for it to finish.
///
/// `Ok` carries the completed run (the `last` object of `GET /api/sync`).
/// `Err` carries a message fit for one log line: a day that failed after its
/// own retries, the syncer's error, or the wait running out.
pub fn trigger(opts: &RemoteSync, note: &mut dyn FnMut(String)) -> Result<Value, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(60))
        .build();
    let base = opts.url.trim_end_matches('/');
    let auth = |req: ureq::Request| match &opts.token {
        Some(t) => req.set("authorization", &format!("Bearer {t}")),
        None => req,
    };

    // The retries absorb the machine waking up: the Fly proxy holds a request
    // while a suspended machine resumes, but a cold boot can still drop the
    // first connection.
    let mut attempt = 0;
    let started: Value = loop {
        let call = auth(
            agent
                .post(&format!("{base}/api/sync"))
                .set("user-agent", UA),
        )
        .send_json(json!({ "days": opts.days }));
        match call {
            Ok(res) => match res.into_json() {
                Ok(v) => break v,
                Err(e) => return Err(format!("bad JSON from POST /api/sync: {e}")),
            },
            Err(e) if retryable(&e) && attempt < POST_RETRIES => {
                note(format!("  POST /api/sync: {} — retrying", describe(&e)));
                std::thread::sleep(Duration::from_millis(500 * (1 << attempt)));
                attempt += 1;
            }
            Err(e) => return Err(format!("POST /api/sync: {}", describe(&e))),
        }
    };

    // A second sync is refused rather than queued (syncer.rs), so `busy` means
    // someone else's run is in flight — watch that one instead of failing.
    match started.get("status").and_then(Value::as_str) {
        Some("busy") => note("a sync is already running; watching that one instead".to_string()),
        _ => note(format!("syncing the last {} day(s)…", opts.days)),
    }

    let deadline = Instant::now() + opts.give_up_after;
    let status = loop {
        match auth(agent.get(&format!("{base}/api/sync")).set("user-agent", UA))
            .call()
            .map_err(|e| describe(&e))
            .and_then(|res| {
                res.into_json::<Value>()
                    .map_err(|e| format!("bad JSON: {e}"))
            }) {
            Ok(status) => {
                if status.get("running").and_then(Value::as_bool) != Some(true) {
                    break status;
                }
                if let Some(day) = status.pointer("/progress/day").and_then(Value::as_str) {
                    note(format!("  fetching {day}"));
                }
            }
            // A blip on one poll is not a failed sync — skip it and ask again.
            Err(e) => note(format!("  GET /api/sync: {e} — asking again")),
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "gave up waiting after {}s — check GET {base}/api/sync",
                opts.give_up_after.as_secs()
            ));
        }
        std::thread::sleep(opts.poll_every);
    };

    // A successful run clears lastError (syncer.rs), so a value here belongs to
    // the run this command started or watched.
    if let Some(error) = status.get("lastError").and_then(Value::as_str) {
        return Err(format!("sync failed: {error}"));
    }
    let last = status
        .get("last")
        .filter(|v| !v.is_null())
        .cloned()
        .ok_or_else(|| "the instance reports no completed run".to_string())?;
    let failures = last
        .get("failures")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !failures.is_empty() {
        let listed = failures
            .iter()
            .map(|f| {
                format!(
                    "{}: {}",
                    f["day"].as_str().unwrap_or("?"),
                    f["error"].as_str().unwrap_or("?")
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        return Err(format!("{} day(s) failed — {listed}", failures.len()));
    }
    Ok(last)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;

    type Seen = Arc<Mutex<Vec<(String, Option<String>, Value)>>>;

    struct Stub {
        server: Arc<tiny_http::Server>,
        url: String,
        seen: Seen,
        thread: Option<JoinHandle<()>>,
    }

    impl Drop for Stub {
        fn drop(&mut self) {
            self.server.unblock();
            if let Some(t) = self.thread.take() {
                let _ = t.join();
            }
        }
    }

    /// A fake instance: one answer for the POST, then the GET answers in order,
    /// the last of them repeating for as long as the client keeps asking.
    fn stub(post: (u16, Value), gets: Vec<Value>) -> Stub {
        let server = Arc::new(tiny_http::Server::http("127.0.0.1:0").expect("bind stub"));
        let port = match server.server_addr() {
            tiny_http::ListenAddr::IP(a) => a.port(),
            _ => 0,
        };
        let seen: Seen = Arc::new(Mutex::new(Vec::new()));
        let (srv, log) = (Arc::clone(&server), Arc::clone(&seen));
        let thread = std::thread::spawn(move || {
            let mut queue = gets.into_iter();
            let mut last = json!({ "running": false });
            for mut request in srv.incoming_requests() {
                let method = request.method().as_str().to_string();
                let url = request.url().to_string();
                let auth = request
                    .headers()
                    .iter()
                    .find(|h| h.field.equiv("authorization"))
                    .map(|h| h.value.as_str().to_string());
                let mut body = String::new();
                request.as_reader().read_to_string(&mut body).ok();
                log.lock().expect("seen").push((
                    format!("{method} {url}"),
                    auth,
                    serde_json::from_str(&body).unwrap_or(Value::Null),
                ));
                let (code, payload) = if method == "POST" {
                    (post.0, post.1.clone())
                } else {
                    if let Some(next) = queue.next() {
                        last = next;
                    }
                    (200, last.clone())
                };
                let response =
                    tiny_http::Response::from_string(payload.to_string()).with_status_code(code);
                let _ = request.respond(response);
            }
        });
        Stub {
            server,
            url: format!("http://127.0.0.1:{port}"),
            seen,
            thread: Some(thread),
        }
    }

    fn options(stub: &Stub) -> RemoteSync {
        RemoteSync {
            url: stub.url.clone(),
            token: Some("secret".to_string()),
            days: 1,
            poll_every: Duration::from_millis(5),
            give_up_after: Duration::from_millis(200),
        }
    }

    fn run(opts: &RemoteSync) -> (Result<Value, String>, Vec<String>) {
        let mut notes = Vec::new();
        let result = trigger(opts, &mut |n| notes.push(n));
        (result, notes)
    }

    #[test]
    fn waits_for_the_run_and_reports_it() {
        let stub = stub(
            (202, json!({ "status": "started" })),
            vec![
                json!({ "running": true, "progress": { "day": "2026-08-29", "count": 12 } }),
                json!({ "running": false, "lastError": null, "last": {
                    "days": 1, "fetched": 300, "inserted": 12, "scored": 12, "failures": []
                }}),
            ],
        );
        let (result, notes) = run(&options(&stub));
        assert_eq!(result.expect("finished")["fetched"], 300);
        assert!(
            notes.iter().any(|n| n.contains("2026-08-29")),
            "progress is reported as it arrives: {notes:?}"
        );

        let seen = stub.seen.lock().expect("seen");
        assert_eq!(seen[0].0, "POST /api/sync");
        // The token rides on every request, not just the first.
        assert!(seen.iter().all(|r| r.1.as_deref() == Some("Bearer secret")));
        assert_eq!(seen[0].2, json!({ "days": 1 }));
        assert_eq!(seen[1].0, "GET /api/sync");
    }

    #[test]
    fn a_failed_day_fails_the_command() {
        let stub = stub(
            (202, json!({ "status": "started" })),
            vec![json!({ "running": false, "last": {
                "days": 1, "fetched": 0, "failures": [{ "day": "2026-08-29", "error": "HTTP 503" }]
            }})],
        );
        let err = run(&options(&stub))
            .0
            .expect_err("a failed day is a failure");
        assert!(err.contains("2026-08-29") && err.contains("503"), "{err}");
    }

    #[test]
    fn a_syncer_error_fails_the_command() {
        let stub = stub(
            (202, json!({ "status": "started" })),
            vec![json!({ "running": false, "lastError": "database is locked", "last": null })],
        );
        let err = run(&options(&stub)).0.expect_err("lastError is a failure");
        assert!(err.contains("database is locked"), "{err}");
    }

    #[test]
    fn busy_watches_the_run_already_in_flight() {
        let stub = stub(
            (202, json!({ "status": "busy", "running": true })),
            vec![
                json!({ "running": true }),
                json!({ "running": false, "last": { "days": 1, "fetched": 7, "failures": [] } }),
            ],
        );
        let (result, notes) = run(&options(&stub));
        assert_eq!(result.expect("finished")["fetched"], 7);
        assert!(
            notes.iter().any(|n| n.contains("already running")),
            "{notes:?}"
        );
    }

    #[test]
    fn gives_up_when_the_run_never_finishes() {
        let stub = stub(
            (202, json!({ "status": "started" })),
            vec![json!({ "running": true })],
        );
        let err = run(&options(&stub)).0.expect_err("the wait has a ceiling");
        assert!(err.contains("gave up waiting"), "{err}");
    }

    #[test]
    fn a_rejected_token_fails_at_once() {
        let stub = stub((401, json!({ "error": "Unauthorized" })), vec![]);
        let err = run(&options(&stub)).0.expect_err("401 is fatal");
        assert!(err.contains("HTTP 401"), "{err}");
        // No retry: a wrong token will not come right by asking again.
        assert_eq!(stub.seen.lock().expect("seen").len(), 1);
    }
}
