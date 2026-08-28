//! The official Hacker News item API, used for exactly one thing: recovering
//! stories that Algolia's search index never got.
//!
//! This is a repair path, not a second sync. Algolia (`hn.rs`) remains the only
//! way stories routinely enter the database — it can answer "the top stories of
//! a day" in ten requests, which this API cannot do at all. What it can do is
//! answer for *every* id, including the ones Algolia dropped, and that is the
//! only question it is asked here.
//!
//! The two sources are kept in separate files because they share no request or
//! response shape; what they do share (`Fetch`, `upsert_story`, the story
//! struct) is imported rather than forked.
//!
//! Docs: https://github.com/HackerNews/API

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

use crate::dates::{day_bounds, day_key};
use crate::db::{upsert_story, Story};
use crate::features::domain_of;
use crate::hn::MIN_POINTS;
use crate::http_client::{Fetch, FetchError};

const API: &str = "https://hacker-news.firebaseio.com/v0";

/// Item time is only *nearly* monotonic in id — a submission can be stamped a
/// second either side of its neighbours — so a day's id range is widened at both
/// ends and each item's own timestamp decides which day it belongs to. Cheap
/// insurance: a few hundred extra ids on a day that already costs ten thousand.
pub const ID_PAD: i64 = 200;

/// How far past a null id to keep looking for one that carries a timestamp.
const PROBE_WINDOW: i64 = 20;

/// How many ids to hold in flight. 32 ran clean over 22k ids; half that is polite.
pub const CONCURRENCY: usize = 16;

/// One Firebase item → the story shape `upsert_story` takes, or None if it is not
/// a live story. Everything the backfill must not train on is rejected here:
/// comments, jobs and polls (wrong type), items removed by their author
/// (`deleted`) and items killed by moderation or the flag threshold (`dead`).
/// Those are not losses — they are ~11% of every id range, on a normal day too.
pub fn normalize_item(item: &Value, fetched_at: i64) -> Option<Story> {
    if item.is_null()
        || item.get("deleted").and_then(Value::as_bool).unwrap_or(false)
        || item.get("dead").and_then(Value::as_bool).unwrap_or(false)
        || item.get("type").and_then(Value::as_str) != Some("story")
    {
        return None;
    }
    let id = item.get("id").and_then(Value::as_i64)?;
    if id == 0 {
        return None;
    }
    let title = item
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if title.is_empty() {
        return None;
    }
    let created = item.get("time").and_then(Value::as_i64)?;
    let url = item.get("url").and_then(Value::as_str).map(str::to_string);
    Some(Story {
        id,
        domain: domain_of(url.as_deref()),
        author: item.get("by").and_then(Value::as_str).map(str::to_string),
        points: item.get("score").and_then(Value::as_i64).unwrap_or(0),
        num_comments: item.get("descendants").and_then(Value::as_i64).unwrap_or(0),
        created_at: created,
        day: day_key(created),
        fetched_at,
        title,
        url,
    })
}

fn item_url(id: i64) -> String {
    format!("{API}/item/{id}.json")
}

/// The first id at or after `id` that carries a timestamp, or None.
fn datable_at_or_after(
    id: i64,
    cap: i64,
    fetch: &dyn Fetch,
) -> Result<Option<(i64, i64)>, FetchError> {
    for k in id..=cap.min(id + PROBE_WINDOW) {
        let item = fetch.get_json(&item_url(k))?;
        if let Some(time) = item.get("time").and_then(Value::as_i64) {
            return Ok(Some((k, time)));
        }
    }
    Ok(None)
}

/// The lowest id whose item was created at or after `t`, by bisection over the
/// whole id space. About log2(maxitem) ≈ 26 requests, which is why this asks
/// Firebase rather than reading the boundary off Algolia: the index whose gaps
/// we are repairing is the last thing that should define the range to repair.
///
/// A null id (one that never existed) carries no timestamp and so cannot be
/// compared; the bisect steps forward to the next id that can, and on finding
/// none pulls the upper bound back. Either way the answer can only land a few
/// ids early, which `ID_PAD` already absorbs.
fn first_id_at_or_after(t: i64, cap: i64, fetch: &dyn Fetch) -> Result<i64, FetchError> {
    let mut lo = 1;
    let mut hi = cap + 1; // cap + 1 means "no item that late", i.e. past the tip
    while lo < hi {
        let mid = (lo + hi) / 2;
        match datable_at_or_after(mid, cap, fetch)? {
            None => hi = mid,
            Some((_, time)) if time >= t => hi = mid,
            Some((id, _)) => lo = id + 1,
        }
    }
    Ok(lo)
}

/// The padded id range that covers one UTC day, clamped to the tip of the site.
pub fn id_range_for_day(
    day: &str,
    fetch: &dyn Fetch,
    pad: i64,
) -> Result<(i64, i64), FetchError> {
    let (start, end) = day_bounds(day).map_err(|message| FetchError { message })?;
    let cap = fetch
        .get_json(&format!("{API}/maxitem.json"))?
        .as_i64()
        .ok_or_else(|| FetchError { message: "maxitem is not a number".to_string() })?;
    let from = first_id_at_or_after(start, cap, fetch)?;
    let until = first_id_at_or_after(end, cap, fetch)?;
    Ok(((from - pad).max(1), (until - 1 + pad).min(cap)))
}

/// Run the fetch over `ids` with at most `n` in flight, keeping the input order.
fn pool_fetch(ids: &[i64], n: usize, fetch: &dyn Fetch) -> Vec<Result<Value, FetchError>> {
    let out: Vec<Mutex<Option<Result<Value, FetchError>>>> =
        ids.iter().map(|_| Mutex::new(None)).collect();
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..n.min(ids.len()) {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= ids.len() {
                    break;
                }
                let result = fetch.get_json(&item_url(ids[i]));
                *out[i].lock().expect("pool slot") = Some(result);
            });
        }
    });
    out.into_iter()
        .map(|slot| slot.into_inner().expect("pool slot").expect("pool slot filled"))
        .collect()
}

#[derive(Debug, Clone, Copy)]
pub struct BackfillOptions {
    pub min_points: i64,
    pub concurrency: usize,
    pub dry_run: bool,
    pub pad: i64,
    pub now: i64,
}

impl Default for BackfillOptions {
    fn default() -> Self {
        BackfillOptions {
            min_points: MIN_POINTS,
            concurrency: CONCURRENCY,
            dry_run: false,
            pad: ID_PAD,
            now: crate::dates::now_seconds(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct IdFailure {
    pub day: String,
    pub id: i64,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DayStat {
    pub day: String,
    pub from: i64,
    pub to: i64,
    pub scanned: usize,
    pub stories: usize,
    pub recovered: usize,
    pub updated: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackfillOutcome {
    pub days: usize,
    pub scanned: usize,
    pub stories: usize,
    pub recovered: usize,
    pub updated: usize,
    pub failures: Vec<IdFailure>,
    #[serde(rename = "byDay")]
    pub by_day: Vec<DayStat>,
    #[serde(rename = "dryRun")]
    pub dry_run: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scored: Option<usize>,
}

/// Walk every id in each day's range and upsert the live stories found there.
///
/// There is no diff against Algolia first: an id has to be fetched to learn
/// whether it is a story at all, so asking Algolia as well would only add
/// requests and a dependency on the index we already know to be wrong.
/// `upsert_story` takes MAX() on points and comments, so a story Algolia *did*
/// index can only be improved by this, never walked back.
///
/// One transaction per day, and an id that fails after retries is recorded and
/// stepped over rather than aborting the run — the same rule `sync_days` follows,
/// so an interrupted run is resumed by running it again.
pub fn backfill_days(
    conn: &Connection,
    days: &[String],
    opts: &BackfillOptions,
    fetch: &dyn Fetch,
    on_progress: &mut dyn FnMut(&DayStat),
) -> Result<BackfillOutcome, FetchError> {
    let list: Vec<String> = days.iter().cloned().collect::<BTreeSet<_>>().into_iter().collect();
    let wanted: BTreeSet<&str> = list.iter().map(String::as_str).collect();
    let mut totals = BackfillOutcome {
        days: list.len(),
        scanned: 0,
        stories: 0,
        recovered: 0,
        updated: 0,
        failures: Vec::new(),
        by_day: Vec::new(),
        dry_run: opts.dry_run,
        from: None,
        to: None,
        scored: None,
    };

    // Padded ranges overlap at the seams; the cursor makes sure a consecutive
    // range of days fetches each id once.
    let mut cursor = 0_i64;

    for day in &list {
        let (lo, hi) = id_range_for_day(day, fetch, opts.pad)?;
        let from = lo.max(cursor + 1);
        let ids: Vec<i64> = (from..=hi).collect();
        cursor = cursor.max(hi);

        let fetched = pool_fetch(&ids, opts.concurrency, fetch);

        let mut found: Vec<Story> = Vec::new();
        let mut failures: Vec<IdFailure> = Vec::new();
        for (id, result) in ids.iter().zip(fetched) {
            let item = match result {
                Ok(item) => item,
                Err(err) => {
                    failures.push(IdFailure { day: day.clone(), id: *id, error: err.message });
                    continue;
                }
            };
            // The points floor is the same one the Algolia sync applies: below it a
            // submission is noise nobody engaged with. `wanted` drops the padding.
            let Some(story) = normalize_item(&item, opts.now) else { continue };
            if story.points < opts.min_points || !wanted.contains(story.day.as_str()) {
                continue;
            }
            found.push(story);
        }

        let mut exists = conn
            .prepare_cached("SELECT 1 FROM stories WHERE id = ?1")
            .expect("exists stmt");
        let is_new: Vec<bool> = found
            .iter()
            .map(|s| {
                exists
                    .query_row([s.id], |_| Ok(()))
                    .optional()
                    .expect("exists")
                    .is_none()
            })
            .collect();
        drop(exists);
        if !opts.dry_run && !found.is_empty() {
            conn.execute_batch("BEGIN").expect("begin");
            for story in &found {
                upsert_story(conn, story);
            }
            conn.execute_batch("COMMIT").expect("commit");
        }

        let stat = DayStat {
            day: day.clone(),
            from,
            to: hi,
            scanned: ids.len(),
            stories: found.len(),
            recovered: is_new.iter().filter(|n| **n).count(),
            updated: is_new.iter().filter(|n| !**n).count(),
            failed: failures.len(),
        };
        totals.scanned += stat.scanned;
        totals.stories += stat.stories;
        totals.recovered += stat.recovered;
        totals.updated += stat.updated;
        totals.failures.append(&mut failures);
        on_progress(&stat);
        totals.by_day.push(stat);
    }

    Ok(totals)
}
