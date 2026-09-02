//! The routes table, optional AUTH_TOKEN auth, and static files. Nothing
//! fetches on a timer — `POST /api/sync` (202) is the only trigger, driven by
//! the hourly Fly scheduled machine (`sync-remote`) or the Brain tab.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tiny_http::{Header, Request, Response, Server};

use crate::dates::iso_now;
use crate::db::{
    delete_vote, import_vote, open_db, upsert_story, vote_counts, Db, Story, User, STORY_SELECT,
};
use crate::hn::fetch_story;
use crate::http_client::{Fetch, HttpFetcher};
use crate::service::{
    deal_round, explain, explore_queue, feed, judge, load_model, model_history, round_status,
    round_summary, stats, stories_per_day, training_queue, vote_log, FeedOptions, ModelCache,
    SyncRequest, EXPLORE, QUEUE_MIN_POINTS, ROUND_SIZE,
};
use crate::syncer::Syncer;
use crate::trainer::Trainer;

const COOKIE: &str = "rk_token";

pub struct App {
    pub db: Mutex<Db>,
    pub cache: Arc<ModelCache>,
    pub trainer: Arc<Trainer>,
    pub syncer: Arc<Syncer>,
    pub fetch: Box<dyn Fetch + Send + Sync>,
    pub public_dir: PathBuf,
    /// Optional single-user auth for public hosting. When set, every request
    /// must carry it — as a Bearer header, or once as ?token=… (the server
    /// then sets a cookie so phones only need the tokened link one time).
    /// None (the localhost/Tailscale case) means no auth.
    pub auth_token: Option<String>,
}

impl App {
    pub fn new(db_url: String, public_dir: PathBuf, auth_token: Option<String>) -> Arc<App> {
        let cache = Arc::new(ModelCache::default());
        Arc::new(App {
            db: Mutex::new(open_db(&db_url)),
            trainer: Trainer::new(db_url.clone(), Arc::clone(&cache)),
            syncer: Syncer::new(db_url, Arc::clone(&cache)),
            cache,
            fetch: Box::new(HttpFetcher::default()),
            public_dir,
            auth_token,
        })
    }

    /// The request-path connection, with poison recovery. A panic inside a
    /// handler is contained to a 500, but if it unwound while this guard was
    /// held the mutex is poisoned — and without recovery every later
    /// database-backed route would die on `PoisonError` until a restart.
    /// The connection itself stays sound: this path runs autocommit
    /// statements, so the one invariant a mid-flight panic could break is a
    /// transaction left open, rolled back here before the guard is handed out.
    pub fn lock_db(&self) -> std::sync::MutexGuard<'_, Db> {
        let db = self
            .db
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        db.rollback_if_open();
        db
    }
}

struct HttpError {
    status: u16,
    message: String,
}

fn http_error(status: u16, message: impl Into<String>) -> HttpError {
    HttpError {
        status,
        message: message.into(),
    }
}

type RouteResult = Result<(u16, Value), HttpError>;

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("header")
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "webmanifest" => "application/manifest+json",
        _ => "application/octet-stream",
    }
}

/// Constant-time string comparison, so the token can't be guessed byte by byte.
fn token_matches(candidate: Option<&str>, expected: &str) -> bool {
    let Some(candidate) = candidate else {
        return false;
    };
    if candidate.len() != expected.len() {
        return false;
    }
    candidate
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = bytes.get(i + 1..i + 3)?;
            let hex = std::str::from_utf8(hex).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    // A malformed cookie yields None, never a crash: the byte sequence must be
    // valid UTF-8 the way decodeURIComponent insists on valid percent escapes.
    String::from_utf8(out).ok()
}

/// encodeURIComponent, for the token cookie: everything but the unreserved set
/// is percent-encoded.
fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Read one cookie by name; a malformed header yields None, never a panic.
fn read_cookie(request: &Request, name: &str) -> Option<String> {
    let raw = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("cookie"))
        .map(|h| h.value.as_str().to_string())?;
    for part in raw.split(';') {
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        if key.trim() != name {
            continue;
        }
        return percent_decode(value.trim());
    }
    None
}

fn header_value(request: &Request, name: &'static str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str().to_string())
}

enum Auth {
    Ok { set_cookie: Option<String> },
    Denied,
}

fn authorize(app: &App, request: &Request, path: &str, params: &HashMap<String, String>) -> Auth {
    let Some(expected) = app.auth_token.as_deref() else {
        return Auth::Ok { set_cookie: None };
    };

    if let Some(auth) = header_value(request, "authorization") {
        if let Some(bearer) = auth.strip_prefix("Bearer ") {
            if token_matches(Some(bearer), expected) {
                return Auth::Ok { set_cookie: None };
            }
        }
    }

    if token_matches(read_cookie(request, COOKIE).as_deref(), expected) {
        return Auth::Ok { set_cookie: None };
    }

    if token_matches(params.get("token").map(String::as_str), expected) {
        // `Secure` only when the request actually arrived over HTTPS (Fly sets
        // x-forwarded-proto); a plain-http tailnet host would otherwise never
        // get the cookie stored and need the ?token= link on every visit.
        let https = header_value(request, "x-forwarded-proto").as_deref() == Some("https");
        let cookie = format!(
            "{COOKIE}={}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax{}",
            percent_encode(expected),
            if https { "; Secure" } else { "" }
        );
        return Auth::Ok {
            set_cookie: Some(cookie),
        };
    }

    let _ = path;
    Auth::Denied
}

/// null / absent / non-numeric → fallback, like the Node route helpers.
fn num_f(params: &HashMap<String, String>, key: &str, fallback: f64) -> f64 {
    match params.get(key) {
        Some(v) if !v.is_empty() => v.parse().unwrap_or(fallback),
        _ => fallback,
    }
}

fn num_i(params: &HashMap<String, String>, key: &str, fallback: i64) -> i64 {
    match params.get(key) {
        Some(v) if !v.is_empty() => v
            .parse::<i64>()
            .or_else(|_| v.parse::<f64>().map(|f| f as i64))
            .unwrap_or(fallback),
        _ => fallback,
    }
}

fn flag(params: &HashMap<String, String>, key: &str) -> bool {
    matches!(
        params.get(key).map(String::as_str),
        Some("1") | Some("true")
    )
}

/// A JSON number-or-numeric-string, the way `Number(x)` coerced in the Node
/// routes; returns None for anything that is not an integer.
fn json_int(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Some(i)
            } else {
                let f = n.as_f64()?;
                (f.fract() == 0.0).then_some(f as i64)
            }
        }
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn read_body(request: &mut Request, limit: usize) -> Result<Value, HttpError> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let n = request
            .as_reader()
            .read(&mut chunk)
            .map_err(|_| http_error(400, "unreadable body"))?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() > limit {
            return Err(http_error(413, "payload too large"));
        }
    }
    if buf.is_empty() {
        return Ok(json!({}));
    }
    let parsed: Value =
        serde_json::from_slice(&buf).map_err(|_| http_error(400, "invalid JSON body"))?;
    Ok(if parsed.is_object() {
        parsed
    } else {
        json!({})
    })
}

const VOTE_VALUES: [i64; 3] = [1, -1, 0];

// Section paths the front end routes client-side; each serves the app shell
// so /feed etc. survive a refresh or work as a bookmark.
const APP_PATHS: [&str; 6] = ["/", "/train", "/explore", "/feed", "/brain", "/votes"];

/// Resolve a request path inside the public directory. Segments are folded the
/// way path normalisation does — `..` pops, and never past the root, so the
/// result cannot escape `public/` however the request spells it.
fn safe_public_path(public_dir: &Path, pathname: &str) -> PathBuf {
    let rel = if APP_PATHS.contains(&pathname) {
        "/index.html"
    } else {
        pathname
    };
    let mut stack: Vec<&str> = Vec::new();
    for segment in rel.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            s => stack.push(s),
        }
    }
    let mut out = public_dir.to_path_buf();
    for s in stack {
        out.push(s);
    }
    out
}

/// A validator for one file, from its size and modification time.
///
/// Deliberately not a hash of the bytes. The whole point of the ETag is to
/// answer a revalidation *without* reading the file, and hashing would mean
/// reading it every time to decide whether to send it. Size and mtime is what
/// a static file server usually uses, and a build that changes a file always
/// rewrites its mtime. Nanoseconds, so two writes in the same second differ.
fn etag_for(meta: &std::fs::Metadata) -> Option<String> {
    let modified = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some(format!("\"{:x}-{:x}\"", modified.as_nanos(), meta.len()))
}

/// Whether an `If-None-Match` header claims the tag we are about to serve.
///
/// The header is a list, may be `*`, and entries may carry the `W/` weak
/// prefix. Weak is the right comparison here: these are whole files served
/// whole, so byte-identical is the only kind of equal there is.
fn none_match(header: &str, etag: &str) -> bool {
    header.split(',').any(|candidate| {
        let candidate = candidate.trim();
        candidate == "*" || candidate.trim_start_matches("W/") == etag
    })
}

fn serve_static(
    app: &App,
    pathname: &str,
    if_none_match: Option<&str>,
) -> Result<Response<std::io::Cursor<Vec<u8>>>, ()> {
    let file = safe_public_path(&app.public_dir, pathname);
    if file == app.public_dir {
        return Err(());
    }
    let Ok(meta) = std::fs::metadata(&file) else {
        return Err(());
    };
    if !meta.is_file() {
        return Err(());
    }

    // `no-cache` does not mean "do not store" — it means "revalidate before
    // reusing", which only saves anything when there is something to
    // revalidate against. Without the ETag below, every visit re-downloaded
    // every file in full, and the front end is a dozen modules now.
    let etag = etag_for(&meta);
    if let Some(etag) = &etag {
        if if_none_match.is_some_and(|header| none_match(header, etag)) {
            return Ok(Response::from_data(Vec::new())
                .with_status_code(304)
                .with_header(header("etag", etag))
                .with_header(header("cache-control", "no-cache")));
        }
    }

    let Ok(body) = std::fs::read(&file) else {
        return Err(());
    };
    let mut res = Response::from_data(body)
        .with_header(header("content-type", mime_for(&file)))
        .with_header(header("cache-control", "no-cache"));
    if let Some(etag) = &etag {
        res = res.with_header(header("etag", etag));
    }
    Ok(res)
}

fn get_story(db: &Db, id: i64) -> Option<Story> {
    db.query_opt(&format!("{STORY_SELECT} WHERE id = $1"), &[&id])
        .expect("get_story")
        .as_ref()
        .map(Story::from_row)
}

fn route(
    app: &App,
    method: &str,
    path: &str,
    params: &HashMap<String, String>,
    request: &mut Request,
) -> RouteResult {
    // Phase 1 of docs/multi-user.md: everything below the HTTP layer is keyed
    // by user, and every request is still the owner. Resolving this from the
    // credential is the next phase's whole change; `authorize()` above is
    // untouched until then.
    let user = User::OWNER;
    match (method, path) {
        ("GET", "/api/stats") => {
            let db = app.lock_db();
            Ok((200, stats(&db, &app.cache, user)))
        }

        ("GET", "/api/days") => {
            let db = app.lock_db();
            Ok((200, stories_per_day(&db, 60)))
        }

        ("GET", "/api/feed") => {
            let opts = FeedOptions {
                mode: params
                    .get("mode")
                    .cloned()
                    .unwrap_or_else(|| "foryou".to_string()),
                days: num_i(params, "days", 7),
                min_score: num_f(params, "minScore", 0.0),
                max_score: num_f(params, "maxScore", 1.0),
                min_points: num_i(params, "minPoints", 0),
                min_comments: num_i(params, "minComments", 0),
                limit: num_i(params, "limit", 50).min(200),
                offset: num_i(params, "offset", 0),
                include_voted: flag(params, "includeVoted"),
                day: params.get("day").filter(|d| !d.is_empty()).cloned(),
                query: params.get("q").filter(|q| !q.is_empty()).cloned(),
            };
            let db = app.lock_db();
            Ok((
                200,
                serde_json::to_value(feed(&db, &app.cache, user, &opts)).expect("feed json"),
            ))
        }

        ("GET", "/api/votes") => {
            let raw = params.get("value").map(String::as_str);
            let value = match raw {
                None | Some("") | Some("all") => None,
                Some(v) => Some(
                    v.parse::<i64>()
                        .ok()
                        .filter(|v| VOTE_VALUES.contains(v))
                        .ok_or_else(|| http_error(400, "value must be 1, -1, 0 or all"))?,
                ),
            };
            let db = app.lock_db();
            let log = vote_log(
                &db,
                user,
                value,
                num_i(params, "limit", 50).min(200),
                num_i(params, "offset", 0),
            );
            Ok((200, serde_json::to_value(log).expect("votes json")))
        }

        // The learning curve in Brain: accuracy per model revision. Its own
        // endpoint like /api/days, rather than riding along on /api/stats.
        ("GET", "/api/history") => {
            let db = app.lock_db();
            Ok((200, model_history(&db, user, 60)))
        }

        // Training runs in rounds; the deck is whatever the round has left.
        // `null` means nothing is in flight and the client should deal.
        ("GET", "/api/round") => {
            let db = app.lock_db();
            Ok((
                200,
                json!({"round": round_status(&db, user), "size": ROUND_SIZE}),
            ))
        }

        ("POST", "/api/round") => {
            let db = app.lock_db();
            Ok((
                200,
                json!({"round": deal_round(&db, &app.cache, user, ROUND_SIZE), "size": ROUND_SIZE}),
            ))
        }

        // Asked for once the round's retrain has landed; also marks the round spent.
        ("GET", "/api/round/summary") => {
            let db = app.lock_db();
            Ok((
                200,
                json!({"summary": round_summary(&db, &app.cache, user)}),
            ))
        }

        ("GET", "/api/queue") => {
            let cursor = num_i(params, "cursor", 0).max(0);
            let limit = num_i(params, "limit", 12).clamp(1, 100) as usize;
            let db = app.lock_db();
            let items = training_queue(&db, &app.cache, user, limit, cursor, QUEUE_MIN_POINTS);
            // `mix` is diagnostics, not decoration: the trainer card deliberately says
            // nothing about why a story was picked, so a swipe can't be anchored.
            let mut mix: HashMap<String, i64> = HashMap::new();
            for s in &items {
                *mix.entry(s.reason.clone().unwrap_or_default()).or_insert(0) += 1;
            }
            Ok((
                200,
                json!({
                    "items": items,
                    "mix": mix,
                    "cursor": cursor + 1,
                    "hasModel": load_model(&db, &app.cache, user).is_some(),
                }),
            ))
        }

        // Explore's deck: the same shape as /api/queue, a different pool — only
        // stories the crowd stopped on, tiered into probably/possibly. `days=0`
        // means the whole corpus.
        ("GET", "/api/explore") => {
            let db = app.lock_db();
            Ok((
                200,
                json!({
                    "items": explore_queue(
                        &db, &app.cache, user,
                        num_i(params, "limit", 25).min(100),
                        num_i(params, "days", 7),
                        &EXPLORE,
                    ),
                    "hasModel": load_model(&db, &app.cache, user).is_some(),
                    // The traction bar rides along so the client can say what it is when
                    // the deck comes back empty, without keeping its own copy of the numbers.
                    "bar": {"minPoints": EXPLORE.min_points, "minComments": EXPLORE.min_comments},
                }),
            ))
        }

        ("POST", "/api/vote") => {
            let body = read_body(request, 1_000_000)?;
            let story_id =
                json_int(body.get("id")).ok_or_else(|| http_error(400, "id required"))?;
            let value = json_int(body.get("value"))
                .filter(|v| VOTE_VALUES.contains(v))
                .ok_or_else(|| http_error(400, "value must be 1, -1 or 0"))?;
            let db = app.lock_db();
            if get_story(&db, story_id).is_none() {
                return Err(http_error(404, "unknown story"));
            }
            // The reveal the trainer shows after the swipe: what the model had
            // guessed, captured before this vote existed to teach it the answer.
            let outcome = judge(&db, &app.cache, user, story_id, value);
            Ok((
                200,
                json!({
                    "ok": true,
                    "votes": vote_counts(&db, user),
                    "prediction": outcome["prediction"],
                    "taught": outcome["taught"],
                }),
            ))
        }

        ("POST", "/api/unvote") => {
            let body = read_body(request, 1_000_000)?;
            let story_id =
                json_int(body.get("id")).ok_or_else(|| http_error(400, "id required"))?;
            let db = app.lock_db();
            delete_vote(&db, user, story_id);
            Ok((200, json!({"ok": true, "votes": vote_counts(&db, user)})))
        }

        // Voting only records; the client asks for a retrain when it is ready.
        // Training runs on its own thread, so this answers 202 immediately —
        // poll GET /api/train for the outcome. Triggers that land mid-run
        // collapse into a single follow-up run.
        ("POST", "/api/train") => Ok((202, app.trainer.request(user))),

        ("GET", "/api/train") => Ok((200, app.trainer.status(user))),

        // Fetching runs on its own thread (syncer.rs) — a range of days is a few
        // hundred sequential HTTP calls, far too long to hold a request open for.
        // Answers 202 immediately; poll GET /api/sync for progress and the outcome.
        ("POST", "/api/sync") => {
            let body = read_body(request, 1_000_000).unwrap_or_else(|_| json!({}));
            let from = body
                .get("from")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            let to = body
                .get("to")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            let mut options = crate::hn::SyncOptions::default();
            let mut has_options = false;
            if let Some(p) = json_int(body.get("pagesPerDay")) {
                options.pages_per_day = p.clamp(0, u32::MAX as i64) as u32;
                has_options = true;
            }
            if let Some(p) = json_int(body.get("minPoints")) {
                options.min_points = p;
                has_options = true;
            }
            let req = SyncRequest {
                days: if from.is_none() {
                    Some(json_int(body.get("days")).unwrap_or(2).clamp(1, 60) as u32)
                } else {
                    None
                },
                from: from.map(str::to_string),
                to: to.map(str::to_string),
                front_page: None,
                options: has_options.then_some(options),
            };
            Ok((202, app.syncer.request(req)))
        }

        ("GET", "/api/sync") => Ok((200, app.syncer.status())),

        ("GET", "/api/explain") => {
            let id = num_i(params, "id", -1);
            let db = app.lock_db();
            explain(&db, &app.cache, user, id)
                .map(|v| (200, v))
                .ok_or_else(|| http_error(404, "unknown story"))
        }

        ("GET", "/api/export") => {
            let db = app.lock_db();
            let votes: Vec<Value> = db
                .query(
                    "SELECT v.story_id, v.value, v.created_at, s.title, s.url, s.domain
                     FROM votes v JOIN stories s ON s.id = v.story_id
                     WHERE v.user_id = $1
                     ORDER BY v.created_at, v.story_id",
                    &[&user],
                )
                .expect("export query")
                .iter()
                .map(|r| {
                    json!({
                        "story_id": r.get::<_, i64>(0),
                        "value": r.get::<_, i64>(1),
                        "created_at": r.get::<_, i64>(2),
                        "title": r.get::<_, String>(3),
                        "url": r.get::<_, Option<String>>(4),
                        "domain": r.get::<_, Option<String>>(5),
                    })
                })
                .collect();
            Ok((200, json!({"exportedAt": iso_now(), "votes": votes})))
        }

        // Re-importing a vote history one vote at a time, so every vote can be
        // eyeballed as it lands. The story the vote was cast on may predate this
        // corpus, so an unknown id is looked up on HN rather than stubbed:
        // `title`/`url`/`domain` in the payload are ignored — HN is the authority
        // on what was submitted, and the response echoes the stored story back so
        // the caller can compare. No retrain is triggered per vote (each one would
        // rescore the whole corpus) — POST /api/train once the import is done.
        ("POST", "/api/import/vote") => {
            let body = read_body(request, 1_000_000)?;
            let story_id = json_int(body.get("story_id").or_else(|| body.get("id")))
                .filter(|id| *id > 0)
                .ok_or_else(|| http_error(400, "story_id required"))?;
            let value = json_int(body.get("value"))
                .filter(|v| VOTE_VALUES.contains(v))
                .ok_or_else(|| http_error(400, "value must be 1, -1 or 0"))?;
            let created_at = json_int(body.get("created_at"))
                .filter(|t| *t > 0)
                .ok_or_else(|| http_error(400, "created_at required (unix seconds)"))?;

            let db = app.lock_db();
            let mut fetched = false;
            if get_story(&db, story_id).is_none() {
                let hit = fetch_story(app.fetch.as_ref(), story_id).map_err(|e| {
                    http_error(502, format!("HN lookup failed for {story_id}: {e}"))
                })?;
                let Some(hit) = hit else {
                    return Err(http_error(404, format!("story {story_id} not found on HN")));
                };
                upsert_story(&db, &hit);
                fetched = true;
            }
            import_vote(&db, user, story_id, value, created_at);
            let story = get_story(&db, story_id).expect("imported story");
            Ok((
                200,
                json!({
                    "ok": true,
                    "fetched": fetched,
                    "story": {
                        "id": story.id, "title": story.title, "url": story.url,
                        "domain": story.domain, "points": story.points,
                        "num_comments": story.num_comments, "created_at": story.created_at,
                        "day": story.day,
                    },
                    "votes": vote_counts(&db, user),
                }),
            ))
        }

        _ => Err(http_error(404, format!("no route for {method} {path}"))),
    }
}

fn json_response(
    status: u16,
    body: &Value,
    extra: &[Header],
) -> Response<std::io::Cursor<Vec<u8>>> {
    let mut res = Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(header("content-type", "application/json; charset=utf-8"))
        .with_header(header("cache-control", "no-store"));
    for h in extra {
        res = res.with_header(h.clone());
    }
    res
}

fn handle(app: &App, mut request: Request) {
    let raw_url = request.url().to_string();
    let (pathname, query) = match raw_url.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (raw_url.clone(), String::new()),
    };
    let params: HashMap<String, String> = url::form_urlencoded::parse(query.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();

    let mut extra_headers: Vec<Header> = Vec::new();
    match authorize(app, &request, &pathname, &params) {
        Auth::Ok { set_cookie } => {
            if let Some(cookie) = set_cookie {
                extra_headers.push(header("set-cookie", &cookie));
            }
        }
        Auth::Denied => {
            let res = if pathname.starts_with("/api/") {
                json_response(401, &json!({"error": "unauthorized"}), &[])
            } else {
                Response::from_string("Unauthorized. Open the link that includes your ?token=…")
                    .with_status_code(401)
                    .with_header(header("content-type", "text/plain; charset=utf-8"))
                    .with_header(header("cache-control", "no-store"))
            };
            let _ = request.respond(res);
            return;
        }
    }

    if !pathname.starts_with("/api/") {
        let if_none_match = header_value(&request, "if-none-match");
        let res = match serve_static(app, &pathname, if_none_match.as_deref()) {
            Ok(mut res) => {
                for h in &extra_headers {
                    res = res.with_header(h.clone());
                }
                res
            }
            Err(()) => json_response(404, &json!({"error": "not found"}), &extra_headers),
        };
        let _ = request.respond(res);
        return;
    }

    let method = request.method().to_string().to_uppercase();
    // Nothing thrown while handling a request may escape: a panic in a handler
    // becomes a 500 and the worker thread keeps serving, the way the Node
    // server converted an unhandled error rather than letting it kill the
    // process.
    let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
        route(app, &method, &pathname, &params, &mut request)
    }));
    let (status, body) = match outcome {
        Ok(Ok((status, body))) => (status, body),
        Ok(Err(err)) => {
            if err.status >= 500 {
                eprintln!("[{method} {pathname}] {}", err.message);
            }
            (err.status, json!({"error": err.message}))
        }
        Err(payload) => {
            let message = crate::trainer::panic_message(payload);
            eprintln!("[{method} {pathname}] {message}");
            (500, json!({"error": "internal error"}))
        }
    };
    let _ = request.respond(json_response(status, &body, &extra_headers));
}

pub struct ServerHandle {
    pub port: u16,
    server: Arc<Server>,
}

impl ServerHandle {
    /// Stop accepting requests (tests). In-flight handlers finish on their own.
    pub fn stop(&self) {
        // One unblock per worker thread: each wakes a single blocked recv().
        for _ in 0..4 {
            self.server.unblock();
        }
    }
}

/// Bind and serve on a small worker pool. `addr` may use port 0; the bound
/// port is in the returned handle.
pub fn serve(app: Arc<App>, addr: &str) -> ServerHandle {
    let server = Arc::new(Server::http(addr).expect("bind"));
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(a) => a.port(),
        _ => 0,
    };
    // A small pool, not one thread: a slow sync poll must not queue behind a
    // static file. SQLite access is still serialised by the App's mutex.
    for _ in 0..4 {
        let server = Arc::clone(&server);
        let app = Arc::clone(&app);
        std::thread::spawn(move || {
            // recv() blocks until a request; stop() unblocks it with an Err.
            while let Ok(request) = server.recv() {
                handle(&app, request);
            }
        });
    }
    ServerHandle { port, server }
}
