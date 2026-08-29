//! Port of the Node API test suite: the HTTP surface, end to end against a
//! real server on an ephemeral port. The Node file ran its cases in order over
//! one server; the same sequence lives in one test here for the same reason —
//! later steps read state the earlier ones wrote.

mod common;

use std::path::PathBuf;
use std::sync::Arc;

use common::{story, TempDb};
use rekorderlig::dates::now_seconds;
use rekorderlig::db::upsert_story;
use rekorderlig::serde_json::{json, Value};
use rekorderlig::server::{serve, App, ServerHandle};

fn public_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("public")
}

struct TestServer {
    app: Arc<App>,
    handle: ServerHandle,
    base: String,
    _db: TempDb,
}

fn start(name: &str, auth_token: Option<&str>) -> TestServer {
    let db = TempDb::new(name);
    let app = App::new(
        db.path.clone(),
        public_dir(),
        auth_token.map(str::to_string),
    );
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

fn body_of(result: Result<ureq::Response, ureq::Error>) -> (u16, Value) {
    match result {
        Ok(res) => {
            let status = res.status();
            (status, res.into_json().unwrap_or(Value::Null))
        }
        Err(ureq::Error::Status(status, res)) => (status, res.into_json().unwrap_or(Value::Null)),
        Err(e) => panic!("transport error: {e}"),
    }
}

fn get(base: &str, path: &str) -> (u16, Value) {
    body_of(ureq::get(&format!("{base}{path}")).call())
}

fn post(base: &str, path: &str, body: Value) -> (u16, Value) {
    body_of(
        ureq::post(&format!("{base}{path}"))
            .set("content-type", "application/json")
            .send_string(&body.to_string()),
    )
}

fn seed_api_stories(app: &App) {
    let now = now_seconds();
    let rows: [(i64, &str, &str); 7] = [
        (1, "Rust borrow checker internals", "https://rustblog.dev/a"),
        (2, "Writing a compiler in Rust", "https://rustblog.dev/b"),
        (3, "Rust async runtime design", "https://tokio.rs/c"),
        (4, "Apple announces the new iPhone", "https://apple.com/a"),
        (5, "iPhone camera review", "https://theverge.com/b"),
        (6, "Apple Vision Pro sales slump", "https://theverge.com/c"),
        (
            7,
            "Rust compiler plugins explained",
            "https://rustblog.dev/d",
        ),
    ];
    let conn = app.db.lock().unwrap();
    for (id, title, url) in rows {
        let host = url::Url::parse(url)
            .unwrap()
            .host_str()
            .unwrap()
            .to_string();
        upsert_story(
            &conn,
            &story(
                id,
                title,
                Some(url),
                Some(&host),
                &format!("u{id}"),
                100 - id,
                100 - id,
                now - id * 60,
            ),
        );
    }
}

#[test]
fn static_serving_and_the_app_shell() {
    let server = start("api-static", None);
    let base = &server.base;

    // serves the web app
    let res = ureq::get(&format!("{base}/")).call().unwrap();
    assert_eq!(res.status(), 200);
    assert!(res.header("content-type").unwrap().contains("text/html"));
    assert!(res.into_string().unwrap().contains("rekorder"));

    // serves the app shell for section paths
    for path in ["/train", "/explore", "/feed", "/votes", "/brain"] {
        let res = ureq::get(&format!("{base}{path}")).call().unwrap();
        assert_eq!(res.status(), 200);
        assert!(res.header("content-type").unwrap().contains("text/html"));
        assert!(res.into_string().unwrap().contains("rekorder"), "{path}");
    }

    // unknown paths still 404
    assert_eq!(get(base, "/nonsense").0, 404);

    // refuses to escape the public directory (the client normalises /../ away;
    // the server-side segment fold has to hold for a raw request too)
    assert_eq!(get(base, "/../Cargo.toml").0, 404);
    assert_eq!(get(base, "/%2e%2e/Cargo.toml").0, 404);

    // unknown API routes 404 as JSON
    let (status, body) = get(base, "/api/nope");
    assert_eq!(status, 404);
    assert!(body["error"].as_str().unwrap().contains("no route"));
}

#[test]
fn malformed_requests_are_4xx_not_500() {
    let server = start("api-malformed", None);
    seed_api_stories(&server.app);
    let base = &server.base;

    // rejects malformed votes
    assert_eq!(post(base, "/api/vote", json!({"id": 1, "value": 5})).0, 400);
    assert_eq!(post(base, "/api/vote", json!({"value": 1})).0, 400);
    assert_eq!(
        post(base, "/api/vote", json!({"id": 9999, "value": 1})).0,
        404
    );
    assert_eq!(post(base, "/api/unvote", json!({})).0, 400);

    // client errors are 4xx, not 500
    let bad = body_of(
        ureq::post(&format!("{base}/api/vote"))
            .set("content-type", "application/json")
            .send_string("{not json"),
    );
    assert_eq!(bad.0, 400);
    assert!(bad.1["error"].as_str().unwrap().contains("invalid JSON"));
    let not_object = post(base, "/api/vote", json!(42));
    assert_eq!(not_object.0, 400);

    // per-vote import rejects an incomplete payload
    let no_id = post(
        base,
        "/api/import/vote",
        json!({"value": 1, "created_at": 1787574980}),
    );
    assert_eq!(no_id.0, 400);
    assert!(no_id.1["error"].as_str().unwrap().contains("story_id"));
    assert_eq!(
        post(
            base,
            "/api/import/vote",
            json!({"story_id": 1, "value": 7, "created_at": 1787574980})
        )
        .0,
        400
    );
    // The whole point of the endpoint is the historical timestamp, so it is required.
    let no_stamp = post(base, "/api/import/vote", json!({"story_id": 1, "value": 1}));
    assert_eq!(no_stamp.0, 400);
    assert!(no_stamp.1["error"].as_str().unwrap().contains("created_at"));
}

#[test]
fn the_api_flow_votes_train_rerank_export_import() {
    let server = start("api-flow", None);
    seed_api_stories(&server.app);
    let base = &server.base;

    // --- votes train a model that reranks the feed ---
    for id in [1, 2, 3] {
        assert_eq!(
            post(base, "/api/vote", json!({"id": id, "value": 1})).0,
            200
        );
    }
    for id in [4, 5] {
        assert_eq!(
            post(base, "/api/vote", json!({"id": id, "value": -1})).0,
            200
        );
    }

    let last = post(base, "/api/vote", json!({"id": 6, "value": -1}));
    assert!(
        last.1.get("training").is_none(),
        "voting only records; training is a separate trigger"
    );
    assert_eq!(
        last.1["votes"],
        json!({"up": 3, "down": 3, "skip": 0, "total": 6})
    );
    assert_eq!(get(base, "/api/feed?days=0").1["hasModel"], false);

    // The trigger answers at once and the work happens on another thread.
    let trigger = post(base, "/api/train", json!({}));
    assert_eq!(trigger.0, 202);
    assert_eq!(trigger.1["status"], "started");
    assert_eq!(trigger.1["running"], true);
    // A second trigger mid-run is coalesced into one follow-up run, not dropped.
    assert_eq!(post(base, "/api/train", json!({})).1["status"], "queued");

    server.app.trainer.wait_idle();
    let status = get(base, "/api/train").1;
    assert_eq!(status["running"], false);
    assert_eq!(status["pending"], false);
    assert_eq!(status["runs"], 2);
    assert_eq!(status["last"]["trained"], true);
    assert!(status["lastError"].is_null());

    let feed = get(base, "/api/feed?days=0&mode=foryou").1;
    assert_eq!(feed["hasModel"], true);
    assert_eq!(
        feed["items"][0]["id"], 7,
        "the unseen Rust story should rank first"
    );
    assert!(feed["items"][0]["score"].as_f64().unwrap() > 0.55);

    let explained = get(base, "/api/explain?id=7").1;
    assert!(!explained["contributions"].as_array().unwrap().is_empty());

    // --- explore serves a tiered deck of stories the crowd stopped on ---
    let (status_code, explore) = get(base, "/api/explore?days=0");
    assert_eq!(status_code, 200);
    assert_eq!(explore["hasModel"], true);
    // The client quotes these numbers in its empty state, so they travel with it.
    assert!(explore["bar"]["minPoints"].as_i64().unwrap() > 0);
    assert!(explore["bar"]["minComments"].as_i64().unwrap() > 0);

    // 1-6 are judged; 7 is the loud unjudged one the model warmed to.
    let ids: Vec<i64> = explore["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, vec![7]);
    let card = &explore["items"][0];
    let expected_tier = if card["score"].as_f64().unwrap() >= 0.6 {
        "probably"
    } else {
        "possibly"
    };
    assert_eq!(card["tier"], expected_tier);
    assert!(
        card["points"].as_i64().unwrap() >= explore["bar"]["minPoints"].as_i64().unwrap()
            || card["num_comments"].as_i64().unwrap()
                >= explore["bar"]["minComments"].as_i64().unwrap()
    );

    // The traction bar is the whole point: a story nobody engaged with stays out.
    {
        let conn = server.app.db.lock().unwrap();
        let now = now_seconds();
        upsert_story(
            &conn,
            &story(
                42,
                "Rust ownership, one more time",
                Some("https://rustblog.dev/quiet"),
                Some("rustblog.dev"),
                "u42",
                2,
                1,
                now - 120,
            ),
        );
    }
    assert!(!get(base, "/api/explore?days=0").1["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s["id"] == 42));
    // Later steps count the corpus, so put it back the way it was.
    {
        let conn = server.app.db.lock().unwrap();
        conn.execute("DELETE FROM stories WHERE id = 42", [])
            .unwrap();
    }

    // --- the min-match filter drops weak stories ---
    let all = get(base, "/api/feed?days=0&includeVoted=1").1;
    let strict = get(base, "/api/feed?days=0&includeVoted=1&minScore=0.55").1;
    assert!(strict["total"].as_i64().unwrap() < all["total"].as_i64().unwrap());
    assert!(strict["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["score"].as_f64().unwrap() >= 0.55));

    // --- sync reports its own status without blocking a request ---
    // POST /api/sync would hit the real HN API, so this only pins the contract
    // the UI polls: a status document, idle until something starts a run.
    let (sync_status, sync_body) = get(base, "/api/sync");
    assert_eq!(sync_status, 200);
    assert_eq!(sync_body["running"], false);
    assert_eq!(sync_body["runs"], 0);
    assert!(sync_body["last"].is_null());

    // --- undo removes a vote without retraining ---
    let before = get(base, "/api/stats").1["model"]["rev"].clone();
    let undo = post(base, "/api/unvote", json!({"id": 6}));
    assert_eq!(undo.1["votes"]["down"], 2);
    let stats = get(base, "/api/stats").1;
    assert_eq!(stats["votes"]["total"], 5);
    assert_eq!(
        stats["model"]["rev"], before,
        "the client decides when to retrain"
    );

    // --- training reports need_more_votes instead of failing ---
    // 3 up / 2 down after the undo above: below the minimum.
    assert_eq!(post(base, "/api/train", json!({})).0, 202);
    server.app.trainer.wait_idle();
    let body = get(base, "/api/train").1;
    assert_eq!(body["last"]["trained"], false);
    assert_eq!(body["last"]["reason"], "need_more_votes");
    assert_eq!(body["last"]["need"], json!({"up": 0, "down": 1}));

    // --- an exported vote imports back one at a time, timestamp and all ---
    let exported = get(base, "/api/export").1;
    let votes = exported["votes"].as_array().unwrap();
    assert_eq!(votes.len(), 5);
    assert!(votes[0]["title"].is_string());

    let one = votes.iter().find(|v| v["story_id"] == 1).unwrap().clone();
    post(base, "/api/unvote", json!({"id": 1}));
    assert_eq!(get(base, "/api/stats").1["votes"]["total"], 4);

    let back = post(base, "/api/import/vote", one.clone());
    assert_eq!(back.0, 200);
    assert_eq!(
        back.1["fetched"], false,
        "story 1 is already in the corpus, so no HN lookup"
    );
    assert_eq!(
        back.1["story"]["title"], one["title"],
        "the stored story comes back for eyeballing"
    );
    assert_eq!(get(base, "/api/stats").1["votes"]["total"], 5);
    {
        let conn = server.app.db.lock().unwrap();
        let created: i64 = conn
            .query_row("SELECT created_at FROM votes WHERE story_id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            created,
            one["created_at"].as_i64().unwrap(),
            "the historical vote time is kept, not stamped with now"
        );
    }

    // Re-running the import is idempotent, and the payload stays the authority
    // on when the vote was cast.
    let then = one["created_at"].as_i64().unwrap() - 86400;
    let mut again_payload = one.clone();
    again_payload["created_at"] = json!(then);
    let again = post(base, "/api/import/vote", again_payload);
    assert_eq!(again.0, 200);
    assert_eq!(get(base, "/api/stats").1["votes"]["total"], 5);
    {
        let conn = server.app.db.lock().unwrap();
        let (created, updated): (i64, i64) = conn
            .query_row(
                "SELECT created_at, updated_at FROM votes WHERE story_id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(created, then);
        assert_eq!(
            updated, then,
            "a restored vote is the row as it was, not touched-just-now"
        );
    }

    // The Votes view reads updated_at, so a restored history must read as the day
    // it was cast, not as "a minute ago".
    let listed = get(base, "/api/votes").1;
    let restored = listed["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == 1)
        .unwrap();
    assert_eq!(restored["voted_at"], then);

    // --- the votes list shows every verdict, filterable and paged ---
    // 1,2,3 up and 4,5 down survive the import round-trip above.
    let all_votes = get(base, "/api/votes").1;
    assert_eq!(all_votes["total"], 5);
    assert_eq!(
        all_votes["counts"],
        json!({"up": 3, "down": 2, "skip": 0, "total": 5})
    );
    let listed_ids: Vec<i64> = all_votes["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
    assert_eq!(listed_ids, vec![5, 4, 3, 2, 1], "newest verdict first");
    assert!(all_votes["items"][0]["title"].is_string());
    assert!(all_votes["items"][0]["voted_at"].is_i64());

    let up = get(base, "/api/votes?value=1").1;
    assert_eq!(up["total"], 3);
    assert!(up["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|r| r["vote"] == 1));

    let page = get(base, "/api/votes?limit=2&offset=2").1;
    assert_eq!(
        page["total"], 5,
        "total counts every match, not just the page"
    );
    let page_ids: Vec<i64> = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_i64().unwrap())
        .collect();
    assert_eq!(page_ids, vec![3, 2]);

    assert_eq!(get(base, "/api/votes?value=7").0, 400);

    // --- per-day counts cover the whole corpus with no gaps ---
    let (days_status, days_body) = get(base, "/api/days");
    assert_eq!(days_status, 200);
    assert!(
        days_body["older"].is_null(),
        "nothing in this corpus predates the window"
    );
    let days = days_body["days"].as_array().unwrap();
    assert!(days.len() <= 60, "the chart window is capped");
    let day_re = regex::Regex::new(r"^\d{4}-\d{2}-\d{2}$").unwrap();
    assert!(days
        .iter()
        .all(|d| day_re.is_match(d["day"].as_str().unwrap())));
    let total: i64 = days.iter().map(|d| d["count"].as_i64().unwrap()).sum();
    assert_eq!(total, 7);
    // days are contiguous and sorted: each entry is exactly one day after the previous
    for pair in days.windows(2) {
        let prev = rekorderlig::dates::parse_day(pair[0]["day"].as_str().unwrap()).unwrap();
        let next = rekorderlig::dates::parse_day(pair[1]["day"].as_str().unwrap()).unwrap();
        assert_eq!(next - prev, 86400);
    }
}
