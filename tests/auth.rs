//! Who a request is. A user is a session — started by taking up an invite,
//! which is what mints the user, or by spending a login link of an account
//! that already exists;
//! the operator is `AUTH_TOKEN` as a Bearer and is not a user; with no
//! `AUTH_TOKEN` an anonymous request is user 1. Every case here has a second
//! user in the room where one would hide the bug.

mod common;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use common::{story, TempDb};
use rekorderlig::dates::now_seconds;
use rekorderlig::db::{
    create_invite, create_login_link, create_session, create_user, delete_invite, delete_user,
    list_invites, revoke_access, upsert_story, User,
};
use rekorderlig::serde_json::{json, Value};
use rekorderlig::server::{access_line, serve, App, ServerHandle};

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

    /// The operator creates a user outright; back comes the row and a
    /// one-use link. Not the invite path — that one does not know who it is
    /// making (`mint_invite`).
    fn make_user(&self, body: Value) -> Value {
        let (status, res) = self.post("/api/users", body, &[operator()]);
        assert_eq!(status, 201, "{}", json_of(res));
        json_of(res)
    }

    /// The operator mints an invite; back comes the row and its one link.
    fn mint_invite(&self, body: Value) -> Value {
        let (status, res) = self.post("/api/invites", body, &[operator()]);
        assert_eq!(status, 201, "{}", json_of(res));
        json_of(res)["invite"].clone()
    }

    fn invites(&self) -> Vec<Value> {
        let (status, res) = self.get("/api/invites", &[operator()]);
        assert_eq!(status, 200);
        json_of(res)["invites"].as_array().cloned().unwrap()
    }

    /// Take a link up the way a browser does once the button is pressed — a
    /// POST to the link's own URL — and return the session cookie's value out
    /// of the 303. Opening the link (`look`) is a GET and spends nothing.
    fn redeem(&self, path: &str) -> String {
        let (status, res) = self.post_form(path);
        assert_eq!(status, 303, "redeeming {path}");
        assert_eq!(res.header("location"), Some("/"));
        cookie_value(res.header("set-cookie").expect("a session cookie"))
    }

    /// What the doorstep's form sends: `<form method="post">` with no action
    /// and no fields posts an empty urlencoded body to the page's own URL, GET
    /// parameters included — so the token never has to be written into the
    /// page.
    fn post_form(&self, path: &str) -> (u16, ureq::Response) {
        let req = agent()
            .post(&format!("{}{path}", self.base))
            .set("content-type", "application/x-www-form-urlencoded");
        done(req.send_string(""))
    }

    /// Open a link without taking it up: the GET a browser — or a chat's link
    /// previewer — makes first. The status and the page.
    fn look(&self, path: &str) -> (u16, String) {
        let (status, res) = self.get(path, &[]);
        let page = res.into_string().unwrap();
        (status, page)
    }
}

/// What a valid link shows before anything is spent: the doorstep, a 200 in
/// the door's own look, with one form posting back to the same URL and no
/// cookie — and `data-reason` naming which door it is.
fn assert_doorstep(page: &str, reason: &str) {
    assert!(
        page.contains(&format!(r#"data-reason="{reason}""#)),
        "{page}"
    );
    assert!(page.contains(r#"<form method="post""#), "{page}");
    assert!(
        !page.contains("action="),
        "the form posts to its own URL: {page}"
    );
    assert!(page.contains(r#"href="/styles.css""#), "{page}");
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

    // A browser gets the door: the app's own look, under a 401, saying the one
    // thing there is to do about it. The stylesheet it wears comes with it —
    // that one file is public, or the page arrives undressed.
    let (status, res) = s.get("/", &[]);
    assert_eq!(status, 401);
    assert_eq!(
        res.header("content-type"),
        Some("text/html; charset=utf-8"),
        "the signed-out answer is a page, not a paragraph"
    );
    let page = res.into_string().unwrap();
    // Both ways in, because they are not interchangeable: an invite mints a
    // new account, so a reader who already has one has to be told to get a
    // login link instead or their votes end up split across two.
    assert!(page.contains("Already signed up?"), "{page}");
    assert!(page.contains("login link"), "{page}");
    assert!(page.contains("Ask Fredrik for an invite"), "{page}");
    assert!(page.contains(r#"data-reason="signed-out""#), "{page}");
    let (status, res) = s.get("/styles.css", &[]);
    assert_eq!(status, 200, "the door needs its stylesheet");
    assert_eq!(res.header("content-type"), Some("text/css; charset=utf-8"));
    // Everything else is still shut, and an /api/ call still gets JSON.
    assert_eq!(s.get("/app.js", &[]).0, 401);
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
    // No such link. Same page, its other half: a link is spent or expired, and
    // the reason attribute is what picks the copy — a rename that broke the
    // rewrite would leave both halves showing at once.
    let (status, page) = s.look("/login?t=nonsense");
    assert_eq!(status, 401);
    assert!(page.contains(r#"data-reason="link-spent""#), "{page}");
    assert!(!page.contains(r#"data-reason="signed-out""#), "{page}");
    assert!(page.contains("Already signed up?"), "{page}");
    assert!(page.contains("Ask Fredrik for an invite"), "{page}");
    assert_eq!(s.get("/login", &[]).0, 401);
    // Pressing the button on a dead link is the same 401, and so is a POST
    // with no token at all.
    assert_eq!(s.post_form("/login?t=nonsense").0, 401);
    assert_eq!(s.post_form("/login").0, 401);
    assert_eq!(s.post_form("/invite/nonsense").0, 401);
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
    let invite = s.make_user(json!({"email": "alice@example.com"}));
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
    let invite = s.make_user(json!({"email": "Alice@Example.com"}));
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

    // Opening it is a look, not a spend: the doorstep, a 200 with a button
    // and no cookie. This is the request a chat's link previewer makes when
    // the link is pasted, so it must leave the link whole — a second look is
    // the same page.
    let (status, page) = s.look(&path);
    assert_eq!(status, 200);
    assert_doorstep(&page, "login");
    assert!(!page.contains(r#"data-reason="invite""#), "{page}");
    let (status, res) = s.get(&path, &[]);
    assert_eq!(status, 200, "looking twice spends nothing");
    assert_eq!(res.header("set-cookie"), None, "a look starts no session");
    assert_eq!(res.header("content-type"), Some("text/html; charset=utf-8"));
    assert_eq!(res.header("cache-control"), Some("no-store"));
    assert_eq!(res.header("referrer-policy"), Some("no-referrer"));

    // Pressing the button: a 303 to /, a year-long HttpOnly cookie, Secure
    // only when the request came in over HTTPS.
    let (status, res) = s.post_form(&path);
    assert_eq!(status, 303);
    let set = res.header("set-cookie").unwrap().to_string();
    assert!(set.contains("HttpOnly"), "{set}");
    assert!(set.contains("Max-Age=31536000"), "{set}");
    assert!(
        !set.contains("Secure"),
        "plain http must store the cookie: {set}"
    );
    let token = cookie_value(&set);

    // Spent: the same link a second time is a 401 — pressed or merely looked
    // at, since a spent link has no doorstep to show.
    assert_eq!(s.post_form(&path).0, 401);
    let (status, page) = s.look(&path);
    assert_eq!(status, 401);
    assert!(page.contains(r#"data-reason="link-spent""#), "{page}");

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
    let (status, res) = done(
        agent()
            .post(&format!("{}{path2}", s.base))
            .set("content-type", "application/x-www-form-urlencoded")
            .set("x-forwarded-proto", "https")
            .send_string(""),
    );
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
    let alice = s.make_user(json!({"displayName": "Alice"}));
    let bob = s.make_user(json!({"displayName": "Bob"}));
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
    let invite = s.make_user(json!({"displayName": "Alice"}));
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
    let invite = s.make_user(json!({"email": "carol@example.com"}));
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

#[test]
fn an_invite_mints_the_user_who_opens_it_and_the_ledger_says_who() {
    let s = start("auth-invite", Some(OPERATOR));

    // An invite knows nothing about who will take it up. The note is the
    // operator's own; it never reaches the person opening the link.
    let invite = s.mint_invite(json!({"note": "  Dana, from work  "}));
    assert_eq!(invite["note"], "Dana, from work", "trimmed");
    let path = invite["path"].as_str().unwrap().to_string();
    assert_eq!(
        path,
        format!("/invite/{}", invite["token"].as_str().unwrap())
    );

    // Nobody yet.
    let before = s.invites();
    assert_eq!(before.len(), 1);
    assert_eq!(before[0]["redeemedAt"], Value::Null);
    assert_eq!(before[0]["user"], Value::Null);

    // Opening it shows the doorstep and mints nobody. Slack fetches every link
    // pasted into a channel to preview it; on 2026-09-04 that GET took up two
    // invites and minted two nameless users before the invitee had seen the
    // message. Looking is free, and the ledger says so.
    let (status, page) = s.look(&path);
    assert_eq!(status, 200);
    assert_doorstep(&page, "invite");
    assert!(!page.contains(r#"data-reason="login""#), "{page}");
    let looked = s.invites();
    assert_eq!(
        looked[0]["redeemedAt"],
        Value::Null,
        "a look takes nothing up"
    );
    assert_eq!(looked[0]["user"], Value::Null);
    let (_, res) = s.get("/api/users", &[operator()]);
    assert_eq!(
        json_of(res)["users"].as_array().unwrap().len(),
        1,
        "nobody minted"
    );

    // Accepting it: a session for a user who did not exist a moment ago, and
    // the token is kept out of anything the next page might send onward.
    let (status, res) = s.post_form(&path);
    assert_eq!(status, 303);
    assert_eq!(res.header("location"), Some("/"));
    assert_eq!(res.header("referrer-policy"), Some("no-referrer"));
    let dana = cookie_value(res.header("set-cookie").unwrap());
    let (status, res) = s.get("/api/stats", &[cookie(&dana)]);
    assert_eq!(status, 200);
    let me = json_of(res)["user"].clone();
    assert!(me["id"].as_i64().unwrap() > 1, "a new row: {me}");
    assert_eq!(me["displayName"], Value::Null, "she picks it herself");
    assert_eq!(me["email"], Value::Null, "an invite carries no address");
    // Once. A second reader of the same chat message gets the shut door —
    // whether they press or only look — and no second user is minted.
    assert_eq!(s.post_form(&path).0, 401);
    assert_eq!(s.get(&path, &[]).0, 401);

    // The ledger: whether, by whom, when.
    let after = s.invites();
    assert_eq!(after.len(), 1, "one invite, taken up once");
    assert!(after[0]["redeemedAt"].as_i64().unwrap() > 0);
    assert_eq!(after[0]["user"]["id"], me["id"]);
    assert_eq!(after[0]["note"], "Dana, from work");

    // She names herself, and the ledger reads back the name she chose —
    // which is the thing the invite could not have known.
    let (status, _) = s.post("/api/me", json!({"displayName": "Dana"}), &[cookie(&dana)]);
    assert_eq!(status, 200);
    assert_eq!(s.invites()[0]["user"]["displayName"], "Dana");

    // Newest first, and a note is optional.
    s.mint_invite(json!({}));
    let list = s.invites();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0]["note"], Value::Null);
    assert_eq!(list[0]["redeemedAt"], Value::Null);
}

#[test]
fn an_invite_can_be_voided_before_it_is_opened_but_not_after() {
    let s = start("auth-invite-void", Some(OPERATOR));

    let doomed = s.mint_invite(json!({"note": "wrong chat"}));
    let id = doomed["id"].as_i64().unwrap();
    let (status, res) = s.post(
        &format!("/api/invites/{id}/revoke"),
        json!({}),
        &[operator()],
    );
    assert_eq!(status, 200);
    let ledger = json_of(res)["invites"].as_array().cloned().unwrap();
    assert!(ledger[0]["revokedAt"].as_i64().unwrap() > 0);
    assert_eq!(
        s.get(doomed["path"].as_str().unwrap(), &[]).0,
        401,
        "a voided invite mints nobody"
    );

    // Twice is a no-op, and so is an id that never was.
    let (status, _) = s.post(
        &format!("/api/invites/{id}/revoke"),
        json!({}),
        &[operator()],
    );
    assert_eq!(status, 409);
    let (status, _) = s.post("/api/invites/999/revoke", json!({}), &[operator()]);
    assert_eq!(status, 409);

    // Taken up: the row stays as history, and voiding it is refused — the
    // door it opened is a session, and `revoke_access` is what shuts that.
    let taken = s.mint_invite(json!({}));
    let token = s.redeem(taken["path"].as_str().unwrap());
    let (status, _) = s.post(
        &format!("/api/invites/{}/revoke", taken["id"].as_i64().unwrap()),
        json!({}),
        &[operator()],
    );
    assert_eq!(status, 409);
    assert_eq!(s.get("/api/stats", &[cookie(&token)]).0, 200);

    // Expired before it was opened, and no user to show for it.
    let expired = {
        let db = s.app.lock_db();
        let invite = create_invite(&db, Some("too slow"));
        db.execute(
            "UPDATE invites SET expires_at = 0 WHERE id = $1",
            &[&invite.id],
        )
        .unwrap();
        invite.path()
    };
    assert_eq!(s.get(&expired, &[]).0, 401);
    let ledger = list_invites(&s.app.lock_db());
    let stale = ledger
        .iter()
        .find(|i| i.note.as_deref() == Some("too slow"));
    assert!(stale.unwrap().redeemed_at.is_none(), "never taken up");
}

#[test]
fn an_invite_can_be_removed_once_nobody_is_left_of_it() {
    let s = start("auth-invite-remove", Some(OPERATOR));
    let id_of = |v: &Value| v["id"].as_i64().unwrap();
    let in_ledger = |id: i64| list_invites(&s.app.lock_db()).iter().any(|i| i.id == id);

    // Never opened: trash, and it goes.
    let unopened = s.mint_invite(json!({"note": "typo"}));
    assert!(delete_invite(&s.app.lock_db(), id_of(&unopened)));
    assert!(!in_ledger(id_of(&unopened)));
    assert_eq!(
        s.get(unopened["path"].as_str().unwrap(), &[]).0,
        401,
        "and mints nobody"
    );

    // Voided first, then removed: revoke is not a prerequisite, but it is
    // not in the way either.
    let voided = s.mint_invite(json!({}));
    let (status, _) = s.post(
        &format!("/api/invites/{}/revoke", id_of(&voided)),
        json!({}),
        &[operator()],
    );
    assert_eq!(status, 200);
    assert!(delete_invite(&s.app.lock_db(), id_of(&voided)));
    assert!(!in_ledger(id_of(&voided)));

    // Taken up by someone who is still here: refused. The row is the record
    // of how they got in, and the user goes first (`user remove`) if at all.
    let taken = s.mint_invite(json!({"note": "erik"}));
    let token = s.redeem(taken["path"].as_str().unwrap());
    assert!(!delete_invite(&s.app.lock_db(), id_of(&taken)));
    assert!(in_ledger(id_of(&taken)));
    assert_eq!(
        s.get("/api/stats", &[cookie(&token)]).0,
        200,
        "their session is untouched"
    );

    // The user removed, the invite is "taken up — user since removed", and
    // that is a row nobody is left of: it may go too. Two deliberate steps
    // for a person, so removing an invite alone can never remove a user.
    let user = list_invites(&s.app.lock_db())
        .into_iter()
        .find(|i| i.id == id_of(&taken))
        .and_then(|i| i.user)
        .map(|u| u.id)
        .expect("the ledger knows who took it up");
    assert!(delete_user(&s.app.lock_db(), user));
    assert!(delete_invite(&s.app.lock_db(), id_of(&taken)));
    assert!(!in_ledger(id_of(&taken)));

    // An id that never was is nothing to remove.
    assert!(!delete_invite(&s.app.lock_db(), 999));
}

#[test]
fn invites_are_the_operators_and_a_user_may_not_see_them() {
    let s = start("auth-invite-role", Some(OPERATOR));
    let invite = s.mint_invite(json!({}));
    let token = s.redeem(invite["path"].as_str().unwrap());
    let them = [cookie(&token)];
    assert_eq!(s.get("/api/invites", &them).0, 403);
    assert_eq!(s.post("/api/invites", json!({}), &them).0, 403);
    assert_eq!(s.post("/api/invites/1/revoke", json!({}), &them).0, 403);
    assert_eq!(s.get("/api/invites", &[]).0, 401, "and a stranger is 401");
}

#[test]
fn the_access_log_never_carries_a_token() {
    // The invite token is its URL, and the login token is in the GET
    // parameters. `handle` passes only the pathname, and the pathname of an
    // invite is cut short here, so `fly logs` can be read by anyone with
    // access to them without becoming a way in.
    let line = access_line("GET", "/invite/s3cr3t-token", 303, Duration::from_millis(12), "");
    assert!(!line.contains("s3cr3t"), "{line}");
    assert_eq!(line, "GET /invite/<token> 303 12ms");
    let line = access_line("GET", "/api/feed", 200, Duration::from_millis(12), "u1");
    assert_eq!(line, "GET /api/feed 200 12ms u1");
}
