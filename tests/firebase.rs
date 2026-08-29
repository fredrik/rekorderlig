//! Port of the Node firebase test suite: the item-API repair path.

mod common;

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use common::{story, TempDb};
use rekorderlig::dates::day_bounds;
use rekorderlig::db::upsert_story;
use rekorderlig::firebase::{backfill_days, id_range_for_day, normalize_item, BackfillOptions};
use rekorderlig::http_client::FetchError;
use rekorderlig::serde_json::{json, Value};

const DAY: &str = "2026-08-23";

fn start() -> i64 {
    day_bounds(DAY).unwrap().0
}

/// A fake Hacker News, ids 1..1099 running two minutes apart, so id 1030 is the
/// first one at or after midnight — that number is what the bisect has to find,
/// and it is deliberately not a range boundary. The whole id space is served,
/// because the bisect starts from the site's first item.
struct World {
    items: HashMap<i64, Value>,
    fail: HashSet<i64>,
    calls: Mutex<usize>,
}

impl World {
    fn new(fail: &[i64]) -> World {
        let start = start();
        let time_of = |id: i64| start - 3600 + (id - 1000) * 120;
        let mut items = HashMap::new();
        for id in 1..=1099_i64 {
            items.insert(
                id,
                json!({
                    "id": id, "type": "story", "by": format!("u{id}"), "time": time_of(id),
                    "title": format!("Story {id}"), "url": format!("https://ex.dev/{id}"),
                    "score": 5, "descendants": 2,
                }),
            );
        }
        // A spread of things a backfill must not treat as a story.
        items.insert(1040, json!({"id": 1040, "type": "comment", "by": "c", "time": time_of(1040), "text": "a comment"}));
        items.insert(1041, json!({"id": 1041, "type": "story", "by": "d", "time": time_of(1041), "title": "Dead one", "score": 9, "dead": true}));
        items.insert(
            1042,
            json!({"id": 1042, "type": "story", "by": "e", "time": time_of(1042), "deleted": true}),
        );
        items.insert(1043, Value::Null); // never existed
        let mut low = items[&1044].clone();
        low["score"] = json!(1); // below the points floor
        items.insert(1044, low);
        World {
            items,
            fail: fail.iter().copied().collect(),
            calls: Mutex::new(0),
        }
    }

    fn calls(&self) -> usize {
        *self.calls.lock().unwrap()
    }
}

impl rekorderlig::http_client::Fetch for World {
    fn get_json(&self, url: &str) -> Result<Value, FetchError> {
        *self.calls.lock().unwrap() += 1;
        if url.ends_with("/maxitem.json") {
            return Ok(json!(1099));
        }
        let id: i64 = url
            .rsplit('/')
            .next()
            .unwrap()
            .trim_end_matches(".json")
            .parse()
            .unwrap();
        if self.fail.contains(&id) {
            return Err(FetchError {
                message: "HTTP 500".into(),
            });
        }
        Ok(self.items.get(&id).cloned().unwrap_or(Value::Null))
    }
}

fn opts(pad: i64, concurrency: usize) -> BackfillOptions {
    BackfillOptions {
        pad,
        concurrency,
        ..BackfillOptions::default()
    }
}

#[test]
fn normalize_item_maps_an_item_onto_the_story_shape() {
    let start = start();
    let s = normalize_item(
        &json!({
            "id": 49410949, "type": "story", "by": "jsnell", "time": start + 60,
            "title": "  Predicting AI model release dates with stats  ",
            "url": "https://blog.nihilty.com/p/dates", "score": 28, "descendants": 3,
        }),
        1234,
    )
    .unwrap();

    assert_eq!(
        s,
        rekorderlig::db::Story {
            fetched_at: 1234,
            ..story(
                49410949,
                "Predicting AI model release dates with stats",
                Some("https://blog.nihilty.com/p/dates"),
                Some("blog.nihilty.com"),
                "jsnell",
                28,
                3,
                start + 60,
            )
        }
    );
}

#[test]
fn normalize_item_defaults_a_self_post_to_no_url_and_zero_counts() {
    let s = normalize_item(
        &json!({"id": 7, "type": "story", "by": "a", "time": start(), "title": "Ask HN: anything?"}),
        0,
    )
    .unwrap();
    assert_eq!(s.url, None);
    assert_eq!(s.domain, None);
    assert_eq!(s.points, 0);
    assert_eq!(s.num_comments, 0);
}

#[test]
fn normalize_item_rejects_anything_that_is_not_a_live_story() {
    let base =
        json!({"id": 1, "type": "story", "by": "a", "time": start(), "title": "T", "score": 5});
    let with = |key: &str, value: Value| {
        let mut item = base.clone();
        item[key] = value;
        item
    };
    assert!(normalize_item(&Value::Null, 0).is_none());
    assert!(normalize_item(&with("deleted", json!(true)), 0).is_none());
    assert!(normalize_item(&with("dead", json!(true)), 0).is_none());
    assert!(normalize_item(&with("type", json!("comment")), 0).is_none());
    assert!(normalize_item(&with("type", json!("job")), 0).is_none());
    assert!(normalize_item(&with("type", json!("poll")), 0).is_none());
    assert!(normalize_item(&with("title", json!("   ")), 0).is_none());
    assert!(normalize_item(&with("time", Value::Null), 0).is_none());
}

#[test]
fn id_range_for_day_bisects_to_the_first_id_at_or_after_midnight() {
    let world = World::new(&[]);
    let (lo, hi) = id_range_for_day(DAY, &world, 0).unwrap();

    // 1030 is the first item at or after midnight; nothing in the fake reaches
    // the next midnight, so the range runs to the tip of the site.
    assert_eq!(lo, 1030);
    assert_eq!(hi, 1099);
    // A bisect, not a scan: ~2 * log2(100) probes plus the maxitem lookup.
    assert!(world.calls() < 30, "{} requests", world.calls());
}

#[test]
fn id_range_for_day_pads_the_range_to_absorb_out_of_order_ids() {
    let world = World::new(&[]);
    let (lo, hi) = id_range_for_day(DAY, &world, 5).unwrap();
    assert_eq!(lo, 1025);
    assert_eq!(hi, 1099); // clamped to maxitem, never past the tip
}

#[test]
fn backfill_days_recovers_the_live_stories_a_day_is_missing() {
    let db = TempDb::new("firebase-recover");
    let conn = db.open();
    let world = World::new(&[]);

    let seen = Mutex::new(Vec::new());
    let result = backfill_days(
        &conn,
        &[DAY.to_string()],
        &opts(0, 4),
        &world,
        &mut |stat| {
            seen.lock().unwrap().push(stat.clone());
        },
    )
    .unwrap();

    // Ids 1030..1099 is 70 items: 1040 is a comment, 1041 dead, 1042 deleted,
    // 1043 absent and 1044 below the floor, leaving 65 recoverable stories.
    assert_eq!(result.scanned, 70);
    assert_eq!(result.stories, 65);
    assert_eq!(result.recovered, 65);
    assert_eq!(result.updated, 0);
    assert!(result.failures.is_empty());

    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM stories", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 65);
    let (title, domain, day): (String, String, String) = conn
        .query_row(
            "SELECT title, domain, day FROM stories WHERE id = 1050",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(title, "Story 1050");
    assert_eq!(domain, "ex.dev");
    assert_eq!(day, DAY);
    for gone in [1040, 1044] {
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM stories WHERE id = ?1", [gone], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(n, 0);
    }

    // Progress is reported once per day, so a long run is legible.
    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].day, DAY);
    assert_eq!(seen[0].recovered, 65);
}

#[test]
fn backfill_days_records_a_failing_id_and_steps_over_it() {
    let db = TempDb::new("firebase-fail");
    let conn = db.open();
    let world = World::new(&[1050, 1051]);

    let result =
        backfill_days(&conn, &[DAY.to_string()], &opts(0, 4), &world, &mut |_| {}).unwrap();

    assert_eq!(result.recovered, 63);
    assert_eq!(
        result.failures.iter().map(|f| f.id).collect::<Vec<_>>(),
        vec![1050, 1051]
    );
    assert!(result.failures[0].error.contains("500"));
    // The rest of the day still landed.
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM stories", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 63);
}

#[test]
fn backfill_days_is_idempotent_and_never_lowers_a_story_it_already_has() {
    let db = TempDb::new("firebase-idempotent");
    let conn = db.open();
    let world = World::new(&[]);

    // A story Algolia did index, with a higher points count than the fake serves.
    upsert_story(
        &conn,
        &rekorderlig::db::Story {
            day: DAY.to_string(),
            fetched_at: 1,
            ..story(
                1050,
                "Story 1050",
                Some("https://ex.dev/1050"),
                Some("ex.dev"),
                "u1050",
                400,
                99,
                start(),
            )
        },
    );

    let first = backfill_days(&conn, &[DAY.to_string()], &opts(0, 4), &world, &mut |_| {}).unwrap();
    assert_eq!(first.recovered, 64);
    assert_eq!(first.updated, 1);

    let (points, comments): (i64, i64) = conn
        .query_row(
            "SELECT points, num_comments FROM stories WHERE id = 1050",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        points, 400,
        "a backfill must not undo a higher points count"
    );
    assert_eq!(comments, 99);

    // Re-running is safe: everything is already there, so nothing is new.
    let again = backfill_days(&conn, &[DAY.to_string()], &opts(0, 4), &world, &mut |_| {}).unwrap();
    assert_eq!(again.recovered, 0);
    assert_eq!(again.updated, 65);
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM stories", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 65);
}

#[test]
fn backfill_days_dry_run_reports_the_gap_without_writing() {
    let db = TempDb::new("firebase-dryrun");
    let conn = db.open();
    let world = World::new(&[]);

    let result = backfill_days(
        &conn,
        &[DAY.to_string()],
        &BackfillOptions {
            dry_run: true,
            ..opts(0, 4)
        },
        &world,
        &mut |_| {},
    )
    .unwrap();

    assert!(result.dry_run);
    assert_eq!(result.stories, 65);
    assert_eq!(result.recovered, 65);
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM stories", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0);
}

#[test]
fn backfill_days_respects_the_points_floor() {
    let db = TempDb::new("firebase-floor");
    let conn = db.open();
    let world = World::new(&[]);

    // Dropping the floor to zero lets id 1044 (1 point) through.
    let result = backfill_days(
        &conn,
        &[DAY.to_string()],
        &BackfillOptions {
            min_points: 0,
            ..opts(0, 4)
        },
        &world,
        &mut |_| {},
    )
    .unwrap();
    assert_eq!(result.stories, 66);
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM stories WHERE id = 1044", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(n, 1);
}
