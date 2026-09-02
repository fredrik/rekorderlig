//! Who a request is. A user is a session, started by spending a login link;
//! the operator is `AUTH_TOKEN` as a Bearer and is not a user; with no
//! `AUTH_TOKEN` an anonymous request is user 1. Every case here has a second
//! user in the room where one would hide the bug.

mod common;

use std::path::PathBuf;
use std::sync::Arc;

use common::{story, TempDb};
use rekorderlig::dates::now_seconds;
use rekorderlig::db::{
    create_login_link, create_session, create_user, revoke_access, upsert_story, User,
};
use rekorderlig::serde_json::{json, Value};
use rekorderlig::server::{serve, App, ServerHandle};

const OPERATOR: &str = "sesam";

struct TestServer {
    app: Arc<App>,
    handle: ServerHandle,
    base: String,
    _db: TempDb,
}

fn start(name: &str, auth_token: Option<&str>) -> TestServer {
    let db = TempDb::new(name);
    let public = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("public");
    let app = App::new(db.url.clone(), public, auth_token.map(str::to_string));
    let handle = serve(Arc::clone(&app), "127.0.0.1:0");
    let base = format!("http://127.0.0.1:{}", handle.port);
    TestServer {
        app,
        handle,
        base,
        _db: db,
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.handle.stop();
    }
}

/// A client that does not follow redirects: `/login` answers 303, and the
/// headers on that answer are what these tests read.
fn agent() -> ureq::Agent {
    ureq::builder().redirects(0).build()
}

fn done(result: Result<ureq::Response, ureq::Error>) -> (u16, ureq::Response) {
    match result {
        Ok(res) => (res.status(), res),
        Err(ureq::Error::Status(status, res)) => (status, res),
        Err(e) => panic!("transport error: {e}"),
    }
}

fn json_of(res: ureq::Response) -> Value {
    res.into_json().unwrap_or(Value::Null)
}

impl TestServer {
    fn get(&self, path: &str, headers: &[(&str, String)]) -> (u16, ureq::Response) {
        let mut req = agent().get(&format!("{}{path}", self.base));
        for (k, v) in headers {
            req = req.set(k, v);
        }
        done(req.call())
    }

    fn post(&self, path: &str, body: Value, headers: &[(&str, String)]) -> (u16, ureq::Response) {
        let mut req = agent()
            .post(&format!("{}{path}", self.base))
            .set("content-type", "application/json");
        for (k, v) in headers {
            req = req.set(k, v);
        }
        done(req.send_string(&body.to_string()))
    }

    /// The operator creates a user; back comes the row and a one-use link.
    fn invite(&self, body: Value) -> Value {
        let (status, res) = self.post("/api/users", body, &[operator()]);
        assert_eq!(status, 201, "{}", json_of(res));
        json_of(res)
    }

    /// Open a login link the way a browser would, and return the session
    /// cookie's value out of the 303.
    fn redeem(&self, path: &str) -> String {
        let (status, res) = self.get(path, &[]);
        assert_eq!(status, 303, "redeeming {path}");
        assert_eq!(res.header("location"), Some("/"));
        cookie_value(res.header("set-cookie").expect("a session cookie"))
    }
}

fn operator() -> (&'static str, String) {
    ("authorization", format!("Bearer {OPERATOR}"))
}

fn cookie(token: &str) -> (&'static str, String) {
    ("cookie", format!("rk_token={token}"))
}

/// `rk_token=abc; Path=/; …` → `abc`.
fn cookie_value(set_cookie: &str) -> String {
    let (pair, _) = set_cookie.split_once(';').unwrap_or((set_cookie, ""));
    let (name, value) = pair.split_once('=').expect("name=value");
    assert_eq!(name, "rk_token");
    value.to_string()
}

fn seed(app: &App) {
    let db = app.lock_db();
    let now = now_seconds();
    upsert_story(
        &db,
        &story(
            1,
            "Rust borrow checker internals",
            Some("https://rustblog.dev/a"),
            Some("rustblog.dev"),
            "a",
            120,
            60,
            now - 3600,
        ),
    );
    upsert_story(
        &db,
        &story(
            2,
            "Apple announces the new iPhone",
            Some("https://apple.com/a"),
            Some("apple.com"),
            "b",
            300,
            150,
            now - 7200,
        ),
    );
}

#[test]
fn nobody_gets_in_without_a_session() {
    let s = start("auth-nobody", Some(OPERATOR));

    let (status, res) = s.get("/", &[]);
    assert_eq!(status, 401);
    assert!(res.into_string().unwrap().contains("login link"));
    assert_eq!(s.get("/api/stats", &[]).0, 401);
    // The old ?token= bootstrap is gone: the operator token in the URL is
    // neither a login nor the operator.
    assert_eq!(s.get(&format!("/api/stats?token={OPERATOR}"), &[]).0, 401);
    // A malformed cookie is a 401, not a crash, and the server is still up.
    assert_eq!(
        s.get(
            "/api/stats",
            &[("cookie", "rk_token=%E0; junk; a=b=c".to_string())]
        )
        .0,
        401
    );
    assert_eq!(s.get("/api/sync", &[operator()]).0, 200);
    // No such link.
    assert_eq!(s.get("/login?t=nonsense", &[]).0, 401);
    assert_eq!(s.get("/login", &[]).0, 401);
}

#[test]
fn the_operator_may_sync_and_administer_and_is_not_a_user() {
    let s = start("auth-operator", Some(OPERATOR));
    let op = [operator()];

    assert_eq!(s.get("/api/sync", &op).0, 200, "the hourly machine's poll");
    assert_eq!(s.get("/", &op).0, 200, "the operator may load the UI");
    assert_eq!(
        s.get("/api/stats", &op).0,
        403,
        "and gets 403s from every user route"
    );
    let (status, _) = s.post("/api/vote", json!({"id": 1, "value": 1}), &op);
    assert_eq!(status, 403);

    let (status, res) = s.get("/api/users", &op);
    assert_eq!(status, 200);
    let users = json_of(res);
    assert_eq!(users["users"].as_array().unwrap().len(), 1);
    assert_eq!(users["users"][0]["id"], 1);
    assert_eq!(users["users"][0]["displayName"], "owner");

    // A user calling an operator route: the credential was fine, the role was
    // not — 403, so the browser flow does not go looking for a login link.
    let invite = s.invite(json!({"email": "alice@example.com"}));
    let token = s.redeem(invite["link"]["path"].as_str().unwrap());
    let alice = [cookie(&token)];
    assert_eq!(s.get("/api/users", &alice).0, 403);
    let (status, _) = s.post("/api/users/1/link", json!({}), &alice);
    assert_eq!(status, 403);
    // But a user may ask for a sync: Brain's button.
    assert_eq!(s.get("/api/sync", &alice).0, 200);
}

#[test]
fn a_login_link_is_spent_once_and_the_session_it_starts_lasts() {
    let s = start("auth-link", Some(OPERATOR));

    // The operator knows only an email; the row exists with no name.
    let invite = s.invite(json!({"email": "Alice@Example.com"}));
    assert_eq!(
        invite["user"]["email"], "Alice@Example.com",
        "stored as typed"
    );
    assert_eq!(invite["user"]["displayName"], Value::Null);
    assert_eq!(invite["link"]["maxUses"], 1);
    let path = invite["link"]["path"].as_str().unwrap().to_string();
    assert!(path.starts_with("/login?t="), "{path}");
    assert_eq!(
        path,
        format!("/login?t={}", invite["link"]["token"].as_str().unwrap())
    );

    // Opening it: a 303 to /, a year-long HttpOnly cookie, Secure only when
    // the request came in over HTTPS.
    let (status, res) = s.get(&path, &[]);
    assert_eq!(status, 303);
    let set = res.header("set-cookie").unwrap().to_string();
    assert!(set.contains("HttpOnly"), "{set}");
    assert!(set.contains("Max-Age=31536000"), "{set}");
    assert!(
        !set.contains("Secure"),
        "plain http must store the cookie: {set}"
    );
    let token = cookie_value(&set);

    // Spent: the same link a second time is a 401.
    assert_eq!(s.get(&path, &[]).0, 401);

    // The session works, and says who it is.
    let alice = [cookie(&token)];
    let (status, res) = s.get("/api/stats", &alice);
    assert_eq!(status, 200);
    let stats = json_of(res);
    assert_eq!(stats["user"]["email"], "Alice@Example.com");
    assert_eq!(stats["user"]["displayName"], Value::Null, "not set up yet");
    assert_eq!(s.get("/", &alice).0, 200);

    // The same token as a Bearer, for scripts.
    let bearer = format!("Bearer {token}");
    assert_eq!(s.get("/api/stats", &[("authorization", bearer)]).0, 200);

    // She picks her name.
    let (status, res) = s.post("/api/me", json!({"displayName": "  Alice  "}), &alice);
    assert_eq!(status, 200);
    assert_eq!(json_of(res)["user"]["displayName"], "Alice");
    let (status, _) = s.post("/api/me", json!({"displayName": "   "}), &alice);
    assert_eq!(status, 400);
    let (status, _) = s.post("/api/me", json!({"displayName": "x".repeat(61)}), &alice);
    assert_eq!(status, 400);

    // The email is unique case-insensitively.
    let (status, _) = s.post(
        "/api/users",
        json!({"email": "alice@example.com"}),
        &[operator()],
    );
    assert_eq!(status, 409);

    // A second link over HTTPS carries Secure.
    let (status, res) = s.post("/api/users/2/link", json!({}), &[operator()]);
    assert_eq!(status, 201);
    let path2 = json_of(res)["link"]["path"].as_str().unwrap().to_string();
    let (status, res) = s.get(&path2, &[("x-forwarded-proto", "https".to_string())]);
    assert_eq!(status, 303);
    assert!(res.header("set-cookie").unwrap().contains("Secure"));

    // Signing out ends this device's session and clears the cookie; the
    // other device (the HTTPS one) is untouched.
    let other = cookie_value(&res.header("set-cookie").unwrap().to_string());
    let (status, res) = s.post("/api/logout", json!({}), &alice);
    assert_eq!(status, 200);
    assert!(res.header("set-cookie").unwrap().contains("Max-Age=0"));
    assert_eq!(s.get("/api/stats", &alice).0, 401);
    assert_eq!(s.get("/api/stats", &[cookie(&other)]).0, 200);

    // Nobody's link: 404, and an id that is not a number: no route.
    let (status, _) = s.post("/api/users/999/link", json!({}), &[operator()]);
    assert_eq!(status, 404);
    let (status, _) = s.post("/api/users/alice/link", json!({}), &[operator()]);
    assert_eq!(status, 404);
}

#[test]
fn a_shared_link_serves_its_uses_then_stops_and_an_expired_one_never_starts() {
    let s = start("auth-uses", Some(OPERATOR));

    // The preview's shape: one link in one comment, read by several people.
    let (status, res) = s.post("/api/users/1/link", json!({"uses": 2}), &[operator()]);
    assert_eq!(status, 201);
    let link = json_of(res)["link"].clone();
    assert_eq!(link["maxUses"], 2);
    let path = link["path"].as_str().unwrap();
    let a = s.redeem(path);
    let b = s.redeem(path);
    assert_ne!(a, b, "every redemption is its own session");
    assert_eq!(s.get(path, &[]).0, 401, "the third reader is too late");
    assert_eq!(s.get("/api/stats", &[cookie(&a)]).0, 200);
    assert_eq!(s.get("/api/stats", &[cookie(&b)]).0, 200);

    // The cap: nobody mints a link that never runs out.
    let (_, res) = s.post(
        "/api/users/1/link",
        json!({"uses": 1_000_000}),
        &[operator()],
    );
    assert_eq!(json_of(res)["link"]["maxUses"], 1000);

    // Expired before it was opened.
    let expired = {
        let db = s.app.lock_db();
        let link = create_login_link(&db, User::OWNER, 1);
        db.execute("UPDATE login_links SET expires_at = 0", &[])
            .unwrap();
        link.path()
    };
    assert_eq!(s.get(&expired, &[]).0, 401);
}

#[test]
fn two_users_see_only_their_own_votes() {
    let s = start("auth-two", Some(OPERATOR));
    seed(&s.app);
    let alice = s.invite(json!({"displayName": "Alice"}));
    let bob = s.invite(json!({"displayName": "Bob"}));
    let alice = [cookie(&s.redeem(alice["link"]["path"].as_str().unwrap()))];
    let bob = [cookie(&s.redeem(bob["link"]["path"].as_str().unwrap()))];

    let (status, res) = s.post("/api/vote", json!({"id": 1, "value": 1}), &alice);
    assert_eq!(status, 200);
    assert_eq!(json_of(res)["votes"]["total"], 1);

    let (_, res) = s.get("/api/votes", &alice);
    assert_eq!(json_of(res)["total"], 1);
    let (_, res) = s.get("/api/votes", &bob);
    assert_eq!(json_of(res)["total"], 0, "Bob has voted on nothing");
    let (_, res) = s.get("/api/stats", &bob);
    let stats = json_of(res);
    assert_eq!(stats["votes"]["total"], 0);
    assert_eq!(stats["user"]["displayName"], "Bob");

    // Bob's export is Bob's history: empty.
    let (_, res) = s.get("/api/export", &bob);
    assert_eq!(json_of(res)["votes"].as_array().unwrap().len(), 0);
    let (_, res) = s.get("/api/export", &alice);
    assert_eq!(json_of(res)["votes"].as_array().unwrap().len(), 1);
}

#[test]
fn a_user_adds_a_device_with_a_link_of_their_own() {
    let s = start("auth-add-device", Some(OPERATOR));
    let invite = s.invite(json!({"displayName": "Alice"}));
    let alice_id = invite["user"]["id"].as_i64().unwrap();
    let phone = [cookie(&s.redeem(invite["link"]["path"].as_str().unwrap()))];

    // Signed in, she mints a link for herself: one use, a week, no operator.
    let (status, res) = s.post("/api/me/link", json!({}), &phone);
    assert_eq!(status, 201);
    let link = json_of(res)["link"].clone();
    assert_eq!(link["maxUses"], 1);
    let path = link["path"].as_str().unwrap().to_string();
    assert!(path.starts_with("/login?t="), "{path}");

    // The laptop opens it and is her too; the link is then spent.
    let laptop = [cookie(&s.redeem(&path))];
    let (_, res) = s.get("/api/stats", &laptop);
    assert_eq!(json_of(res)["user"]["id"], alice_id);
    assert_eq!(s.get(&path, &[]).0, 401, "one use");
    // Both devices stay signed in; they are two sessions.
    assert_eq!(s.get("/api/stats", &phone).0, 200);

    // Only a user can ask: the operator is nobody, and so is nobody.
    let (status, _) = s.post("/api/me/link", json!({}), &[operator()]);
    assert_eq!(status, 403);
    let (status, _) = s.post("/api/me/link", json!({}), &[]);
    assert_eq!(status, 401);
}

#[test]
fn revoking_a_user_ends_every_device_and_voids_unspent_links() {
    let s = start("auth-revoke", Some(OPERATOR));
    let invite = s.invite(json!({"email": "carol@example.com"}));
    let carol = invite["user"]["id"].as_i64().map(User).unwrap();

    let (status, res) = s.post(
        &format!("/api/users/{}/link", carol.0),
        json!({"uses": 2}),
        &[operator()],
    );
    assert_eq!(status, 201);
    let path = json_of(res)["link"]["path"].as_str().unwrap().to_string();
    let phone = s.redeem(&path);
    let laptop = s.redeem(&path);
    // And a link she has not opened yet.
    let unspent = invite["link"]["path"].as_str().unwrap();

    let ended = revoke_access(&s.app.lock_db(), carol);
    assert_eq!(ended, 2);
    assert_eq!(s.get("/api/stats", &[cookie(&phone)]).0, 401);
    assert_eq!(s.get("/api/stats", &[cookie(&laptop)]).0, 401);
    assert_eq!(
        s.get(unspent, &[]).0,
        401,
        "the unopened invite is void too"
    );
}

#[test]
fn dev_mode_is_the_owner_unless_a_session_says_otherwise() {
    let s = start("auth-dev", None);

    // No AUTH_TOKEN: an anonymous request is user 1, and a stale cookie is
    // simply ignored rather than refused.
    let (status, res) = s.get("/api/stats", &[]);
    assert_eq!(status, 200);
    assert_eq!(json_of(res)["user"]["id"], 1);
    let (status, res) = s.get("/api/stats", &[("cookie", "rk_token=stale".to_string())]);
    assert_eq!(status, 200);
    assert_eq!(json_of(res)["user"]["id"], 1);
    assert_eq!(s.get("/", &[]).0, 200);

    // A live session still wins, so the invite flow can be tried locally.
    let (bob, token) = {
        let db = s.app.lock_db();
        let bob = create_user(&db, None, Some("bob")).unwrap();
        (bob, create_session(&db, bob, Some("test")))
    };
    let (status, res) = s.get("/api/stats", &[cookie(&token)]);
    assert_eq!(status, 200);
    assert_eq!(json_of(res)["user"]["id"], bob.0);

    // There is no operator in dev mode: nothing authenticates as one, so the
    // user routes are closed even here.
    assert_eq!(s.get("/api/users", &[]).0, 403);
    assert_eq!(s.get("/api/sync", &[]).0, 200);
}
