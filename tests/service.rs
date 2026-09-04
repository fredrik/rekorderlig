//! Port of the Node service test suite: training, scoring, the feed, the
//! stratified queue, rounds, Explore, and the two HN sources' sync loop.

mod common;

use std::sync::Mutex;

use common::{seed, story, FakeSource, TempDb};
use rekorderlig::dates::{day_bounds, day_key, now_seconds};
use rekorderlig::db::Db;
use rekorderlig::db::{
    delete_vote, get_meta, record_vote, round_state, set_current_round, upsert_story, User,
};
use rekorderlig::hn::{fetch_day, fetch_story, normalize, sync_days, SyncOptions};
use rekorderlig::http_client::FetchError;
use rekorderlig::model::FitOptions;
use rekorderlig::serde_json::{json, Value};
use rekorderlig::service::{
    backfill, deal_round, explain, explore_queue, feed, judge, load_model, model_history,
    reset_models, round_status, round_summary, score_distribution, score_missing, stats,
    stories_per_day, sync, train_and_score, vote_log, ExploreBar, FeedOptions, ModelCache,
    SyncRequest, EXPLORE, QUEUE_MIN_POINTS, ROUND_SIZE, SCORE_BINS,
};

// Every request is still the owner (docs/multi-user.md, phase 1); the
// two-user cases live in tests/users.rs.
const OWNER: User = User::OWNER;

fn train(conn: &Db, cache: &ModelCache) -> rekorderlig::service::TrainOutcome {
    train_and_score(conn, cache, OWNER, FitOptions::default())
}

fn feed_opts() -> FeedOptions {
    FeedOptions {
        days: 0,
        ..FeedOptions::default()
    }
}

fn queue(
    conn: &Db,
    cache: &ModelCache,
    limit: usize,
    cursor: i64,
) -> Vec<rekorderlig::service::StoryRow> {
    rekorderlig::service::training_queue(conn, cache, OWNER, limit, cursor, QUEUE_MIN_POINTS)
}

#[test]
fn service_train_score_rank_and_explain() {
    let db = TempDb::new("service-train");
    let conn = db.open();
    let cache = ModelCache::default();
    let now = now_seconds();

    seed(&conn);

    // Not enough evidence yet.
    let cold = train(&conn, &cache);
    assert!(!cold.trained());
    assert_eq!(cold.to_json()["reason"], "need_more_votes");

    // The queue falls back to the most discussed stories before any model exists.
    let cold_queue = queue(&conn, &cache, 3, 0);
    assert_eq!(
        cold_queue.iter().map(|s| s.id).collect::<Vec<_>>(),
        vec![8, 4, 5]
    );
    assert!(cold_queue
        .iter()
        .all(|s| s.reason.as_deref() == Some("popular")));

    for id in [1, 2, 3, 7] {
        record_vote(&conn, OWNER, id, 1);
    }
    for id in [4, 5, 6, 8] {
        record_vote(&conn, OWNER, id, -1);
    }

    let trained = train(&conn, &cache);
    assert!(trained.trained());
    assert_eq!(trained.scored(), Some(8));
    let accuracy = trained.metrics().unwrap().accuracy;
    assert!(accuracy >= 0.75, "accuracy {accuracy}");

    // A brand new story is scored the way the votes imply.
    upsert_story(
        &conn,
        &story(
            9,
            "Rust compiler plugins explained",
            Some("https://rustblog.dev/f"),
            Some("rustblog.dev"),
            "u9",
            10,
            10,
            now - 600,
        ),
    );
    assert_eq!(score_missing(&conn, &cache, OWNER), 1);
    let scored: f64 = conn
        .query_one("SELECT score FROM scores WHERE story_id = 9", &[])
        .unwrap()
        .get(0);
    assert!(scored > 0.55, "expected a warm score, got {scored}");

    let ranked = feed(&conn, &cache, OWNER, &feed_opts());
    assert_eq!(
        ranked.items[0].id, 9,
        "the unvoted match should lead the feed"
    );
    assert!(
        ranked
            .items
            .iter()
            .all(|s| s.vote.is_none() || s.vote == Some(0)),
        "judged stories are hidden by default"
    );

    let with_voted = feed(
        &conn,
        &cache,
        OWNER,
        &FeedOptions {
            include_voted: true,
            ..feed_opts()
        },
    );
    assert_eq!(with_voted.total, 9);

    let filtered = feed(
        &conn,
        &cache,
        OWNER,
        &FeedOptions {
            min_score: 0.55,
            include_voted: true,
            ..feed_opts()
        },
    );
    assert!(filtered.total < 9);
    assert!(filtered.items.iter().all(|s| s.score.unwrap() >= 0.55));

    // A score band, as the Brain histogram uses when a bar is clicked: [min, max).
    let band = feed(
        &conn,
        &cache,
        OWNER,
        &FeedOptions {
            include_voted: true,
            min_score: 0.3,
            max_score: 0.55,
            ..feed_opts()
        },
    );
    assert!(band.items.iter().all(|s| {
        let sc = s.score.unwrap();
        sc >= 0.3 && sc < 0.55
    }));
    let below = feed(
        &conn,
        &cache,
        OWNER,
        &FeedOptions {
            include_voted: true,
            max_score: 0.3,
            ..feed_opts()
        },
    );
    let everything = feed(
        &conn,
        &cache,
        OWNER,
        &FeedOptions {
            include_voted: true,
            ..feed_opts()
        },
    );
    assert_eq!(
        band.total + filtered.total + below.total,
        everything.total,
        "bands partition the corpus"
    );

    let top_mode = feed(
        &conn,
        &cache,
        OWNER,
        &FeedOptions {
            mode: "top".into(),
            include_voted: true,
            ..feed_opts()
        },
    );
    assert_eq!(top_mode.items[0].id, 8, "most-commented mode ignores taste");

    let searched = feed(
        &conn,
        &cache,
        OWNER,
        &FeedOptions {
            include_voted: true,
            query: Some("iphone".into()),
            ..feed_opts()
        },
    );
    assert_eq!(searched.total, 2);

    let discussed = feed(
        &conn,
        &cache,
        OWNER,
        &FeedOptions {
            include_voted: true,
            min_comments: 100,
            ..feed_opts()
        },
    );
    assert!(discussed.total > 0);
    assert!(discussed.items.iter().all(|s| s.num_comments >= 100));

    let why = explain(&conn, &cache, OWNER, 9).unwrap();
    let contributions = why["contributions"].as_array().unwrap();
    assert!(!contributions.is_empty());
    assert!(
        contributions.iter().any(|c| {
            let label = c["label"].as_str().unwrap();
            label.contains("rust") || label == "rustblog.dev"
        }),
        "{contributions:?}"
    );

    let s = stats(&conn, &cache, OWNER);
    assert_eq!(s["votes"]["up"], 4);
    assert_eq!(s["votes"]["down"], 4);
    assert!(!s["model"]["insights"]["likes"]
        .as_array()
        .unwrap()
        .is_empty());

    // Score distribution: every scored, unvoted story lands in exactly one bin.
    let d = &s["model"]["distribution"];
    assert_eq!(d["rev"], s["model"]["rev"]);
    assert_eq!(d["bins"].as_array().unwrap().len(), SCORE_BINS);
    let rev = d["rev"].as_i64().unwrap();
    let n_scored: i64 = conn
        .query_one("SELECT COUNT(*) FROM scores WHERE model_rev = $1", &[&rev])
        .unwrap()
        .get(0);
    assert_eq!(
        d["total"].as_i64().unwrap(),
        n_scored - 8,
        "the 8 voted stories are excluded"
    );
    let bin_sum: i64 = d["bins"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_i64().unwrap())
        .sum();
    assert_eq!(bin_sum, d["total"].as_i64().unwrap());
    let top: f64 = conn
        .query_one("SELECT score FROM scores WHERE story_id NOT IN (SELECT story_id FROM votes) ORDER BY score DESC LIMIT 1", &[])
        .unwrap()
        .get(0);
    let top_bin = ((top * SCORE_BINS as f64).floor() as usize).min(SCORE_BINS - 1);
    assert!(d["bins"][top_bin].as_i64().unwrap() > 0);
}

#[test]
fn explore_only_what_the_crowd_stopped_on() {
    let db = TempDb::new("service-explore");
    let conn = db.open();
    let cache = ModelCache::default();
    let now = now_seconds();

    seed(&conn);
    // Two stories nobody engaged with: under both bars, so Explore never offers
    // them however the model feels about the titles.
    upsert_story(
        &conn,
        &story(
            20,
            "A quiet post nobody read",
            Some("https://quiet.dev/a"),
            Some("quiet.dev"),
            "u20",
            4,
            4,
            now - 3600,
        ),
    );
    upsert_story(
        &conn,
        &story(
            21,
            "Another Rust post nobody read",
            Some("https://rustblog.dev/quiet"),
            Some("rustblog.dev"),
            "u21",
            3,
            3,
            now - 3600,
        ),
    );

    // Before any model there is nothing to tier by, so the deck is pure crowd:
    // most discussed first, everything in the "possibly" tier.
    let cold = explore_queue(&conn, &cache, OWNER, 10, 0, &EXPLORE);
    assert_eq!(
        cold.iter().map(|s| s.id).collect::<Vec<_>>(),
        vec![8, 4, 5, 6, 1, 2, 3, 7]
    );
    assert!(cold.iter().all(|s| s.tier.as_deref() == Some("possibly")));

    for id in [1, 2, 3, 7] {
        record_vote(&conn, OWNER, id, 1);
    }
    for id in [4, 5, 6, 8] {
        record_vote(&conn, OWNER, id, -1);
    }
    train(&conn, &cache);

    // Two loud unjudged stories: one the model should warm to, one it should not.
    upsert_story(
        &conn,
        &story(
            30,
            "Rust compiler plugins explained",
            Some("https://rustblog.dev/f"),
            Some("rustblog.dev"),
            "u30",
            300,
            300,
            now - 1800,
        ),
    );
    upsert_story(
        &conn,
        &story(
            31,
            "Apple iPhone event recap",
            Some("https://theverge.com/z"),
            Some("theverge.com"),
            "u31",
            900,
            900,
            now - 1800,
        ),
    );
    score_missing(&conn, &cache, OWNER);

    let deck = explore_queue(&conn, &cache, OWNER, 10, 0, &EXPLORE);
    let ids: Vec<i64> = deck.iter().map(|s| s.id).collect();
    assert!(
        !ids.iter().any(|id| (1..=8).contains(id)),
        "judged stories are gone"
    );
    assert!(
        !ids.contains(&20) && !ids.contains(&21),
        "the quiet tail never gets in"
    );
    assert_eq!(
        ids[0], 30,
        "the match leads, even though 31 is the more discussed story"
    );
    assert_eq!(deck[0].tier.as_deref(), Some("probably"));
    assert!(deck[0].score.unwrap() >= EXPLORE.probably_score);
    // 31 is loud but the model reads it as a clear no, so it is dropped, not demoted.
    assert!(
        !ids.contains(&31),
        "expected 31 to be filtered, got {deck:?}"
    );

    // Tiers are a cut on the score, and every card clears one of the two bars.
    for s in &deck {
        let expected = if s.score.unwrap() >= EXPLORE.probably_score {
            "probably"
        } else {
            "possibly"
        };
        assert_eq!(s.tier.as_deref(), Some(expected));
        assert!(s.score.unwrap() >= EXPLORE.possibly_score);
        assert!(s.points >= EXPLORE.min_points || s.num_comments >= EXPLORE.min_comments);
    }

    // A skip is a judgement too: skipped stories don't come back.
    record_vote(&conn, OWNER, 30, 0);
    assert!(!explore_queue(&conn, &cache, OWNER, 10, 0, &EXPLORE)
        .iter()
        .any(|s| s.id == 30));

    // The window is a real filter: nothing in the corpus is outside 30 days.
    let low_bar = ExploreBar {
        min_points: 1,
        min_comments: 1,
        ..EXPLORE
    };
    assert!(!explore_queue(&conn, &cache, OWNER, 10, 0, &low_bar).is_empty());
    let old = explore_queue(&conn, &cache, OWNER, 10, 30, &EXPLORE);
    assert!(old.iter().all(|s| s.created_at >= now - 30 * 86400));
}

#[test]
fn the_feed_never_shows_unscored_stories() {
    let db = TempDb::new("service-unscored");
    let conn = db.open();
    let cache = ModelCache::default();
    let now = now_seconds();

    seed(&conn);
    // Before any model nothing is scored, so the feed is empty.
    assert_eq!(feed(&conn, &cache, OWNER, &feed_opts()).total, 0);

    for id in [1, 2, 3] {
        record_vote(&conn, OWNER, id, 1);
    }
    for id in [4, 5, 6] {
        record_vote(&conn, OWNER, id, -1);
    }
    train(&conn, &cache);

    // A story that arrives after training has no score row yet.
    upsert_story(
        &conn,
        &story(
            99,
            "Freshly fetched, not yet scored",
            Some("https://x.dev/z"),
            Some("x.dev"),
            "u99",
            10,
            10,
            now,
        ),
    );
    for mode in ["foryou", "hybrid", "top", "new"] {
        let ids: Vec<i64> = feed(
            &conn,
            &cache,
            OWNER,
            &FeedOptions {
                mode: mode.into(),
                include_voted: true,
                ..feed_opts()
            },
        )
        .items
        .iter()
        .map(|s| s.id)
        .collect();
        assert!(!ids.contains(&99), "{mode} leaked an unscored story");
    }
    assert!(!feed(
        &conn,
        &cache,
        OWNER,
        &FeedOptions {
            min_score: 0.4,
            max_score: 0.6,
            ..feed_opts()
        }
    )
    .items
    .iter()
    .any(|s| s.id == 99));

    score_missing(&conn, &cache, OWNER);
    assert!(
        feed(
            &conn,
            &cache,
            OWNER,
            &FeedOptions {
                mode: "new".into(),
                ..feed_opts()
            }
        )
        .items
        .iter()
        .any(|s| s.id == 99),
        "shows once scored"
    );
}

#[test]
fn score_distribution_is_null_before_the_first_model() {
    let db = TempDb::new("service-dist");
    let conn = db.open();
    let cache = ModelCache::default();
    seed(&conn);
    assert!(score_distribution(&conn, &cache, OWNER).is_none());
}

#[test]
fn training_queue_prefers_titles_the_model_is_unsure_about() {
    let db = TempDb::new("service-queue-unsure");
    let conn = db.open();
    let cache = ModelCache::default();

    seed(&conn);
    for id in [1, 2, 3] {
        record_vote(&conn, OWNER, id, 1);
    }
    for id in [4, 5, 6] {
        record_vote(&conn, OWNER, id, -1);
    }
    train(&conn, &cache);

    // Two unjudged stories remain: a clear Rust match and a clear Apple mismatch.
    let deck = queue(&conn, &cache, 2, 0);
    assert_eq!(deck.len(), 2, "both are offered");
    assert!(
        deck.iter().all(|s| s.reason.is_some()),
        "every card says which stratum drew it"
    );
}

#[test]
fn hn_day_helpers_and_hit_normalisation() {
    assert_eq!(day_key(1755993599), "2025-08-23");
    assert_eq!(day_bounds("2025-08-23"), Ok((1755907200, 1755993600)));

    let s = normalize(
        &json!({
            "objectID": "42", "title": "  Hello  ", "url": "https://Example.com/x",
            "author": "ada", "points": 7, "num_comments": 3, "created_at_i": 1755993500,
        }),
        999,
    )
    .unwrap();
    let expected = rekorderlig::db::Story {
        fetched_at: 999,
        ..story(
            42,
            "Hello",
            Some("https://Example.com/x"),
            Some("example.com"),
            "ada",
            7,
            3,
            1755993500,
        )
    };
    assert_eq!(s, expected);
    assert_eq!(s.day, "2025-08-23");
    assert!(
        normalize(&json!({"objectID": "1"}), 999).is_none(),
        "a hit without a title is dropped"
    );
}

#[test]
fn hn_sync_upserts_and_keeps_the_highest_counts() {
    let db = TempDb::new("service-sync-upsert");
    let conn = db.open();
    let cache = ModelCache::default();
    let now = now_seconds();

    let hit = move |points: i64, comments: i64| {
        normalize(
            &json!({
                "objectID": "100", "title": "Same story", "url": "https://a.dev/x",
                "author": "ada", "points": points, "num_comments": comments, "created_at_i": now,
            }),
            now,
        )
        .unwrap()
    };
    let source = FakeSource {
        day: |_day: &str, _pages, _min| Ok(vec![hit(10, 5)]),
        front_page: || Ok(vec![hit(99, 88)]),
    };

    let req = SyncRequest {
        days: Some(2),
        options: Some(SyncOptions {
            throttle_ms: 0,
            ..SyncOptions::default()
        }),
        ..SyncRequest::default()
    };
    let result = sync(&conn, &cache, &req, &source, &mut |_| {}).unwrap();
    assert_eq!(result.fetched, 3, "two days plus the front page");
    assert_eq!(
        result.front_page,
        Some(1),
        "today is in the window, so the front page is fetched"
    );
    assert_eq!(
        result.inserted, 1,
        "the same story id is upserted, not duplicated"
    );

    let (points, comments): (i64, i64) = {
        let r = conn
            .query_one(
                "SELECT points, num_comments FROM stories WHERE id = 100",
                &[],
            )
            .unwrap();
        (r.get(0), r.get(1))
    };
    assert_eq!((points, comments), (99, 88));
    let s = stats(&conn, &cache, OWNER);
    assert!(
        s["lastSyncAt"].as_i64().unwrap() > 0,
        "a sync stamps when data was last fetched"
    );
}

#[test]
fn hn_sync_only_asks_for_the_front_page_when_today_is_in_range() {
    let db = TempDb::new("service-sync-frontpage");
    let conn = db.open();
    let cache = ModelCache::default();

    let front_pages = Mutex::new(0);
    let source = FakeSource {
        day: |_: &str, _, _| Ok(vec![]),
        front_page: || {
            *front_pages.lock().unwrap() += 1;
            Ok(vec![])
        },
    };
    let quiet = SyncOptions {
        throttle_ms: 0,
        ..SyncOptions::default()
    };
    let past = sync(
        &conn,
        &cache,
        &SyncRequest {
            from: Some("2026-01-01".into()),
            to: Some("2026-01-02".into()),
            options: Some(quiet),
            ..SyncRequest::default()
        },
        &source,
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(past.front_page, Some(0));
    assert_eq!(
        *front_pages.lock().unwrap(),
        0,
        "an archive fill has nothing to learn from the current front page"
    );

    sync(
        &conn,
        &cache,
        &SyncRequest {
            days: Some(1),
            options: Some(quiet),
            ..SyncRequest::default()
        },
        &source,
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(*front_pages.lock().unwrap(), 1);
}

#[test]
fn hn_a_points_floor_is_pushed_down_into_the_api_query() {
    let urls: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let fetch = |url: &str| -> Result<Value, FetchError> {
        urls.lock().unwrap().push(url.to_string());
        Ok(json!({"hits": [], "nbPages": 1}))
    };

    fetch_day(&fetch, "2026-01-05", 1, 3).unwrap();
    {
        let urls = urls.lock().unwrap();
        assert!(
            urls[0].contains("numericFilters=created_at_i>=") && urls[0].contains(",points>=3&"),
            "{}",
            urls[0]
        );
    }
    fetch_day(&fetch, "2026-01-05", 1, 0).unwrap();
    assert!(
        !urls.lock().unwrap()[1].contains("points"),
        "no floor, no filter"
    );

    // sync filters by default; --points 0 turns it off.
    let db = TempDb::new("service-points-floor");
    let conn = db.open();
    let cache = ModelCache::default();
    let seen: Mutex<Vec<i64>> = Mutex::new(Vec::new());
    let source = FakeSource {
        day: |_: &str, _pages, min_points| {
            seen.lock().unwrap().push(min_points);
            Ok(vec![])
        },
        front_page: || Ok(vec![]),
    };
    let quiet = SyncOptions {
        throttle_ms: 0,
        ..SyncOptions::default()
    };
    sync(
        &conn,
        &cache,
        &SyncRequest {
            days: Some(1),
            options: Some(quiet),
            ..SyncRequest::default()
        },
        &source,
        &mut |_| {},
    )
    .unwrap();
    sync(
        &conn,
        &cache,
        &SyncRequest {
            from: Some("2026-01-01".into()),
            to: Some("2026-01-01".into()),
            options: Some(quiet),
            ..SyncRequest::default()
        },
        &source,
        &mut |_| {},
    )
    .unwrap();
    sync(
        &conn,
        &cache,
        &SyncRequest {
            from: Some("2026-01-01".into()),
            to: Some("2026-01-01".into()),
            options: Some(SyncOptions {
                min_points: 0,
                throttle_ms: 0,
                ..SyncOptions::default()
            }),
            ..SyncRequest::default()
        },
        &source,
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(*seen.lock().unwrap(), vec![3, 3, 0]);
}

#[test]
fn hn_sync_days_records_a_failing_day_and_fills_the_gap_on_a_rerun() {
    let db = TempDb::new("service-sync-fail");
    let conn = db.open();
    let now = now_seconds();

    let asked: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let one_story = move |day: &str| -> rekorderlig::db::Story {
        let (start, _) = day_bounds(day).unwrap();
        normalize(
            &json!({"objectID": start.to_string(), "title": format!("Top of {day}"),
                    "url": format!("https://b.dev/{day}"), "author": "ada",
                    "points": 10, "num_comments": 5, "created_at_i": start}),
            now,
        )
        .unwrap()
    };
    let source = FakeSource {
        day: |day: &str, _, _| {
            asked.lock().unwrap().push(day.to_string());
            if day == "2026-01-03" {
                return Err(FetchError {
                    message: "HTTP 503".into(),
                });
            }
            Ok(vec![one_story(day)])
        },
        front_page: || Ok(vec![]),
    };

    let range = rekorderlig::dates::days_between("2026-01-01", "2026-01-04").unwrap();
    let opts = SyncOptions {
        throttle_ms: 0,
        ..SyncOptions::default()
    };
    let run = sync_days(&conn, &range, &opts, &source, &mut |_| {});
    assert_eq!(
        *asked.lock().unwrap(),
        range,
        "every day in the range is requested"
    );
    assert_eq!(run.days, 4);
    assert_eq!(run.fetched_days, 3);
    assert_eq!(run.inserted, 3);
    assert_eq!(
        run.failures
            .iter()
            .map(|f| f.day.clone())
            .collect::<Vec<_>>(),
        vec!["2026-01-03".to_string()],
        "a failing day is recorded, not fatal"
    );

    // Rerunning the same range retries the day that failed along with the rest.
    asked.lock().unwrap().clear();
    let source = FakeSource {
        day: |day: &str, _, _| {
            asked.lock().unwrap().push(day.to_string());
            let (start, _) = day_bounds(day).unwrap();
            Ok((0..100)
                .map(|i| {
                    normalize(
                        &json!({"objectID": (start + i).to_string(), "title": format!("Top {i} of {day}"),
                                "url": format!("https://b.dev/{day}/{i}"), "author": "ada",
                                "points": 10, "num_comments": 5, "created_at_i": start + i}),
                        now,
                    )
                    .unwrap()
                })
                .collect())
        },
        front_page: || Ok(vec![]),
    };
    let rerun = sync_days(&conn, &range, &opts, &source, &mut |_| {});
    assert_eq!(*asked.lock().unwrap(), range, "the failed gap is filled");
    assert_eq!(rerun.failures.len(), 0);
    let n: i64 = conn
        .query_one("SELECT COUNT(*) FROM stories WHERE day = '2026-01-03'", &[])
        .unwrap()
        .get(0);
    assert_eq!(n, 100);
}

#[test]
fn hn_a_day_already_holding_stories_is_refetched_anyway() {
    let db = TempDb::new("service-sync-covered");
    let conn = db.open();
    let now = now_seconds();

    // A densely covered day used to be skipped; now nothing is.
    let (start, _) = day_bounds("2026-01-02").unwrap();
    for i in 0..100 {
        upsert_story(
            &conn,
            &rekorderlig::db::Story {
                day: "2026-01-02".into(),
                ..story(
                    1000 + i,
                    &format!("Old story {i}"),
                    Some(&format!("https://a.dev/{i}")),
                    Some("a.dev"),
                    "ada",
                    i,
                    i,
                    start + i,
                )
            },
        );
    }
    let _ = now;

    let asked: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let source = FakeSource {
        day: |day: &str, _, _| {
            asked.lock().unwrap().push(day.to_string());
            Ok(vec![])
        },
        front_page: || Ok(vec![]),
    };
    let run = sync_days(
        &conn,
        &["2026-01-01".to_string(), "2026-01-02".to_string()],
        &SyncOptions {
            throttle_ms: 0,
            ..SyncOptions::default()
        },
        &source,
        &mut |_| {},
    );
    assert_eq!(
        *asked.lock().unwrap(),
        vec!["2026-01-01", "2026-01-02"],
        "the covered day is requested too"
    );
    assert_eq!(run.fetched_days, 2);
    assert_eq!(run.failures.len(), 0);
}

#[test]
fn hn_sync_days_asks_for_10_pages_a_day_by_default() {
    let db = TempDb::new("service-sync-pages");
    let conn = db.open();

    let seen: Mutex<Vec<(u32, i64)>> = Mutex::new(Vec::new());
    let source = FakeSource {
        day: |_: &str, pages, min_points| {
            seen.lock().unwrap().push((pages, min_points));
            Ok(vec![])
        },
        front_page: || Ok(vec![]),
    };
    sync_days(
        &conn,
        &["2026-01-01".to_string()],
        &SyncOptions {
            throttle_ms: 0,
            ..SyncOptions::default()
        },
        &source,
        &mut |_| {},
    );
    assert_eq!(
        seen.lock().unwrap()[0],
        (10, 3),
        "10 pages, and the points floor is unchanged"
    );

    // fetch_day stops at the last page, so a quiet day costs less than the ceiling.
    let urls: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let fetch = |url: &str| -> Result<Value, FetchError> {
        urls.lock().unwrap().push(url.to_string());
        Ok(json!({"hits": [], "nbPages": 1}))
    };
    fetch_day(&fetch, "2026-01-01", 10, 0).unwrap();
    assert_eq!(urls.lock().unwrap().len(), 1);
}

#[test]
fn hn_reposts_a_vote_binds_to_the_submission_it_was_cast_on() {
    let db = TempDb::new("service-reposts");
    let conn = db.open();
    let cache = ModelCache::default();
    let now = now_seconds();

    seed(&conn);
    let twin = |id: i64, comments: i64| {
        story(
            id,
            "Making LEDs at Home [video]",
            Some("https://youtube.com/watch?v=x"),
            Some("youtube.com"),
            &format!("u{id}"),
            comments,
            comments,
            now - 100,
        )
    };
    upsert_story(&conn, &twin(100, 50));
    upsert_story(&conn, &twin(101, 15));

    record_vote(&conn, OWNER, 100, -1);
    let votes: Vec<(i64, i64)> = conn
        .query("SELECT story_id, value FROM votes ORDER BY story_id", &[])
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    assert_eq!(votes, vec![(100, -1)], "the same-URL twin is not co-signed");

    // 101 is still unjudged, so it stays in the deck — re-judging a repost is fine.
    let deck = queue(&conn, &cache, 50, 0);
    assert!(
        !deck.iter().any(|s| s.id == 100),
        "the judged submission is gone"
    );
    assert!(
        deck.iter().any(|s| s.id == 101),
        "the unjudged twin is still offered"
    );

    delete_vote(&conn, OWNER, 100);
    let n: i64 = conn
        .query_one("SELECT COUNT(*) FROM votes", &[])
        .unwrap()
        .get(0);
    assert_eq!(n, 0, "undo clears the vote");
}

#[test]
fn fetching_a_repost_after_the_vote_writes_no_vote_for_it() {
    let db = TempDb::new("service-repost-fetch");
    let conn = db.open();
    let now = now_seconds();

    seed(&conn);
    upsert_story(
        &conn,
        &story(
            400,
            "Stop Making TUIs",
            Some("https://sockpuppet.org/blog/tuis/"),
            Some("sockpuppet.org"),
            "u400",
            500,
            500,
            now - 200,
        ),
    );
    record_vote(&conn, OWNER, 400, 1);

    // The twin lands on a later sync — the old propagation-at-vote-time never
    // caught this case, which is how unjudged duplicates piled up in prod.
    upsert_story(
        &conn,
        &story(
            401,
            "Stop Making TUIs",
            Some("https://sockpuppet.org/blog/tuis/"),
            Some("sockpuppet.org"),
            "u401",
            1,
            1,
            now - 100,
        ),
    );

    // The late twin may be offered again — re-judging a repost is accepted. What
    // must not happen is a vote appearing for it that was never cast.
    let n: i64 = conn
        .query_one("SELECT COUNT(*) FROM votes", &[])
        .unwrap()
        .get(0);
    assert_eq!(n, 1, "fetching a twin writes no phantom vote");
    let n401: i64 = conn
        .query_one("SELECT COUNT(*) FROM votes WHERE story_id = 401", &[])
        .unwrap()
        .get(0);
    assert_eq!(n401, 0);
}

#[test]
fn stories_per_day_window_ignores_stray_ancient_stories() {
    let db = TempDb::new("service-days-window");
    let conn = db.open();
    let now = now_seconds();

    seed(&conn); // 8 stories within the last few hours
                 // A repost carrying a created_at from ~200 days ago must not stretch the
                 // chart into months of empty days — it is summarised, not drawn.
    let ancient = now - 200 * 86400;
    upsert_story(
        &conn,
        &story(
            300,
            "A story from another era",
            Some("https://old.dev/a"),
            Some("old.dev"),
            "u300",
            1,
            1,
            ancient,
        ),
    );

    let out = stories_per_day(&conn, 60);
    let days = out["days"].as_array().unwrap();
    assert!(days.len() <= 60, "window capped, got {} days", days.len());
    let total: i64 = days.iter().map(|d| d["count"].as_i64().unwrap()).sum();
    assert_eq!(total, 8, "only in-window stories are drawn");
    assert_eq!(
        out["older"],
        json!({"days": 1, "stories": 1, "before": days[0]["day"]})
    );
    for pair in days.windows(2) {
        let a = rekorderlig::dates::parse_day(pair[0]["day"].as_str().unwrap()).unwrap();
        let b = rekorderlig::dates::parse_day(pair[1]["day"].as_str().unwrap()).unwrap();
        assert_eq!(b - a, 86400);
    }
}

#[test]
fn a_repost_judged_separately_is_its_own_training_example() {
    let db = TempDb::new("service-repost-example");
    let conn = db.open();
    let cache = ModelCache::default();
    let now = now_seconds();

    seed(&conn);
    for id in [1, 2, 3] {
        record_vote(&conn, OWNER, id, 1);
    }
    for id in [4, 5, 6] {
        record_vote(&conn, OWNER, id, -1);
    }
    // a repost of story 1's title, judged separately
    upsert_story(
        &conn,
        &story(
            200,
            "Rust borrow checker internals",
            Some("https://mirror.dev/a"),
            Some("mirror.dev"),
            "u200",
            1,
            1,
            now - 50,
        ),
    );
    record_vote(&conn, OWNER, 200, 1);

    let result = train(&conn, &cache);
    assert!(result.trained());
    assert_eq!(
        result.metrics().unwrap().n,
        7,
        "seven votes, seven examples — repeats are signal, not noise"
    );
}

#[test]
fn feed_counts_and_orders_the_whole_corpus_not_a_fixed_candidate_window() {
    let db = TempDb::new("service-corpus");
    let conn = db.open();
    let cache = ModelCache::default();
    let now = now_seconds();

    // Well past the old 6000-row cap. Like real HN, higher ids are newer, and
    // the very newest story is also the most discussed.
    let n = 6500_i64;
    conn.begin();
    for i in 1..=n {
        let created = now - (n - i) * 30;
        let loud = i == n;
        upsert_story(
            &conn,
            &story(
                i,
                &format!("Story number {i}"),
                Some(&format!("https://s.dev/{i}")),
                Some("s.dev"),
                "ada",
                if loud { 9999 } else { i % 100 },
                if loud { 9999 } else { i % 100 },
                created,
            ),
        );
    }
    conn.commit();

    // The feed only lists scored stories, so give it a model. Titles are all
    // alike, so every score sits near 0.5 and ordering stays crowd-driven.
    for id in [1, 2, 3] {
        record_vote(&conn, OWNER, id, 1);
    }
    for id in [4, 5, 6] {
        record_vote(&conn, OWNER, id, -1);
    }
    train(&conn, &cache);

    let newest = feed(
        &conn,
        &cache,
        OWNER,
        &FeedOptions {
            mode: "new".into(),
            include_voted: true,
            limit: 3,
            ..feed_opts()
        },
    );
    assert_eq!(newest.total, n, "total is the real count");
    assert_eq!(newest.items[0].id, n, "the newest story leads");

    let top = feed(
        &conn,
        &cache,
        OWNER,
        &FeedOptions {
            mode: "top".into(),
            limit: 1,
            ..feed_opts()
        },
    );
    assert_eq!(top.items[0].id, n);

    let page2 = feed(
        &conn,
        &cache,
        OWNER,
        &FeedOptions {
            mode: "new".into(),
            limit: 50,
            offset: 50,
            ..feed_opts()
        },
    );
    assert_eq!(page2.items.len(), 50);
    assert_eq!(
        page2.items[0].id,
        n - 50,
        "offset pages continue the same order"
    );

    let hybrid = feed(
        &conn,
        &cache,
        OWNER,
        &FeedOptions {
            mode: "hybrid".into(),
            include_voted: true,
            limit: 1,
            ..feed_opts()
        },
    );
    assert_eq!(hybrid.total, n);
    assert_eq!(
        hybrid.items[0].id, n,
        "with flat scores, blend is driven by the crowd"
    );

    // The queue is no longer a newest-first window either: it samples strata
    // across the whole archive, so a 40-card deck reaches stories thousands of
    // rows behind the newest as well as the day's most discussed.
    let deck = queue(&conn, &cache, 40, 0);
    assert_eq!(deck.len(), 40);
    assert!(
        deck.iter().any(|s| s.id < n - 3000),
        "the deck reaches deep into the archive"
    );
    assert!(
        deck.iter().any(|s| s.reason.as_deref() == Some("recent")),
        "and still shows the day"
    );
    assert!(
        deck.iter().all(|s| s.points >= 10),
        "nothing below the points floor"
    );
}

#[test]
fn hn_a_single_story_is_looked_up_by_id_narrowed_to_the_submission_itself() {
    let urls: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let fetch = |url: &str| -> Result<Value, FetchError> {
        urls.lock().unwrap().push(url.to_string());
        Ok(json!({
            "hits": [{
                "objectID": "49321298", "title": "Being ambitious and being a dad",
                "url": "https://nicholascharriere.com/blog/being-ambitious-and-being-a-dad/",
                "author": "nc", "points": 42, "num_comments": 7, "created_at_i": 1787574000,
            }],
        }))
    };

    let s = fetch_story(&fetch, 49321298).unwrap().unwrap();
    assert!(urls.lock().unwrap()[0].ends_with("tags=story,story_49321298&hitsPerPage=1"));
    assert_eq!(s.id, 49321298);
    assert_eq!(s.domain.as_deref(), Some("nicholascharriere.com"));
    assert_eq!(s.day, "2026-08-24");

    // A comment id (or a dead one) matches nothing under the `story` tag.
    let empty = |_: &str| -> Result<Value, FetchError> { Ok(json!({"hits": []})) };
    assert!(fetch_story(&empty, 1).unwrap().is_none());
}

#[test]
fn held_out_predictions_are_stored_per_vote_apart_from_the_memorised_score() {
    let db = TempDb::new("service-oof");
    let conn = db.open();
    let cache = ModelCache::default();

    seed(&conn);
    for id in [1, 2, 3, 7] {
        record_vote(&conn, OWNER, id, 1);
    }
    for id in [4, 5, 6, 8] {
        record_vote(&conn, OWNER, id, -1);
    }

    let trained = train(&conn, &cache);
    assert!(trained.trained());
    let rev = trained.rev().unwrap();

    // One row per vote, and every one a real probability.
    let oof: Vec<(i64, f64, i64)> = conn
        .query(
            "SELECT story_id, score, model_rev FROM oof_scores ORDER BY story_id",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();
    assert_eq!(oof.len(), 8);
    assert!(oof
        .iter()
        .all(|(_, s, r)| (0.0..=1.0).contains(s) && *r == rev));

    // The point of the table: a held-out score is a different number from the
    // memorised one. Trained on its own examples the model is near-perfect, so
    // if these matched, the Votes view's flag could never fire.
    let stored: std::collections::HashMap<i64, f64> = conn
        .query("SELECT story_id, score FROM scores", &[])
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    assert!(
        oof.iter().any(|(id, s, _)| (s - stored[id]).abs() > 0.01),
        "held-out scores should differ from the training-set scores"
    );

    // The vote list serves it alongside the memorised score, not instead of it.
    let log = vote_log(&conn, OWNER, None, 50, 0);
    assert_eq!(log.items.len(), 8);
    assert!(log.items.iter().all(|i| i.oof_score.is_some()));

    // held-out rows are one per vote; they belong in the table, not in every
    // serialised snapshot or in the stats payload.
    let payload: String = conn
        .query_one("SELECT payload FROM models ORDER BY rev DESC LIMIT 1", &[])
        .unwrap()
        .get(0);
    let payload: Value = rekorderlig::serde_json::from_str(&payload).unwrap();
    assert!(payload["metrics"]["heldOut"].is_null());
    assert!(stats(&conn, &cache, OWNER)["model"]["metrics"]["heldOut"].is_null());

    // A removed vote must not leave a stale prediction behind.
    delete_vote(&conn, OWNER, 7);
    train(&conn, &cache);
    let n: i64 = conn
        .query_one("SELECT COUNT(*) FROM oof_scores", &[])
        .unwrap()
        .get(0);
    assert_eq!(n, 7);
    let n7: i64 = conn
        .query_one("SELECT COUNT(*) FROM oof_scores WHERE story_id = 7", &[])
        .unwrap()
        .get(0);
    assert_eq!(n7, 0);
}

#[test]
fn the_training_queue_samples_strata_across_a_multi_year_archive() {
    let db = TempDb::new("service-multiyear");
    let conn = db.open();
    let cache = ModelCache::default();
    let now = now_seconds();

    // Three years of history, ~8 stories a day, ids climbing with time like HN's.
    // Half the corpus sits under the points floor, so the floor has to bite.
    let days = 1100_i64;
    let per_day = 8_i64;
    let words = [
        "rust", "compiler", "apple", "iphone", "kernel", "startup", "physics", "sqlite",
    ];
    let mut id = 0_i64;
    conn.begin();
    for d in (1..=days).rev() {
        for k in 0..per_day {
            id += 1;
            let created = now - d * 86400 + k * 3600;
            upsert_story(
                &conn,
                &story(
                    id,
                    &format!(
                        "{} {} notes {id}",
                        words[(id % 8) as usize],
                        words[((id * 7) % 8) as usize]
                    ),
                    Some(&format!("https://s.dev/{id}")),
                    Some(&format!("d{}.dev", id % 40)),
                    &format!("u{}", id % 50),
                    if id % 2 == 1 { 40 } else { 2 },
                    id % 37,
                    created,
                ),
            );
        }
    }
    // A handful of stories from the last three days, so `recent` has something.
    for k in 0..20 {
        id += 1;
        let created = now - 3600 * (k + 1);
        upsert_story(
            &conn,
            &story(
                id,
                &format!("rust today {id}"),
                Some(&format!("https://s.dev/{id}")),
                Some("today.dev"),
                "ada",
                80,
                200 + k,
                created,
            ),
        );
    }
    conn.commit();

    for i in (1..=11).step_by(2) {
        record_vote(&conn, OWNER, i, if i % 3 != 0 { 1 } else { -1 });
    }
    for i in (2..=12).step_by(2) {
        record_vote(&conn, OWNER, i, -1);
    }
    train(&conn, &cache);

    let deck = queue(&conn, &cache, 40, 0);
    assert_eq!(deck.len(), 40, "a full deck");
    assert!(
        deck.iter().all(|s| s.points >= 10),
        "the points floor holds"
    );
    let unique: std::collections::HashSet<i64> = deck.iter().map(|s| s.id).collect();
    assert_eq!(unique.len(), 40, "no story twice");

    // The complaint that started this: a deck that only ever shows the newest
    // days. Stratified sampling has to span years, not a trailing window.
    let newest = deck.iter().map(|s| s.created_at).max().unwrap();
    let oldest = deck.iter().map(|s| s.created_at).min().unwrap();
    let span_days = (newest - oldest) / 86400;
    assert!(span_days > 365, "deck spans {span_days} days of history");
    let distinct_days: std::collections::HashSet<&str> =
        deck.iter().map(|s| s.day.as_str()).collect();
    assert!(
        distinct_days.len() >= 20,
        "{} distinct days in a 40-card deck",
        distinct_days.len()
    );

    // Every stratum contributes, and `recent` really is recent.
    let mut mix: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for s in &deck {
        *mix.entry(s.reason.as_deref().unwrap()).or_insert(0) += 1;
    }
    for reason in ["boundary", "novel", "recent", "explore"] {
        assert!(
            mix.get(reason).copied().unwrap_or(0) > 0,
            "{reason} drew nothing (mix {mix:?})"
        );
    }
    assert!(
        deck.iter()
            .filter(|s| s.reason.as_deref() == Some("recent"))
            .all(|s| s.created_at >= now - 4 * 86400),
        "the recent slots stay inside the recent window"
    );

    // Deterministic: the same revision and cursor must redraw the same deck, or
    // a refill would reshuffle the cards behind the one being judged.
    assert_eq!(
        queue(&conn, &cache, 40, 0)
            .iter()
            .map(|s| s.id)
            .collect::<Vec<_>>(),
        deck.iter().map(|s| s.id).collect::<Vec<_>>(),
        "same rev, same cursor, same deck"
    );
    let next = queue(&conn, &cache, 40, 1);
    let overlap = next.iter().filter(|s| unique.contains(&s.id)).count();
    assert!(
        overlap < 20,
        "cursor 1 moves the deck on ({overlap}/40 repeated)"
    );
}

#[test]
fn the_queue_seeks_the_score_axis_instead_of_scanning_it() {
    let db = TempDb::new("service-plan");
    let conn = db.open();

    // The whole multi-year claim rests on the boundary draw being an index seek.
    // A regression to a full scan of `scores` would still pass every other test
    // here and only show up as a slow app against a real archive.
    //
    // Unlike SQLite, Postgres decides this on statistics, so the table has to
    // hold enough rows for a seek to be the cheaper plan and ANALYZE has to
    // have seen them. Twenty thousand is plenty and costs a few hundred ms.
    conn.execute_batch(
        "INSERT INTO stories (id, title, url, domain, author, points, num_comments,
                              created_at, day, fetched_at)
         SELECT g, 'story ' || g, NULL, NULL, NULL, 50, 5, 0, '2026-01-01', 0
         FROM generate_series(1, 20000) g;
         INSERT INTO scores (user_id, story_id, score, confidence, model_rev)
         SELECT 1, g, 0.5 + ((g % 1000) - 500) / 1000.0, 0.4 + (g % 60) / 100.0, 1
         FROM generate_series(1, 20000) g;
         ANALYZE stories; ANALYZE scores; ANALYZE votes;",
    )
    .unwrap();

    // Character-identical to RAW_OFFSET in service.rs and to the expression
    // db.rs builds the index on. Drop the `::double precision` casts and the
    // literals become `numeric`, the expressions stop matching, and the
    // planner quietly falls back to a scan — which is the exact regression
    // this test exists to catch.
    let raw_offset = "((sc.score - 0.5::double precision) / (0.3::double precision + 0.7::double precision * sc.confidence))";
    // The anti-join is part of what is being tested, not incidental. Spelled
    // as `LEFT JOIN votes ... WHERE v.value IS NULL` this same query plans as
    // a sequential scan of `stories`: `votes.value` is NOT NULL, so the
    // planner's null fraction is zero, it estimates one row out of the join,
    // and every plan then looks equally cheap. See UNJUDGED in service.rs.
    //
    // `sc.user_id = $1` is part of it too. The index leads with user_id, and a
    // `(user_id, expr)` index is only opened when the query pins the user
    // *and* ranges on the expression — a probe that forgets the user seeks
    // nothing and this test is what says so.
    let plan: Vec<String> = conn
        .query(
            &format!(
                "EXPLAIN
                 SELECT s.id FROM scores sc
                 JOIN stories s ON s.id = sc.story_id
                 WHERE sc.user_id = $1 AND {raw_offset} >= $2 AND {raw_offset} <= $3
                   AND sc.confidence >= $4 AND s.points >= $5
                   AND NOT EXISTS (SELECT 1 FROM votes v WHERE v.user_id = $1 AND v.story_id = s.id)
                 ORDER BY {raw_offset}, s.id
                 LIMIT 1"
            ),
            &[&OWNER, &-0.15_f64, &0.15_f64, &0.4_f64, &10_i64],
        )
        .unwrap()
        .iter()
        .map(|r| r.get::<_, String>(0))
        .collect();
    let plan = plan.join(" | ");
    assert!(plan.contains("idx_scores_raw_offset"), "plan was: {plan}");
    assert!(!plan.contains("Seq Scan on scores"), "plan was: {plan}");
}

#[test]
fn a_vote_is_answered_with_the_guess_the_model_had_already_made() {
    let db = TempDb::new("service-judge");
    let conn = db.open();
    let cache = ModelCache::default();

    seed(&conn);
    for id in [1, 2, 3] {
        record_vote(&conn, OWNER, id, 1); // Rust: yes
    }
    for id in [4, 5, 6] {
        record_vote(&conn, OWNER, id, -1); // Apple: no
    }
    train(&conn, &cache);

    // 7 is the remaining compiler story, which the model should like.
    let predicted: f64 = conn
        .query_one("SELECT score FROM scores WHERE story_id = 7", &[])
        .unwrap()
        .get(0);
    let outcome = judge(&conn, &cache, OWNER, 7, 1);
    let prediction = &outcome["prediction"];
    assert!(
        !prediction.is_null(),
        "a scored story comes back with its guess"
    );
    assert_eq!(
        prediction["score"].as_f64().unwrap(),
        predicted,
        "the guess is the one made before the vote existed"
    );
    assert_eq!(prediction["agreed"].as_bool().unwrap(), predicted >= 0.5);
    assert!(
        !outcome["taught"].is_null(),
        "and with what the vote gives the model"
    );

    // The retrain memorises this vote — the frozen prediction must not follow.
    train(&conn, &cache);
    let after: f64 = conn
        .query_one("SELECT score FROM scores WHERE story_id = 7", &[])
        .unwrap()
        .get(0);
    assert_ne!(
        after, predicted,
        "the live score is memorised after training"
    );
    let frozen: f64 = conn
        .query_one("SELECT score FROM vote_predictions WHERE story_id = 7", &[])
        .unwrap()
        .get(0);
    assert_eq!(frozen, predicted, "the captured prediction is left alone");

    // A skip is not a verdict, so there is nothing for a guess to be right about
    // and nothing taught.
    let skipped = judge(&conn, &cache, OWNER, 8, 0);
    assert!(skipped["prediction"].is_null(), "a skip reveals no verdict");
    assert!(skipped["taught"].is_null(), "and teaches the model nothing");

    // Undo clears the frozen prediction with the vote it belonged to.
    delete_vote(&conn, OWNER, 7);
    let n: i64 = conn
        .query_one(
            "SELECT COUNT(*) FROM vote_predictions WHERE story_id = 7",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(n, 0);
}

#[test]
fn a_skip_changes_nothing_the_model_trains_on() {
    let db = TempDb::new("service-skip");
    let conn = db.open();
    let cache = ModelCache::default();

    seed(&conn);
    for id in [1, 2, 3] {
        record_vote(&conn, OWNER, id, 1);
    }
    for id in [4, 5, 6] {
        record_vote(&conn, OWNER, id, -1);
    }
    let first = train(&conn, &cache);

    // This is what made "Learned · 64% accurate" appear after a skip: the skip
    // is not a training example, so retraining on it produces the same model
    // and claims something was learned. The client no longer triggers a retrain
    // for a skip; this pins the reason why.
    judge(&conn, &cache, OWNER, 7, 0);
    let second = train(&conn, &cache);
    assert_eq!(second.counts().up, first.counts().up, "no new labels");
    assert_eq!(second.counts().down, first.counts().down);
    assert_eq!(
        second.metrics().unwrap().accuracy,
        first.metrics().unwrap().accuracy,
        "and so the same model"
    );
}

#[test]
fn the_learning_curve_reports_accuracy_per_retrain() {
    let db = TempDb::new("service-history");
    let conn = db.open();
    let cache = ModelCache::default();

    assert_eq!(
        model_history(&conn, OWNER, 60),
        json!({"points": [], "runs": 0, "revs": 0}),
        "nothing before the first model"
    );

    seed(&conn);
    for id in [1, 2, 3] {
        record_vote(&conn, OWNER, id, 1);
    }
    for id in [4, 5, 6] {
        record_vote(&conn, OWNER, id, -1);
    }
    train(&conn, &cache);
    record_vote(&conn, OWNER, 7, 1);
    train(&conn, &cache);

    let history = model_history(&conn, OWNER, 60);
    assert_eq!(history["revs"], 2);
    assert_eq!(history["runs"], 2, "both runs added votes");
    let points = history["points"].as_array().unwrap();
    assert_eq!(points.len(), 2);
    let acc = points[0]["accuracy"].as_f64().unwrap();
    assert!(acc > 0.0 && acc <= 1.0, "metrics come out of the payload");
    assert!(
        points[0]["baseline"].as_f64().unwrap() > 0.0,
        "with the baseline to judge them against"
    );
    assert!(
        points[1]["votes"].as_i64() > points[0]["votes"].as_i64(),
        "and the vote count that produced them"
    );
    assert!(
        points[1]["features"].as_i64().unwrap() > 0,
        "plus vocabulary size"
    );
    assert!(
        points[1]["noise"].as_f64().unwrap() > 0.0,
        "and the band the accuracy wobbles inside"
    );

    // Those four numbers are columns now, written beside the payload rather
    // than parsed back out of it on every request. Nothing at runtime reads
    // both, so nothing at runtime would notice them drifting apart: this is
    // where the copy is held to the original.
    for row in conn
        .query(
            "SELECT accuracy, baseline, noise, n_features,
                    (payload::jsonb #>> '{metrics,accuracy}')::float8,
                    (payload::jsonb #>> '{metrics,baseline}')::float8,
                    (payload::jsonb #>> '{metrics,noise}')::float8,
                    jsonb_array_length(payload::jsonb #> '{model,names}')::bigint
             FROM models WHERE user_id = 1 ORDER BY rev",
            &[],
        )
        .unwrap()
    {
        assert_eq!(row.get::<_, Option<f64>>(0), row.get::<_, Option<f64>>(4));
        assert_eq!(row.get::<_, Option<f64>>(1), row.get::<_, Option<f64>>(5));
        assert_eq!(row.get::<_, Option<f64>>(2), row.get::<_, Option<f64>>(6));
        assert_eq!(row.get::<_, Option<i64>>(3), row.get::<_, Option<i64>>(7));
    }

    // A retrain that added no votes is the same model again. Before rounds
    // existed these were most of the table, and plotting them drew a wall of
    // repeats rather than a learning curve.
    train(&conn, &cache);
    let flat = model_history(&conn, OWNER, 60);
    assert_eq!(flat["revs"], 3, "the revision is still recorded");
    assert_eq!(flat["runs"], 2, "but it is not a training run");
    assert_eq!(
        flat["points"].as_array().unwrap().last().unwrap()["rev"],
        3,
        "and the newest model at that vote count wins"
    );
}

#[test]
fn the_model_cache_never_moves_backwards() {
    let db = TempDb::new("service-cache-monotonic");
    let conn = db.open();
    let cache = ModelCache::default();

    seed(&conn);
    for id in [1, 2, 3] {
        record_vote(&conn, OWNER, id, 1);
    }
    for id in [4, 5, 6] {
        record_vote(&conn, OWNER, id, -1);
    }

    let first_rev = train(&conn, &cache).rev().unwrap();
    let second_rev = train(&conn, &cache).rev().unwrap();
    assert!(second_rev > first_rev);
    assert_eq!(load_model(&conn, &cache, OWNER).unwrap().rev, second_rev);

    // This represents the race in load_model: its SELECT saw the old row,
    // then the trainer published the new revision before it acquired the cache
    // guard. Removing the newest row makes that interleaving deterministic.
    conn.execute("DELETE FROM models WHERE rev = $1", &[&second_rev])
        .unwrap();
    assert_eq!(
        load_model(&conn, &cache, OWNER).unwrap().rev,
        second_rev,
        "an older database read must not overwrite the newer cached model"
    );
}

#[test]
fn a_small_deck_keeps_the_strata_shares_it_was_asked_for() {
    let db = TempDb::new("service-shares");
    let conn = db.open();
    let cache = ModelCache::default();
    let now = now_seconds();

    let words = [
        "rust", "compiler", "apple", "iphone", "kernel", "startup", "physics", "sqlite",
    ];
    conn.begin();
    for id in 1..=4000_i64 {
        let created = now - (id / 6) * 86400;
        upsert_story(
            &conn,
            &story(
                id,
                &format!(
                    "{} {} piece {id}",
                    words[(id % 8) as usize],
                    words[((id * 5) % 8) as usize]
                ),
                Some(&format!("https://s.dev/{id}")),
                Some(&format!("d{}.dev", id % 30)),
                &format!("u{}", id % 40),
                20 + (id % 50),
                id % 90,
                created,
            ),
        );
    }
    conn.commit();
    for i in (1..=11).step_by(2) {
        record_vote(&conn, OWNER, i, 1);
    }
    for i in (2..=12).step_by(2) {
        record_vote(&conn, OWNER, i, -1);
    }
    train(&conn, &cache);

    // Rounding each share on its own asked for 9 cards when 8 were wanted, and
    // the ninth was truncated off the end — turning 40/20/20/20 into an even
    // split. Small decks are the whole point now, so the split has to survive them.
    for limit in [8_usize, 9, 12, 16] {
        let deck = queue(&conn, &cache, limit, 0);
        assert_eq!(deck.len(), limit, "deck of {limit} is full");
        let unique: std::collections::HashSet<i64> = deck.iter().map(|s| s.id).collect();
        assert_eq!(unique.len(), limit, "without repeats");
        let boundary = deck
            .iter()
            .filter(|s| s.reason.as_deref() == Some("boundary"))
            .count();
        assert!(
            boundary >= (limit as f64 * 0.33).floor() as usize,
            "{limit}: boundary got {boundary}, the largest share"
        );
        for reason in ["novel", "recent", "explore"] {
            assert!(
                deck.iter().any(|s| s.reason.as_deref() == Some(reason)),
                "{limit}: {reason} still contributes"
            );
        }
    }
}

#[test]
fn a_vote_reports_the_signals_it_gives_the_model() {
    let db = TempDb::new("service-signals");
    let conn = db.open();
    let cache = ModelCache::default();
    let now = now_seconds();

    seed(&conn);
    for id in [1, 2, 3] {
        record_vote(&conn, OWNER, id, 1);
    }
    for id in [4, 5, 6] {
        record_vote(&conn, OWNER, id, -1);
    }
    train(&conn, &cache);

    // A title full of words the model has never read.
    upsert_story(
        &conn,
        &story(
            200,
            "Kalman filters for underwater sonar drift",
            Some("https://oceanography.example/k"),
            Some("oceanography.example"),
            "nemo",
            40,
            40,
            now - 60,
        ),
    );
    score_missing(&conn, &cache, OWNER);

    let taught = judge(&conn, &cache, OWNER, 200, 1)["taught"].clone();
    assert!(
        taught["count"].as_i64().unwrap() > 0,
        "unseen words are counted"
    );
    let labels = taught["labels"].as_array().unwrap();
    assert!(!labels.is_empty() && labels.len() <= 3, "a few are named");
    assert!(
        labels
            .iter()
            .any(|l| l.as_str().unwrap().contains("kalman")),
        "expected kalman in {labels:?}"
    );
    // Style features match every title and were never news.
    assert!(
        !labels
            .iter()
            .any(|l| l == "a question" || l == "has a number"),
        "no style features"
    );

    // Once the model has read those words, the same shape of title teaches less.
    train(&conn, &cache);
    upsert_story(
        &conn,
        &story(
            201,
            "Kalman filters for sonar drift",
            Some("https://oceanography.example/k2"),
            Some("oceanography.example"),
            "nemo",
            40,
            40,
            now - 50,
        ),
    );
    score_missing(&conn, &cache, OWNER);
    let second = judge(&conn, &cache, OWNER, 201, 1);
    assert!(
        second["taught"]["count"].as_i64().unwrap() < taught["count"].as_i64().unwrap(),
        "the second time round it is mostly known"
    );
}

#[test]
fn a_round_is_dealt_tracked_against_the_votes_and_replaced() {
    let db = TempDb::new("service-round");
    let conn = db.open();
    let cache = ModelCache::default();
    let now = now_seconds();

    let words = [
        "rust", "compiler", "apple", "kernel", "startup", "physics", "sqlite", "ocean",
    ];
    conn.begin();
    for id in 1..=600_i64 {
        let created = now - id * 3600;
        upsert_story(
            &conn,
            &story(
                id,
                &format!(
                    "{} {} piece {id}",
                    words[(id % 8) as usize],
                    words[((id * 3) % 8) as usize]
                ),
                Some(&format!("https://s.dev/{id}")),
                Some(&format!("d{}.dev", id % 20)),
                &format!("u{}", id % 25),
                20 + (id % 40),
                id % 60,
                created,
            ),
        );
    }
    conn.commit();
    for i in (1..=9).step_by(2) {
        record_vote(&conn, OWNER, i, 1);
    }
    for i in (2..=10).step_by(2) {
        record_vote(&conn, OWNER, i, -1);
    }
    train(&conn, &cache);

    assert!(
        round_status(&conn, OWNER).is_none(),
        "nothing in flight before the first deal"
    );

    let dealt = deal_round(&conn, &cache, OWNER, ROUND_SIZE);
    let cards = dealt["cards"].as_array().unwrap();
    assert_eq!(cards.len(), ROUND_SIZE, "a dozen cards");
    assert_eq!(dealt["seq"], 1);
    assert!(
        cards.iter().all(|c| c["reason"].is_string()),
        "each card knows which stratum drew it"
    );

    // Progress is a join against votes, not a counter, so it survives a reload
    // and picks up votes cast anywhere else.
    let ids: Vec<i64> = cards.iter().map(|c| c["id"].as_i64().unwrap()).collect();
    record_vote(&conn, OWNER, ids[0], 1);
    record_vote(&conn, OWNER, ids[1], 0);
    record_vote(&conn, OWNER, ids[2], -1);
    let mid = round_status(&conn, OWNER).unwrap();
    assert_eq!(mid["judged"], 2, "skips are not judgements");
    assert_eq!(mid["skipped"], 1);
    let mid_cards = mid["cards"].as_array().unwrap();
    assert_eq!(
        mid_cards.len(),
        ROUND_SIZE - 3,
        "and the judged cards are gone from the deck"
    );
    assert_eq!(mid["seq"], 1, "still the same round");
    assert!(!mid_cards
        .iter()
        .any(|c| ids[..3].contains(&c["id"].as_i64().unwrap())));

    // A skip consumes its slot: the round is twelve cards, not twelve verdicts.
    for id in &ids[3..] {
        record_vote(&conn, OWNER, *id, 0);
    }
    let done = round_status(&conn, OWNER).unwrap();
    assert_eq!(
        done["cards"].as_array().unwrap().len(),
        0,
        "the round is spent"
    );
    assert_eq!(
        done["judged"].as_i64().unwrap() + done["skipped"].as_i64().unwrap(),
        ROUND_SIZE as i64
    );

    // Dealing again replaces it, and never re-offers a card already judged.
    let second = deal_round(&conn, &cache, OWNER, ROUND_SIZE);
    assert_eq!(second["seq"], 2);
    assert!(
        second["cards"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| !ids.contains(&c["id"].as_i64().unwrap())),
        "judged cards do not come back"
    );
    assert_eq!(
        round_status(&conn, OWNER).unwrap()["seq"],
        2,
        "the new round is the one in flight"
    );
}

#[test]
fn a_stale_round_is_not_resumed() {
    let db = TempDb::new("service-stale-round");
    let conn = db.open();
    let cache = ModelCache::default();

    seed(&conn);
    for id in [1, 2, 3] {
        record_vote(&conn, OWNER, id, 1);
    }
    for id in [4, 5, 6] {
        record_vote(&conn, OWNER, id, -1);
    }
    train(&conn, &cache);
    deal_round(&conn, &cache, OWNER, ROUND_SIZE);
    assert!(round_status(&conn, OWNER).is_some(), "fresh round resumes");

    // Yesterday's half-finished round should not be waiting when you open the
    // app today. The votes it collected are already recorded and are not lost.
    let mut stale: Value =
        rekorderlig::serde_json::from_str(&round_state(&conn, OWNER).current.unwrap()).unwrap();
    stale["dealtAt"] = json!(stale["dealtAt"].as_i64().unwrap() - 86400 * 2);
    set_current_round(&conn, OWNER, Some(&stale.to_string()));
    assert!(
        round_status(&conn, OWNER).is_none(),
        "a two-day-old deal is discarded"
    );
}

fn build_report_corpus(conn: &Db, now: i64) {
    let topics = ["rust", "sqlite", "apple", "crypto", "kernel", "funding"];
    conn.begin();
    for id in 1..=400_i64 {
        let created = now - id * 3600;
        upsert_story(
            conn,
            &story(
                id,
                &format!(
                    "{} {} report {id}",
                    topics[(id % 6) as usize],
                    topics[((id * 5) % 6) as usize]
                ),
                Some(&format!("https://s.dev/{id}")),
                Some(&format!("d{}.dev", id % 12)),
                &format!("u{}", id % 20),
                25 + (id % 30),
                id % 50,
                created,
            ),
        );
    }
    conn.commit();
}

fn liked(title: &str) -> bool {
    ["rust", "sqlite", "kernel"]
        .iter()
        .any(|t| title.contains(t))
}

#[test]
fn a_finished_round_reports_what_it_changed() {
    let db = TempDb::new("service-round-summary");
    let conn = db.open();
    let cache = ModelCache::default();
    let now = now_seconds();

    build_report_corpus(&conn, now);
    let topics = ["rust", "sqlite", "apple", "crypto", "kernel", "funding"];
    for i in 1..=20_i64 {
        record_vote(
            &conn,
            OWNER,
            i,
            if liked(topics[(i % 6) as usize]) {
                1
            } else {
                -1
            },
        );
    }
    train(&conn, &cache);

    let dealt = deal_round(&conn, &cache, OWNER, ROUND_SIZE);
    // Judge with the frozen predictions in play, the way the app does.
    for card in dealt["cards"].as_array().unwrap() {
        let id = card["id"].as_i64().unwrap();
        let value = if liked(card["title"].as_str().unwrap()) {
            1
        } else {
            -1
        };
        judge(&conn, &cache, OWNER, id, value);
    }
    train(&conn, &cache);

    let s = round_summary(&conn, &cache, OWNER).unwrap();
    assert_eq!(s["seq"], dealt["seq"]);
    assert_eq!(s["judged"], ROUND_SIZE as i64);
    assert_eq!(s["skipped"], 0);
    assert_eq!(s["trained"], true);
    let guessed = &s["guessed"];
    assert!(
        guessed["of"].as_i64().unwrap() > 0
            && guessed["right"].as_i64().unwrap() <= guessed["of"].as_i64().unwrap(),
        "a hit rate over the round"
    );
    assert!(
        s["signals"]["gained"].as_i64().unwrap() > 0,
        "signals gained"
    );
    assert!(
        s["accuracy"]["band"].as_f64().unwrap() > 0.0,
        "accuracy carries the band it must clear"
    );
    assert!(s["accuracy"]["significant"].is_boolean());
    // The band is a two-measurement one — it gates the gap between two
    // revisions' accuracies — so a move no bigger than either revision's own
    // wobble can never clear it.
    let noises: Vec<f64> = conn
        .query(
            "SELECT (payload::jsonb #>> '{metrics,noise}')::float8
             FROM models ORDER BY rev DESC LIMIT 2",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| r.get::<_, f64>(0))
        .collect();
    let single = noises.iter().cloned().fold(f64::MIN, f64::max);
    assert!(single > 0.0, "both revisions record their own band");
    assert!(
        s["accuracy"]["band"].as_f64().unwrap() > single,
        "band {} must exceed the single {single}",
        s["accuracy"]["band"]
    );

    // Delta and weight have to agree: a signal that moved towards no but is
    // still positive is not something the model dislikes.
    for l in s["learned"]["likes"].as_array().unwrap() {
        assert!(
            l["delta"].as_f64().unwrap() > 0.0 && l["weight"].as_f64().unwrap() > 0.0,
            "like {l}"
        );
    }
    for d in s["learned"]["dislikes"].as_array().unwrap() {
        assert!(
            d["delta"].as_f64().unwrap() < 0.0 && d["weight"].as_f64().unwrap() < 0.0,
            "dislike {d}"
        );
    }
    // Named signals must have evidence behind them, not a single sighting.
    for m in s["learned"]["likes"]
        .as_array()
        .unwrap()
        .iter()
        .chain(s["learned"]["dislikes"].as_array().unwrap())
    {
        assert!(
            m["support"].as_i64().unwrap() >= 2,
            "{} support",
            m["label"]
        );
    }

    // Asking twice must not cost a second retrain of the same votes: the round
    // is marked spent, which is what a reload on a finished round relies on.
    assert_eq!(round_status(&conn, OWNER).unwrap()["finished"], true);
    let again = round_summary(&conn, &cache, OWNER).unwrap();
    assert_eq!(again["signals"]["gained"], s["signals"]["gained"]);
}

#[test]
fn an_accuracy_move_is_tested_paired_against_the_predictions_that_changed_sides() {
    let db = TempDb::new("service-paired");
    let conn = db.open();
    let cache = ModelCache::default();
    let start = now_seconds();

    build_report_corpus(&conn, start);
    let topics = ["rust", "sqlite", "apple", "crypto", "kernel", "funding"];
    for id in 1..=60_i64 {
        record_vote(
            &conn,
            OWNER,
            id,
            if liked(topics[(id % 6) as usize]) {
                1
            } else {
                -1
            },
        );
    }
    train(&conn, &cache);

    let play_round = || {
        let dealt = deal_round(&conn, &cache, OWNER, ROUND_SIZE);
        for card in dealt["cards"].as_array().unwrap() {
            let id = card["id"].as_i64().unwrap();
            let value = if liked(card["title"].as_str().unwrap()) {
                1
            } else {
                -1
            };
            judge(&conn, &cache, OWNER, id, value);
        }
        train(&conn, &cache);
        round_summary(&conn, &cache, OWNER).unwrap()
    };

    play_round();
    let s = play_round();
    let f = &s["accuracy"]["flips"];

    assert!(
        !f.is_null(),
        "the round has both revisions held out, so the move is paired"
    );
    assert_eq!(
        f["moved"].as_i64().unwrap(),
        f["gained"].as_i64().unwrap() + f["lost"].as_i64().unwrap(),
        "moved is the discordant votes and nothing else"
    );
    assert_eq!(
        f["net"].as_i64().unwrap(),
        f["gained"].as_i64().unwrap() - f["lost"].as_i64().unwrap()
    );
    // The shared set is the earlier revision's votes: the later one has this
    // round on top of them, and a vote only the second scored is not a pair.
    assert_eq!(f["shared"].as_i64().unwrap(), 60 + ROUND_SIZE as i64);
    assert_eq!(
        s["accuracy"]["significant"].as_bool().unwrap(),
        f["moved"].as_i64().unwrap() > 0
            && (f["net"].as_i64().unwrap().abs() as f64)
                > 1.96 * (f["moved"].as_i64().unwrap() as f64).sqrt(),
        "significance comes off the flips, not the two accuracies"
    );

    // One revision back, never a history: the previous train's rows and no more.
    let revs: Vec<i64> = conn
        .query("SELECT rev FROM models ORDER BY rev DESC LIMIT 2", &[])
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    let prev_rev: Vec<i64> = conn
        .query("SELECT DISTINCT model_rev FROM oof_previous", &[])
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(
        prev_rev,
        vec![revs[1]],
        "oof_previous holds exactly the train before last"
    );

    // Now the gate itself, on a flip pattern built by hand rather than whatever
    // deck the queue happened to draw. Every shared vote's previous call is set
    // to agree with the current one, except `gained` of them, which are moved to
    // the wrong side: so that many flipped towards right, none the other way,
    // and McNemar's threshold (|net| > 1.96·√moved) falls between three flips
    // (3 < 3.4) and four (4 > 3.9).
    let stage = |gained: i64| {
        let shared: Vec<(i64, i64, f64)> = conn
            .query(
                "SELECT v.story_id, v.value, cur.score
                     FROM votes v
                     JOIN oof_previous prev ON prev.story_id = v.story_id
                     JOIN oof_scores   cur  ON cur.story_id  = v.story_id
                     WHERE v.value != 0 ORDER BY v.story_id",
                &[],
            )
            .unwrap()
            .iter()
            .map(|r| (r.get(0), r.get(1), r.get(2)))
            .collect();
        let mut left = gained;
        for (id, value, score) in shared {
            let is_right = (score >= 0.5) == (value > 0);
            let was_right = if is_right && left > 0 {
                left -= 1;
                false
            } else {
                is_right
            };
            let said_up = was_right == (value > 0);
            conn.execute(
                "UPDATE oof_previous SET score = $1 WHERE story_id = $2",
                &[&if said_up { 0.9_f64 } else { 0.1_f64 }, &id],
            )
            .unwrap();
        }
        assert_eq!(
            left, 0,
            "the fixture must have that many votes called right"
        );
    };
    // Re-reading a finished round is free and does not retrain; the flag it sets
    // is only there to stop a second retrain, so clearing it re-reads the same
    // two revisions.
    let reread = || {
        let mut round: Value =
            rekorderlig::serde_json::from_str(&round_state(&conn, OWNER).current.unwrap()).unwrap();
        round["finishedAt"] = Value::Null;
        set_current_round(&conn, OWNER, Some(&round.to_string()));
        round_summary(&conn, &cache, OWNER).unwrap()["accuracy"].clone()
    };

    stage(3);
    let three = reread();
    assert_eq!(
        (
            three["flips"]["gained"].as_i64().unwrap(),
            three["flips"]["lost"].as_i64().unwrap()
        ),
        (3, 0)
    );
    assert_eq!(
        three["significant"], false,
        "three flips one way is not a move"
    );

    stage(4);
    let four = reread();
    assert_eq!(
        (
            four["flips"]["gained"].as_i64().unwrap(),
            four["flips"]["lost"].as_i64().unwrap()
        ),
        (4, 0)
    );
    assert_eq!(four["significant"], true, "four of them is");
    assert_eq!(
        four["before"], three["before"],
        "and the two accuracies never moved"
    );

    // With nothing to pair against — the first round after this shipped, or a
    // revision gap — the unpaired band takes over.
    conn.execute_batch("DELETE FROM oof_previous").unwrap();
    let unpaired = reread();
    assert!(unpaired["flips"].is_null(), "nothing to pair against");
    assert_eq!(
        unpaired["significant"].as_bool().unwrap(),
        (unpaired["after"].as_f64().unwrap() - unpaired["before"].as_f64().unwrap()).abs()
            > unpaired["band"].as_f64().unwrap(),
        "so the band decides again"
    );
}

#[test]
fn cross_validation_reports_how_much_its_own_number_wobbles() {
    let db = TempDb::new("service-wobble");
    let conn = db.open();
    let cache = ModelCache::default();

    seed(&conn);
    for id in [1, 2, 3, 7] {
        record_vote(&conn, OWNER, id, 1);
    }
    for id in [4, 5, 6, 8] {
        record_vote(&conn, OWNER, id, -1);
    }
    let trained = train(&conn, &cache);
    let metrics = trained.metrics().unwrap();

    assert_eq!(
        metrics.fold_accuracy.len(),
        metrics.folds,
        "each fold keeps its own accuracy"
    );
    assert!(metrics.noise > 0.0, "and the spread becomes the noise band");
    // Eight votes separated perfectly is not certainty. The textbook binomial
    // error is exactly zero there, which would make every later move look
    // significant, so the band is Agresti-Coull and stays wide on small n.
    assert_eq!(metrics.accuracy, 1.0, "this toy set separates cleanly");
    assert!(metrics.noise > 0.05, "band was ±{}", metrics.noise);
}

#[test]
fn reset_models_forgets_the_models_and_nothing_else() {
    let db = TempDb::new("service-reset");
    let conn = db.open();
    let cache = ModelCache::default();

    seed(&conn);
    for id in [1, 2, 3] {
        record_vote(&conn, OWNER, id, 1);
    }
    for id in [4, 5, 6] {
        record_vote(&conn, OWNER, id, -1);
    }
    train(&conn, &cache);
    judge(&conn, &cache, OWNER, 7, 1); // leaves a frozen prediction behind
    train(&conn, &cache);
    deal_round(&conn, &cache, OWNER, ROUND_SIZE);

    let revs_before: i64 = conn
        .query_one("SELECT COUNT(*) FROM models", &[])
        .unwrap()
        .get(0);
    assert!(revs_before >= 2);
    assert!(round_status(&conn, OWNER).is_some(), "a round is in flight");

    let forgotten = reset_models(&conn, &cache, OWNER);
    assert_eq!(forgotten, revs_before);
    let left: i64 = conn
        .query_one("SELECT COUNT(*) FROM models", &[])
        .unwrap()
        .get(0);
    assert_eq!(left, 0, "every revision is gone");
    assert!(
        round_status(&conn, OWNER).is_none(),
        "and the round dealt by a vanished model with it"
    );
    assert!(
        round_state(&conn, OWNER).seq == 0,
        "round numbering restarts"
    );

    // The record survives: votes are the source of truth, and the frozen guesses
    // are a statement about what the model believed at the time.
    let votes: i64 = conn
        .query_one("SELECT COUNT(*) FROM votes", &[])
        .unwrap()
        .get(0);
    assert_eq!(votes, 7);
    let predictions: i64 = conn
        .query_one("SELECT COUNT(*) FROM vote_predictions", &[])
        .unwrap()
        .get(0);
    assert_eq!(predictions, 1);

    // Numbering restarts at 1 — AUTOINCREMENT would otherwise carry on from the
    // old high-water mark, which is the whole point of clearing sqlite_sequence.
    let retrained = train(&conn, &cache);
    assert!(retrained.trained());
    assert_eq!(
        retrained.rev(),
        Some(1),
        "the first model after a reset is rev 1"
    );
    assert_eq!(
        deal_round(&conn, &cache, OWNER, ROUND_SIZE)["seq"],
        1,
        "and the first round is round 1"
    );
}

#[test]
fn backfill_recovers_stories_algolia_missed_and_scores_them() {
    let db = TempDb::new("service-backfill");
    let conn = db.open();
    let cache = ModelCache::default();

    seed(&conn);
    for id in [1, 2, 3, 7] {
        record_vote(&conn, OWNER, id, 1);
    }
    for id in [4, 5, 6, 8] {
        record_vote(&conn, OWNER, id, -1);
    }
    assert!(train(&conn, &cache).trained());

    // A day the index dropped. Ids 100..300 fall inside it, and 200 is a story
    // only Firebase can see.
    let day = "2026-08-23";
    let (start, _) = day_bounds(day).unwrap();
    let fetch = move |url: &str| -> Result<Value, FetchError> {
        if url.ends_with("/maxitem.json") {
            return Ok(json!(300));
        }
        let id: i64 = url
            .rsplit('/')
            .next()
            .unwrap()
            .trim_end_matches(".json")
            .parse()
            .unwrap();
        let mut item = json!({
            "id": id, "type": "story", "by": "a", "time": start - 1000 + id * 10,
            "score": 20, "descendants": 4,
        });
        if id == 200 {
            item["title"] = json!("Rust async runtime rewritten");
            item["url"] = json!("https://tokio.rs/x");
        } else {
            item["title"] = json!(format!("Filler {id}"));
            item["url"] = json!(format!("https://ex.dev/{id}"));
        }
        Ok(item)
    };

    let opts = rekorderlig::firebase::BackfillOptions {
        pad: 0,
        concurrency: 8,
        ..rekorderlig::firebase::BackfillOptions::default()
    };
    let result = backfill(&conn, &cache, day, Some(day), &opts, &fetch, &mut |_| {}).unwrap();

    assert_eq!(result.from.as_deref(), Some(day));
    assert_eq!(result.to.as_deref(), Some(day));
    assert!(result.recovered > 0, "recovered {}", result.recovered);

    let (title, stored_day): (String, String) = {
        let r = conn
            .query_one("SELECT title, day FROM stories WHERE id = 200", &[])
            .unwrap();
        (r.get(0), r.get(1))
    };
    assert_eq!(title, "Rust async runtime rewritten");
    assert_eq!(stored_day, day);

    // The important part: a recovered story is scored, so the feed can see it.
    // An unscored story is invisible by design.
    assert_eq!(result.scored, Some(result.recovered));
    let scored: f64 = conn
        .query_one("SELECT score FROM scores WHERE story_id = 200", &[])
        .unwrap()
        .get(0);
    assert!(scored > 0.5, "a Rust title should score high, got {scored}");

    // A backfill of an old day says nothing about how fresh the corpus is.
    assert!(get_meta(&conn, "last_sync_at").is_none());
}

#[test]
fn a_payload_from_an_older_node_backend_still_loads() {
    // Before the noise-band work, payloads had no metrics.noise/foldAccuracy,
    // and early options carried fewer keys. The newest revision is parsed with
    // serde on every model load, so a database from that era must not 500 the
    // app — missing fields fall back the way the JS `?? 0` reads did.
    let db = TempDb::new("service-old-payload");
    let conn = db.open();
    let cache = ModelCache::default();
    seed(&conn);
    let payload = json!({
        "model": {
            "version": 1,
            "names": ["__bias__", "w:rust"],
            "counts": [8, 3],
            "weights": [0.1, 0.9],
            "nExamples": 8, "nPos": 4, "nNeg": 4,
            "options": {"epochs": 60, "lr": 0.35, "l2": 0.0002}
        },
        "metrics": {"folds": 4, "n": 8, "accuracy": 0.875, "baseline": 0.5, "auc": 0.9, "logLoss": 0.4}
    });
    conn.execute(
        "INSERT INTO models (user_id, rev, trained_at, n_votes, payload) VALUES (1, 1, 1, 8, $1)",
        &[&payload.to_string()],
    )
    .unwrap();

    let s = stats(&conn, &cache, OWNER);
    assert_eq!(s["model"]["metrics"]["accuracy"].as_f64(), Some(0.875));
    assert_eq!(
        s["model"]["metrics"]["noise"].as_f64(),
        Some(0.0),
        "missing noise defaults to 0"
    );
    // The loaded model scores stories, so the feed and queue work off it too.
    assert!(score_missing(&conn, &cache, OWNER) > 0);
}

#[test]
fn a_dated_day_replaces_the_window_rather_than_narrowing_it() {
    // The stories-per-day chart in Brain opens a day in the feed, which is the
    // only caller of `FeedOptions::day`. It has to be a replacement for the
    // rolling window and not an intersection with it: the day clicked is
    // usually outside the feed's 7-day default, so anding the two would always
    // give nothing, and the bar would look broken rather than empty.
    let db = TempDb::new("service-feed-day");
    let conn = db.open();
    let cache = ModelCache::default();
    let now = now_seconds();

    seed(&conn);
    for id in [1, 2, 3] {
        record_vote(&conn, OWNER, id, 1);
    }
    for id in [4, 5, 6] {
        record_vote(&conn, OWNER, id, -1);
    }

    // Two stories a fortnight back, on adjacent days, well outside any window
    // the feed offers by default.
    let old = now - 14 * 86400;
    for (id, at) in [(101, old), (102, old + 86400)] {
        upsert_story(
            &conn,
            &story(
                id,
                &format!("Archived story {id}"),
                Some(&format!("https://old.dev/{id}")),
                Some("old.dev"),
                "u_old",
                50,
                20,
                at,
            ),
        );
    }
    train(&conn, &cache);

    let day = day_key(old);
    let just_that_day = FeedOptions {
        // The default seven-day window is left in place on purpose: a dated day
        // must win it outright, which is what the front end relies on when it
        // sends `day` and drops `days`.
        days: 7,
        day: Some(day.clone()),
        min_comments: 0,
        ..FeedOptions::default()
    };
    let got = feed(&conn, &cache, OWNER, &just_that_day);
    assert_eq!(got.total, 1, "one story that day, not the whole fortnight");
    assert_eq!(got.items[0].id, 101);

    // The neighbouring day is its own bucket, not part of this one.
    let next = FeedOptions {
        day: Some(day_key(old + 86400)),
        ..just_that_day.clone()
    };
    assert_eq!(feed(&conn, &cache, OWNER, &next).items[0].id, 102);

    // And a day nothing was fetched on is empty rather than falling back to
    // the window, which would show a week of stories under one day's label.
    let empty = FeedOptions {
        day: Some(day_key(old - 5 * 86400)),
        ..just_that_day.clone()
    };
    assert_eq!(feed(&conn, &cache, OWNER, &empty).total, 0);
}

#[test]
fn points_and_comments_are_two_floors_on_the_same_axis() {
    // Points are the crowd's verdict on the link and comments are how much it
    // was argued about, and a story is regularly one without the other: a
    // linkbait post with fifty comments and four points, a quiet paper with a
    // hundred points and none. The feed could only ask the second question.
    let db = TempDb::new("service-feed-points");
    let conn = db.open();
    let cache = ModelCache::default();
    let now = now_seconds();

    seed(&conn);
    for id in [1, 2, 3] {
        record_vote(&conn, OWNER, id, 1);
    }
    for id in [4, 5, 6] {
        record_vote(&conn, OWNER, id, -1);
    }

    // Same day, same everything, opposite shapes of traction.
    for (id, points, comments) in [(201, 120, 0), (202, 2, 90)] {
        upsert_story(
            &conn,
            &story(
                id,
                &format!("Traction story {id}"),
                Some(&format!("https://t.dev/{id}")),
                Some("t.dev"),
                "u_t",
                points,
                comments,
                now - 3600,
            ),
        );
    }
    train(&conn, &cache);

    let base = FeedOptions {
        days: 7,
        min_comments: 0,
        ..FeedOptions::default()
    };
    let by_points = FeedOptions {
        min_points: 50,
        ..base.clone()
    };
    let ids: Vec<i64> = feed(&conn, &cache, OWNER, &by_points)
        .items
        .iter()
        .map(|s| s.id)
        .filter(|id| *id >= 201)
        .collect();
    assert_eq!(ids, vec![201], "the quiet paper, not the linkbait");

    let by_comments = FeedOptions {
        min_comments: 50,
        ..base.clone()
    };
    let ids: Vec<i64> = feed(&conn, &cache, OWNER, &by_comments)
        .items
        .iter()
        .map(|s| s.id)
        .filter(|id| *id >= 201)
        .collect();
    assert_eq!(
        ids,
        vec![202],
        "and the other question gives the other answer"
    );

    // Both floors at once is an intersection, not a choice between them.
    let both = FeedOptions {
        min_points: 50,
        min_comments: 50,
        ..base.clone()
    };
    assert!(
        !feed(&conn, &cache, OWNER, &both)
            .items
            .iter()
            .any(|s| s.id >= 201),
        "neither story clears both floors"
    );
}
