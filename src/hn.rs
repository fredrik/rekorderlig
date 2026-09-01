//! Fetch stories from the Algolia Hacker News search API (no key required).
//! Docs: https://hn.algolia.com/api

use crate::db::Db;
use serde::Serialize;
use serde_json::Value;

use crate::dates::{day_bounds, day_key, now_seconds};
use crate::db::{upsert_story, Story};
use crate::features::domain_of;
use crate::http_client::{Fetch, FetchError};

const API: &str = "https://hn.algolia.com/api/v1";

/// Below this, a submission is noise: nobody engaged, and the model learns nothing from it.
pub const MIN_POINTS: i64 = 3;

pub fn normalize(hit: &Value, fetched_at: i64) -> Option<Story> {
    let id: i64 = hit.get("objectID")?.as_str()?.parse().ok()?;
    if id == 0 {
        return None;
    }
    let title = hit
        .get("title")
        .and_then(Value::as_str)
        .or_else(|| hit.get("story_title").and_then(Value::as_str))
        .unwrap_or("")
        .trim()
        .to_string();
    if title.is_empty() {
        return None;
    }
    let url = hit
        .get("url")
        .and_then(Value::as_str)
        .or_else(|| hit.get("story_url").and_then(Value::as_str))
        .map(str::to_string);
    // day_key on a nonsense timestamp would file the story under a bogus day,
    // so a hit with no usable creation time is dropped, like the Node version.
    let created = hit.get("created_at_i").and_then(Value::as_i64)?;
    Some(Story {
        id,
        domain: domain_of(url.as_deref()),
        author: hit
            .get("author")
            .and_then(Value::as_str)
            .map(str::to_string),
        points: hit.get("points").and_then(Value::as_i64).unwrap_or(0),
        num_comments: hit.get("num_comments").and_then(Value::as_i64).unwrap_or(0),
        created_at: created,
        day: day_key(created),
        fetched_at,
        title,
        url,
    })
}

/// Top stories for one UTC day, ranked by points by the API.
pub fn fetch_day(
    fetch: &dyn Fetch,
    day: &str,
    pages: u32,
    min_points: i64,
) -> Result<Vec<Story>, FetchError> {
    let (start, end) = day_bounds(day).map_err(|message| FetchError { message })?;
    let points_filter = if min_points > 0 {
        format!(",points>={min_points}")
    } else {
        String::new()
    };
    let hits_per_page = 100;
    let mut stories = Vec::new();
    let now = now_seconds();
    for page in 0..pages {
        let url = format!(
            "{API}/search?tags=story&numericFilters=created_at_i>={start},created_at_i<{end}{points_filter}\
             &hitsPerPage={hits_per_page}&page={page}"
        );
        let data = fetch.get_json(&url)?;
        let hits = data
            .get("hits")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for hit in &hits {
            if let Some(s) = normalize(hit, now) {
                stories.push(s);
            }
        }
        let nb_pages = data.get("nbPages").and_then(Value::as_u64).unwrap_or(0);
        if hits.is_empty() || u64::from(page) + 1 >= nb_pages {
            break;
        }
    }
    Ok(stories)
}

/// One story by its Hacker News id, or None if the id is unknown / not a story.
/// `tags=story,story_<id>` narrows the index to that submission itself (the
/// story_<id> tag alone would also match all of its comments), so this costs one
/// small search hit instead of the full comment tree that /items/<id> returns.
pub fn fetch_story(fetch: &dyn Fetch, id: i64) -> Result<Option<Story>, FetchError> {
    let data = fetch.get_json(&format!("{API}/search?tags=story,story_{id}&hitsPerPage=1"))?;
    Ok(data
        .get("hits")
        .and_then(Value::as_array)
        .and_then(|hits| hits.first())
        .and_then(|hit| normalize(hit, now_seconds())))
}

pub fn fetch_front_page(fetch: &dyn Fetch) -> Result<Vec<Story>, FetchError> {
    let data = fetch.get_json(&format!("{API}/search?tags=front_page&hitsPerPage=100"))?;
    let now = now_seconds();
    Ok(data
        .get("hits")
        .and_then(Value::as_array)
        .map(|hits| hits.iter().filter_map(|h| normalize(h, now)).collect())
        .unwrap_or_default())
}

/// What `sync_days` needs from the Algolia side, as a seam so tests can hand in
/// a fake Hacker News (the Node version took a `deps` object for the same job).
pub trait HnSource: Sync {
    fn fetch_day(&self, day: &str, pages: u32, min_points: i64) -> Result<Vec<Story>, FetchError>;
    fn fetch_front_page(&self) -> Result<Vec<Story>, FetchError>;
}

pub struct Algolia<'a> {
    pub fetch: &'a dyn Fetch,
}

impl HnSource for Algolia<'_> {
    fn fetch_day(&self, day: &str, pages: u32, min_points: i64) -> Result<Vec<Story>, FetchError> {
        fetch_day(self.fetch, day, pages, min_points)
    }
    fn fetch_front_page(&self) -> Result<Vec<Story>, FetchError> {
        fetch_front_page(self.fetch)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SyncOptions {
    /// 10 pages of 100 hits covers a full HN day above the points floor; a quiet
    /// day still costs fewer requests, since fetch_day stops at the last page.
    pub pages_per_day: u32,
    pub min_points: i64,
    pub throttle_ms: u64,
}

impl Default for SyncOptions {
    fn default() -> Self {
        SyncOptions {
            pages_per_day: 10,
            min_points: MIN_POINTS,
            throttle_ms: 250,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DayProgress {
    pub day: String,
    pub count: usize,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub failed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DayFailure {
    pub day: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncOutcome {
    pub days: usize,
    #[serde(rename = "fetchedDays")]
    pub fetched_days: usize,
    pub fetched: usize,
    pub inserted: i64,
    pub failures: Vec<DayFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(rename = "frontPage", skip_serializing_if = "Option::is_none")]
    pub front_page: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scored: Option<usize>,
}

fn count_stories(db: &Db) -> i64 {
    db.query_one("SELECT COUNT(*) FROM stories", &[])
        .expect("count stories")
        .get(0)
}

fn upsert_all(db: &Db, stories: &[Story]) {
    db.begin();
    for s in stories {
        upsert_story(db, s);
    }
    db.commit();
}

/// The one way stories enter the database: walk `days` (any list of
/// YYYY-MM-DD, in the order given), fetch the top stories of each and upsert
/// them. Used for both the rolling refresh and a year-long archive fill —
/// the only difference is the list of days handed in.
///
/// Every day handed in is fetched. Nothing is skipped on the grounds that it
/// looks covered already: points and comment counts keep moving, and a day
/// that only partly landed is indistinguishable from a quiet one. Upserts make
/// a refetch cheap in the database — it costs requests, not correctness.
///
/// Every day is committed in its own transaction, and a day that still fails
/// after retries is recorded and stepped over rather than aborting the run, so
/// any interrupted or partly failed run is resumed by running it again.
pub fn sync_days(
    db: &Db,
    days: &[String],
    opts: &SyncOptions,
    source: &dyn HnSource,
    on_progress: &mut dyn FnMut(&DayProgress),
) -> SyncOutcome {
    let before = count_stories(db);
    let mut fetched = 0;
    let mut fetched_days = 0;
    let mut failures = Vec::new();

    for day in days {
        let stories = match source.fetch_day(day, opts.pages_per_day, opts.min_points) {
            Ok(stories) => stories,
            Err(err) => {
                failures.push(DayFailure {
                    day: day.clone(),
                    error: err.message,
                });
                on_progress(&DayProgress {
                    day: day.clone(),
                    count: 0,
                    failed: true,
                });
                continue;
            }
        };
        upsert_all(db, &stories);
        fetched_days += 1;
        fetched += stories.len();
        on_progress(&DayProgress {
            day: day.clone(),
            count: stories.len(),
            failed: false,
        });
        if opts.throttle_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(opts.throttle_ms));
        }
    }

    SyncOutcome {
        days: days.len(),
        fetched_days,
        fetched,
        inserted: count_stories(db) - before,
        failures,
        from: None,
        to: None,
        front_page: None,
        scored: None,
    }
}

/// Upsert the current front page. Only worth doing when today is in scope.
pub fn sync_front_page(db: &Db, source: &dyn HnSource) -> Result<usize, FetchError> {
    let stories = source.fetch_front_page()?;
    upsert_all(db, &stories);
    Ok(stories.len())
}
