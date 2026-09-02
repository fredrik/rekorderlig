//! The routes table, who the caller is, and static files. Nothing fetches on
//! a timer — `POST /api/sync` (202) is the only trigger, driven by the hourly
//! Fly scheduled machine (`sync-remote`) or the Brain tab.
//!
//! A caller is one of three things (`authorize()`): a **user**, identified by
//! a session token in the `rk_token` cookie (or as a Bearer, for scripts); the
//! **operator**, the `AUTH_TOKEN` secret sent as a Bearer by the sync machine
//! and the preview workflow, which may trigger a sync and administer users and
//! may not vote, be dealt a round or read a feed — there is no user for it to
//! be; or nobody. A session is minted by `GET /login?t=…`, which spends a
//! login link (`login_links`) and answers with the cookie and a redirect, so
//! the token leaves the address bar at once. With `AUTH_TOKEN` unset (the
//! localhost case) an anonymous request is user 1.
//!
//! Nobody gets `public/signed-out.html` under a 401 (`signed_out`) — the same
//! page whether there is no session or the login link was already spent — plus
//! the stylesheet it wears (`PUBLIC_FILES`); an `/api/` call gets the JSON
//! 401 the front end reads.

use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tiny_http::{Header, Request, Response, Server};

use crate::dates::iso_now;
use crate::db::{
    create_invite, create_login_link, create_session, create_user, delete_session, delete_vote,
    get_user, import_vote, list_invites, list_users, open_db, redeem_invite, redeem_login_link,
    revoke_invite, session_user, set_display_name, upsert_story, vote_counts, Db, Story, User,
    UserError, SESSION_TTL_SECS, STORY_SELECT,
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
    /// The operator token, for public hosting: sent as a Bearer by the hourly
    /// sync machine and the preview workflow. It is not a login — users sign
    /// in through a login link. None (the localhost/Tailscale case) means an
    /// anonymous request acts as user 1.
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

/// Who is asking. Resolved once per request, before routing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Auth {
    User(User),
    /// `AUTH_TOKEN` as a Bearer. May sync and administer users; may not act
    /// as a user, because there is none for it to be.
    Operator,
    Denied,
}

/// The token a request carries in its Authorization header, if any. The same
/// token shape lives in the cookie — a script may send its session token as a
/// Bearer — so one lookup serves both.
fn bearer(request: &Request) -> Option<String> {
    header_value(request, "authorization")
        .and_then(|auth| auth.strip_prefix("Bearer ").map(str::to_string))
}

fn authorize(app: &App, request: &Request) -> Auth {
    let bearer = bearer(request);
    if let (Some(expected), Some(candidate)) = (app.auth_token.as_deref(), bearer.as_deref()) {
        if token_matches(Some(candidate), expected) {
            return Auth::Operator;
        }
    }
    // One indexed lookup per request, static files included. A first visit is
    // about twenty requests, nineteen of them 304s, over 6PN at a fraction of
    // a millisecond each; not worth a cache, and a cache's TTL would be how
    // long a revoked session keeps working.
    if let Some(token) = bearer.or_else(|| read_cookie(request, COOKIE)) {
        if let Some(user) = session_user(&app.lock_db(), &token) {
            return Auth::User(user);
        }
    }
    if app.auth_token.is_none() {
        // Dev mode: nobody has to sign in to be somebody. A live session
        // cookie still wins above, so the invite flow can be tried locally.
        return Auth::User(User::OWNER);
    }
    Auth::Denied
}

/// The session cookie for a token. `Secure` only when the request actually
/// arrived over HTTPS (Fly sets x-forwarded-proto); a plain-http tailnet host
/// would otherwise never get the cookie stored.
fn session_cookie(request: &Request, token: &str, max_age: i64) -> String {
    let https = header_value(request, "x-forwarded-proto").as_deref() == Some("https");
    format!(
        "{COOKIE}={}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax{}",
        percent_encode(token),
        if https { "; Secure" } else { "" }
    )
}

fn text_response(status: u16, body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body)
        .with_status_code(status)
        .with_header(header("content-type", "text/plain; charset=utf-8"))
        .with_header(header("cache-control", "no-store"))
}

/// Files an unauthenticated request may still have. Exactly one: the
/// stylesheet the signed-out page is dressed in. Being turned away is a normal
/// thing to happen to a person — an invite arrives, and it is opened on a
/// phone weeks later — so it should look like the app and not like a stack
/// trace, and looking like the app takes the app's stylesheet.
const PUBLIC_FILES: [&str; 1] = ["/styles.css"];

/// Why the door is shut. Both answers are a 401 over the same page; the
/// difference is one attribute, and every word of the copy lives in the HTML.
#[derive(Clone, Copy)]
enum Gate {
    /// No session: no cookie, or one that has expired or been revoked.
    NoSession,
    /// A login link that is unknown, expired, or already spent — one answer on
    /// purpose (see `login`).
    LinkSpent,
}

const GATE_REASON: &str = "data-reason=\"signed-out\"";

/// The 401 page: `public/signed-out.html` with its reason set. The default in
/// the file is `NoSession`, so only the other case rewrites anything.
///
/// Read per request rather than cached: it is served to people arriving, not
/// in a loop, and `no-store` is the point — a cached "you are signed out" page
/// outliving the sign-in is the one caching bug this page could have.
fn signed_out(app: &App, reason: Gate) -> Response<std::io::Cursor<Vec<u8>>> {
    let Ok(html) = std::fs::read_to_string(app.public_dir.join("signed-out.html")) else {
        // Nothing to dress it in (a partial deploy, a wrong --public): say it
        // in words rather than serve a blank page.
        return text_response(
            401,
            "Signed out. Open your login link — or ask Fredrik for an invite.",
        );
    };
    let html = match reason {
        Gate::NoSession => html,
        Gate::LinkSpent => html.replace(GATE_REASON, "data-reason=\"link-spent\""),
    };
    Response::from_string(html)
        .with_status_code(401)
        .with_header(header("content-type", "text/html; charset=utf-8"))
        .with_header(header("cache-control", "no-store"))
}

/// `GET /login?t=…`: spend a login link and start a session on this device.
/// The user already exists — an invite is what makes one (`accept_invite`).
/// Unauthenticated by construction: it is how one gets a session.
fn login(app: &App, request: Request, params: &HashMap<String, String>) {
    let token = params.get("t").map(String::as_str).unwrap_or("").to_string();
    let user = redeem_login_link(&app.lock_db(), &token);
    open_the_door(app, request, user);
}

/// `GET /invite/<token>`: take up an invite. A user is minted here — this is
/// the only route that creates one without an operator — and the browser
/// leaves with that user's session, at `/`, where the welcome prompt asks the
/// one thing the invite could not know: what to call them.
///
/// A path of its own rather than another `?t=` on `/login`, because the two
/// are different events: `/login` is somebody the app already knows arriving
/// on a new device, `/invite` is somebody becoming a user. The onboarding
/// flow, when there is one, hangs off this one and not that one.
fn accept_invite(app: &App, request: Request, token: &str) {
    let user = redeem_invite(&app.lock_db(), token);
    open_the_door(app, request, user);
}

/// What both doors end in: a session for `user`, the cookie, and `/`.
///
/// A redirect rather than a page, so the token — in the query at `/login`, in
/// the path at `/invite` — is out of the address bar and out of history
/// before anything renders; the old `?token=` link never left, which is one
/// of the things this replaces. `Referrer-Policy` belongs to the same
/// promise: an invite's token *is* its URL, so nothing loaded afterwards may
/// carry it in a header.
fn open_the_door(app: &App, request: Request, user: Option<User>) {
    let session = user.map(|user| {
        let agent = header_value(&request, "user-agent");
        create_session(&app.lock_db(), user, agent.as_deref())
    });
    let res = match session {
        Some(session) => Response::from_string("")
            .with_status_code(303)
            .with_header(header("location", "/"))
            .with_header(header("cache-control", "no-store"))
            .with_header(header("referrer-policy", "no-referrer"))
            .with_header(header(
                "set-cookie",
                &session_cookie(&request, &session, SESSION_TTL_SECS),
            )),
        // Unknown, expired, revoked and already spent are one answer on
        // purpose: the remedy is the same, and telling them apart would tell
        // a guesser something.
        None => signed_out(app, Gate::LinkSpent),
    };
    let _ = request.respond(res);
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

/// Fetching runs on its own thread (syncer.rs) — a range of days is a few
/// hundred sequential HTTP calls, far too long to hold a request open for.
/// `POST` answers 202 immediately; poll `GET` for progress and the outcome.
fn route_sync(app: &App, method: &str, request: &mut Request) -> RouteResult {
    match method {
        "POST" => {
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
        "GET" => Ok((200, app.syncer.status())),
        _ => Err(http_error(404, format!("no route for {method} /api/sync"))),
    }
}

/// The id in `/api/invites/{id}/revoke`, the one route under it.
fn invite_path(path: &str) -> Option<i64> {
    path.strip_prefix("/api/invites/")?
        .strip_suffix("/revoke")?
        .parse()
        .ok()
}

/// The number of a `/api/users/{id}/…` path, and what follows it.
fn user_path(path: &str) -> Option<(User, &str)> {
    let rest = path.strip_prefix("/api/users/")?;
    let (id, tail) = rest.split_once('/').unwrap_or((rest, ""));
    Some((User(id.parse().ok()?), tail))
}

/// A user and the link that lets them in, as every operator route answers.
fn user_with_link(db: &Db, user: User, body: &Value) -> Value {
    // A person needs one use. The PR preview asks for more: its link sits in
    // a comment every reader of the PR opens. Capped so a typo cannot mint a
    // link that never runs out.
    let uses = json_int(body.get("uses")).unwrap_or(1).clamp(1, 1000);
    let link = create_login_link(db, user, uses);
    json!({
        "user": get_user(db, user),
        "link": {
            "token": link.token,
            "path": link.path(),
            "expiresAt": link.expires_at,
            "maxUses": link.max_uses,
        },
    })
}

/// The operator's routes: the users table, and a link for any of them.
fn route_operator(app: &App, method: &str, path: &str, request: &mut Request) -> RouteResult {
    match (method, path) {
        ("GET", "/api/users") => {
            let db = app.lock_db();
            Ok((200, json!({"users": list_users(&db)})))
        }

        // Create a user outright, with a link straight into their account.
        // Not the invite path: this one knows who it is making. It is here
        // for the preview seed and for repairing an account by hand.
        ("POST", "/api/users") => {
            let body = read_body(request, 100_000)?;
            let email = body.get("email").and_then(Value::as_str);
            let name = body.get("displayName").and_then(Value::as_str);
            let db = app.lock_db();
            let user = create_user(&db, email, name).map_err(|e| match e {
                UserError::EmailTaken => http_error(409, "a user with that email exists"),
            })?;
            Ok((201, user_with_link(&db, user, &body)))
        }

        // The ledger: every invite ever minted, newest first, and what
        // became of it.
        ("GET", "/api/invites") => {
            let db = app.lock_db();
            Ok((200, json!({"invites": list_invites(&db)})))
        }

        // Mint one. `note` is the operator's own bookkeeping and reaches
        // nobody else; the invite deliberately knows nothing about who will
        // open it, which is what makes `user` on the way back worth reading.
        ("POST", "/api/invites") => {
            let body = read_body(request, 100_000)?;
            let note = body.get("note").and_then(Value::as_str);
            let invite = create_invite(&app.lock_db(), note);
            Ok((
                201,
                json!({
                    "invite": {
                        "id": invite.id,
                        "note": invite.note,
                        "token": invite.token,
                        "path": invite.path(),
                        "expiresAt": invite.expires_at,
                    },
                }),
            ))
        }

        _ => {
            if let Some(id) = invite_path(path) {
                // Void an unspent one. A redeemed invite cannot be taken
                // back here — it is history, and the door it opened is a
                // session, closed with `rekorderlig user revoke`.
                if method == "POST" {
                    let db = app.lock_db();
                    return match revoke_invite(&db, id) {
                        true => Ok((200, json!({"invites": list_invites(&db)}))),
                        false => Err(http_error(
                            409,
                            "no unspent invite with that id — it may already be taken up",
                        )),
                    };
                }
                return Err(http_error(404, format!("no route for {method} {path}")));
            }
            let Some((user, tail)) = user_path(path) else {
                return Err(http_error(404, format!("no route for {method} {path}")));
            };
            match (method, tail) {
                // A fresh link for an existing user: a lost phone, a new one,
                // or the preview's shared way in.
                ("POST", "link") => {
                    let body = read_body(request, 100_000)?;
                    let db = app.lock_db();
                    if get_user(&db, user).is_none() {
                        return Err(http_error(404, "unknown user"));
                    }
                    Ok((201, user_with_link(&db, user, &body)))
                }
                _ => Err(http_error(404, format!("no route for {method} {path}"))),
            }
        }
    }
}

fn route(
    app: &App,
    auth: Auth,
    method: &str,
    path: &str,
    params: &HashMap<String, String>,
    request: &mut Request,
    extra_headers: &mut Vec<Header>,
) -> RouteResult {
    // The routes the operator may reach. A user calling one of the operator's
    // gets a 403, not a 401: the credential was fine, the role was not, and a
    // 401 would send the browser flow off to find a login link.
    if path == "/api/users"
        || path.starts_with("/api/users/")
        || path == "/api/invites"
        || path.starts_with("/api/invites/")
    {
        return match auth {
            Auth::Operator => route_operator(app, method, path, request),
            _ => Err(http_error(403, "operator only")),
        };
    }
    if path == "/api/sync" {
        // A fresher corpus is not a per-user act: the hourly machine is the
        // operator, Brain's button is a user, and both may ask.
        return route_sync(app, method, request);
    }

    let user = match auth {
        Auth::User(user) => user,
        // The operator loading the UI gets this from every route below, which
        // is correct: the operator token is not a login.
        Auth::Operator => {
            return Err(http_error(
                403,
                "the operator token is not a user; sign in with a login link",
            ))
        }
        Auth::Denied => unreachable!("handle() answers 401 before routing"),
    };
    match (method, path) {
        ("GET", "/api/stats") => {
            let db = app.lock_db();
            Ok((200, stats(&db, &app.cache, user)))
        }

        // The caller's own row: the display name is theirs to set, and this
        // is where a fresh invitee's "what should we call you" lands.
        ("POST", "/api/me") => {
            let body = read_body(request, 100_000)?;
            let name = body
                .get("displayName")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .ok_or_else(|| http_error(400, "displayName required"))?;
            if name.chars().count() > 60 {
                return Err(http_error(400, "displayName is too long (60 characters)"));
            }
            let db = app.lock_db();
            set_display_name(&db, user, name);
            Ok((200, json!({"user": get_user(&db, user)})))
        }

        // A link for another of the caller's own devices. Self-service on
        // purpose: "I have a second phone" should not need the operator, and
        // it can only mint for the account already signed in. One use, a
        // week, like any invite — the browser shows it once for copying.
        ("POST", "/api/me/link") => {
            let db = app.lock_db();
            let link = create_login_link(&db, user, 1);
            Ok((
                201,
                json!({
                    "link": {
                        "path": link.path(),
                        "expiresAt": link.expires_at,
                        "maxUses": link.max_uses,
                    },
                }),
            ))
        }

        // Sign this device out: the session row goes, and the cookie with it.
        // Other devices keep theirs — a session is a device, not a person.
        ("POST", "/api/logout") => {
            if let Some(token) = bearer(request).or_else(|| read_cookie(request, COOKIE)) {
                delete_session(&app.lock_db(), &token);
            }
            extra_headers.push(header("set-cookie", &session_cookie(request, "", 0)));
            Ok((200, json!({"ok": true})))
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

    // The two paths that need no session: they are how a session begins.
    if pathname == "/login" {
        login(app, request, &params);
        return;
    }
    if let Some(token) = pathname.strip_prefix("/invite/") {
        let token = token.to_string();
        accept_invite(app, request, &token);
        return;
    }

    let auth = authorize(app, &request);
    if auth == Auth::Denied {
        // A page for a browser, JSON for the app's own calls — and the
        // stylesheet, so the page it is for can wear it.
        let res = if pathname.starts_with("/api/") {
            json_response(401, &json!({"error": "unauthorized"}), &[])
        } else if PUBLIC_FILES.contains(&pathname.as_str()) {
            let if_none_match = header_value(&request, "if-none-match");
            serve_static(app, &pathname, if_none_match.as_deref())
                .unwrap_or_else(|()| signed_out(app, Gate::NoSession))
        } else {
            signed_out(app, Gate::NoSession)
        };
        let _ = request.respond(res);
        return;
    }

    // Static files serve a user or the operator alike. The operator loading
    // the UI then gets 403s from every user route, which is correct: the
    // operator token is not a login.
    if !pathname.starts_with("/api/") {
        let if_none_match = header_value(&request, "if-none-match");
        let res = match serve_static(app, &pathname, if_none_match.as_deref()) {
            Ok(res) => res,
            Err(()) => json_response(404, &json!({"error": "not found"}), &[]),
        };
        let _ = request.respond(res);
        return;
    }

    let mut extra_headers: Vec<Header> = Vec::new();
    let method = request.method().to_string().to_uppercase();
    // Nothing thrown while handling a request may escape: a panic in a handler
    // becomes a 500 and the worker thread keeps serving, the way the Node
    // server converted an unhandled error rather than letting it kill the
    // process.
    let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
        route(
            app,
            auth,
            &method,
            &pathname,
            &params,
            &mut request,
            &mut extra_headers,
        )
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
