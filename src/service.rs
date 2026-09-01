//! Glue between the database, the model and the HTTP API: training, scoring,
//! the ranked feed, and the "what should I vote on next" queue.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use postgres::types::ToSql;
use postgres::Row;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::dates::{day_key, days_between, now_seconds, parse_day, recent_days};
use crate::db::{
    capture_prediction, get_meta, labelled_stories, record_vote, set_meta, vote_counts, Db, Story,
    VoteCounts, STORY_SELECT,
};
use crate::features::{describe_feature, featurize, FeatureDesc, StoryText};
use crate::firebase::{backfill_days, BackfillOptions, BackfillOutcome, DayStat};
use crate::hn::{sync_days, sync_front_page, DayProgress, HnSource, SyncOptions, SyncOutcome};
use crate::http_client::{Fetch, FetchError};
use crate::model::{
    cross_validate, fit, insights, mulberry32, score_features, to_runtime, Example, FitOptions,
    Insights, Metrics, Model, Runtime,
};

pub const MIN_VOTES_TO_TRAIN: i64 = 6; // below this, both classes are usually not present

/// Query parameters assembled at runtime. A filter list is built a clause at a
/// time and `postgres` wants one slice of trait objects at the call, so the
/// values are boxed on the way in and reborrowed on the way out.
pub(crate) type Params = Vec<Box<dyn ToSql + Sync>>;

pub(crate) fn refs(params: &Params) -> Vec<&(dyn ToSql + Sync)> {
    params.iter().map(|p| &**p as &(dyn ToSql + Sync)).collect()
}

/// Number the placeholders. Filters are written as bare `?` where they are
/// built, because a clause has no idea what position it will end up in;
/// Postgres wants `$1`, `$2`, … in order, so the assembled statement is
/// numbered once, last. Nothing here puts a literal `?` inside SQL text.
fn numbered(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len() + 16);
    let mut n = 0;
    for ch in sql.chars() {
        if ch == '?' {
            n += 1;
            out.push_str(&format!("${n}"));
        } else {
            out.push(ch);
        }
    }
    out
}

// Rows per multi-row INSERT. One statement per row is a function call against
// a file and a network round trip against a socket, and `rescore_all` writes
// one per story in the corpus. Five hundred rows is 2000 bound parameters at
// four columns, comfortably inside the protocol's 65535, and past a few
// hundred the saving flattens out.
const INSERT_CHUNK: usize = 500;

/// Write `items` as multi-row INSERTs, `INSERT_CHUNK` rows to a statement.
/// `head` is everything up to VALUES, `tail` the ON CONFLICT clause, and `row`
/// appends one item's parameters in column order.
pub(crate) fn insert_chunked<T>(
    db: &Db,
    head: &str,
    cols: usize,
    tail: &str,
    items: &[T],
    row: impl Fn(&T, &mut Params),
) {
    for chunk in items.chunks(INSERT_CHUNK) {
        let mut params: Params = Vec::with_capacity(chunk.len() * cols);
        for item in chunk {
            row(item, &mut params);
        }
        let values: Vec<String> = (0..chunk.len())
            .map(|i| {
                let ph: Vec<String> = (1..=cols).map(|c| format!("${}", i * cols + c)).collect();
                format!("({})", ph.join(","))
            })
            .collect();
        db.execute(
            &format!("{head} VALUES {} {tail}", values.join(",")),
            &refs(&params),
        )
        .expect("chunked insert");
    }
}

/// What `models.payload` holds — the exact JSON shape the Node backend wrote,
/// so a production database moves between backends without a migration.
#[derive(Serialize, Deserialize)]
struct Payload {
    model: Model,
    #[serde(default)]
    metrics: Option<Metrics>,
}

pub struct Cached {
    pub rev: i64,
    pub trained_at: i64,
    pub n_votes: i64,
    pub runtime: Runtime,
    pub metrics: Option<Metrics>,
}

/// The loaded model, shared by the request threads and the background trainer.
/// `load_model` revalidates against MAX(rev) on every call, so a train finished
/// on another thread is picked up without an explicit reset.
#[derive(Default)]
pub struct ModelCache {
    slot: Mutex<Option<Arc<Cached>>>,
}

impl ModelCache {
    /// The slot, with poison recovery: a panic in a request that held this
    /// guard (contained to a 500 by the server) must not wedge every later
    /// model load. The slot is derived data, so restoring its invariant is
    /// dropping whatever the panicking thread left and reloading from the
    /// database on the next call.
    fn slot(&self) -> std::sync::MutexGuard<'_, Option<Arc<Cached>>> {
        match self.slot.lock() {
            Ok(guard) => guard,
            Err(poisoned) => {
                let mut guard = poisoned.into_inner();
                *guard = None;
                guard
            }
        }
    }

    pub fn reset(&self) {
        *self.slot() = None;
    }
}

pub fn load_model(db: &Db, cache: &ModelCache) -> Option<Arc<Cached>> {
    let row = db
        .query_opt(
            "SELECT rev, trained_at, n_votes, payload FROM models ORDER BY rev DESC LIMIT 1",
            &[],
        )
        .expect("load_model")?;
    let (rev, trained_at, n_votes, payload): (i64, i64, i64, String) =
        (row.get(0), row.get(1), row.get(2), row.get(3));
    {
        let slot = cache.slot();
        if let Some(cached) = slot.as_ref() {
            if cached.rev == rev {
                return Some(Arc::clone(cached));
            }
        }
    }
    // Parse with no guard held: a malformed payload panics (the server turns
    // it into a 500, per request, the way the Node backend's JSON.parse threw)
    // and must not take the cache down with it.
    let payload: Payload = serde_json::from_str(&payload).expect("model payload");
    let cached = Arc::new(Cached {
        rev,
        trained_at,
        n_votes,
        runtime: to_runtime(payload.model),
        metrics: payload.metrics,
    });
    // The database read and the cache publication are deliberately separated
    // so payload parsing cannot panic while holding the cache guard. A trainer
    // may publish a newer revision in that gap, though, so compare again while
    // publishing and never let this older read move the shared cache backwards.
    let mut slot = cache.slot();
    if let Some(current) = slot.as_ref() {
        if current.rev >= cached.rev {
            return Some(Arc::clone(current));
        }
    }
    *slot = Some(Arc::clone(&cached));
    Some(cached)
}

fn story_text(s: &Story) -> StoryText<'_> {
    StoryText {
        title: &s.title,
        url: s.url.as_deref(),
        domain: s.domain.as_deref(),
        author: s.author.as_deref(),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Need {
    pub up: i64,
    pub down: i64,
}

pub enum TrainOutcome {
    NotTrained {
        reason: &'static str,
        need: Need,
        counts: VoteCounts,
    },
    Trained {
        rev: i64,
        scored: usize,
        metrics: Option<Metrics>,
        counts: VoteCounts,
        insights: Insights,
    },
}

impl TrainOutcome {
    pub fn trained(&self) -> bool {
        matches!(self, TrainOutcome::Trained { .. })
    }

    pub fn rev(&self) -> Option<i64> {
        match self {
            TrainOutcome::Trained { rev, .. } => Some(*rev),
            TrainOutcome::NotTrained { .. } => None,
        }
    }

    pub fn scored(&self) -> Option<usize> {
        match self {
            TrainOutcome::Trained { scored, .. } => Some(*scored),
            TrainOutcome::NotTrained { .. } => None,
        }
    }

    pub fn metrics(&self) -> Option<&Metrics> {
        match self {
            TrainOutcome::Trained { metrics, .. } => metrics.as_ref(),
            TrainOutcome::NotTrained { .. } => None,
        }
    }

    pub fn counts(&self) -> &VoteCounts {
        match self {
            TrainOutcome::Trained { counts, .. } | TrainOutcome::NotTrained { counts, .. } => {
                counts
            }
        }
    }

    pub fn to_json(&self) -> Value {
        match self {
            TrainOutcome::NotTrained {
                reason,
                need,
                counts,
            } => json!({
                "trained": false, "reason": reason, "need": need, "counts": counts,
            }),
            TrainOutcome::Trained {
                rev,
                scored,
                metrics,
                counts,
                insights,
            } => json!({
                "trained": true, "rev": rev, "scored": scored,
                "metrics": metrics, "counts": counts, "insights": insights,
            }),
        }
    }
}

/// Retrain from every vote, store the snapshot, and rescore the whole corpus.
pub fn train_and_score(db: &Db, cache: &ModelCache, options: FitOptions) -> TrainOutcome {
    let labelled = labelled_stories(db);
    let counts = vote_counts(db);
    if (labelled.len() as i64) < MIN_VOTES_TO_TRAIN
        || !labelled.iter().any(|s| s.value > 0)
        || !labelled.iter().any(|s| s.value < 0)
    {
        return TrainOutcome::NotTrained {
            reason: "need_more_votes",
            need: Need {
                up: (3 - counts.up).max(0),
                down: (3 - counts.down).max(0),
            },
            counts,
        };
    }

    // Every vote is an example. Two submissions of the same article are two
    // separate titles you read and judged, so they carry twice the weight on
    // purpose — the repeat is signal about phrasing, not a duplicate to collapse.
    let examples: Vec<Example> = labelled
        .iter()
        .map(|l| Example {
            id: Some(l.story.id),
            features: featurize(story_text(&l.story)),
            label: u8::from(l.value > 0),
        })
        .collect();
    let model = fit(&examples, options);
    let cv = cross_validate(&examples, options, 5);
    let (metrics, held_out) = match cv {
        Some(outcome) => (Some(outcome.metrics), outcome.held_out),
        None => (None, Vec::new()),
    };

    let trained_at = now_seconds();
    // `held_out` is one row per vote and lives in its own table; keeping it in
    // the payload too would grow every snapshot by the whole vote history.
    let payload = serde_json::to_string(&Payload {
        model: model.clone(),
        metrics: metrics.clone(),
    })
    .expect("payload json");
    // RETURNING rather than a follow-up "what id did that get": one round
    // trip, and no window in which another writer could answer it wrong.
    let rev: i64 = db
        .query_one(
            "INSERT INTO models (trained_at, n_votes, payload) VALUES ($1, $2, $3) RETURNING rev",
            &[&trained_at, &(examples.len() as i64), &payload],
        )
        .expect("insert model")
        .get(0);
    store_held_out(db, &held_out, rev);

    let model_insights = insights(&model, 12, 2);
    let cached = Arc::new(Cached {
        rev,
        trained_at,
        n_votes: examples.len() as i64,
        runtime: to_runtime(model),
        metrics: metrics.clone(),
    });
    *cache.slot() = Some(Arc::clone(&cached));
    let scored = rescore_all(db, &cached);
    set_meta(db, "last_train_at", &trained_at.to_string());

    TrainOutcome::Trained {
        rev,
        scored,
        metrics,
        counts,
        insights: model_insights,
    }
}

/// Replace the held-out predictions with this revision's, keeping the outgoing
/// set as `oof_previous`.
///
/// Whole-table rewrite rather than an upsert: a vote that was removed since the
/// last train must not leave a stale row behind, and 386 rows is nothing. With
/// no cross-validation (too few votes for two folds) the table is simply empty —
/// better than serving predictions from a model that never held anything out.
///
/// The copy is what makes an accuracy move testable. Two revisions' accuracies
/// are two scorings of nearly the same votes, so the comparison is paired, and
/// the paired evidence is the set of votes whose held-out call changed sides.
/// That set exists for exactly as long as both revisions' predictions do, which
/// is why the outgoing rows are moved rather than dropped. One revision back is
/// enough: a round is one retrain, so the summary never reaches further.
pub fn store_held_out(db: &Db, held_out: &[(i64, f64)], rev: i64) -> usize {
    db.begin();
    // Shift, don't accumulate: SQL-side so the whole vote history never makes
    // the trip through the app to be handed straight back.
    db.execute_batch(
        "DELETE FROM oof_previous;
         INSERT INTO oof_previous (story_id, score, model_rev) SELECT story_id, score, model_rev FROM oof_scores;
         DELETE FROM oof_scores;",
    )
    .expect("shift oof");
    insert_chunked(
        db,
        "INSERT INTO oof_scores (story_id, score, model_rev)",
        3,
        "",
        held_out,
        |(id, score), params| {
            params.push(Box::new(*id));
            params.push(Box::new(*score));
            params.push(Box::new(rev));
        },
    );
    db.commit();
    held_out.len()
}

const UPSERT_SCORE_HEAD: &str = "INSERT INTO scores (story_id, score, confidence, model_rev)";
const UPSERT_SCORE_TAIL: &str = "
    ON CONFLICT(story_id) DO UPDATE SET
      score = excluded.score, confidence = excluded.confidence, model_rev = excluded.model_rev";

/// The shared tail of `rescore_all` and `score_missing`: score every story and
/// write the results in chunks, inside one transaction.
fn write_scores(db: &Db, stories: &[Story], current: &Cached) -> usize {
    let scored: Vec<(i64, f64, f64)> = stories
        .iter()
        .map(|s| {
            let r = score_features(&current.runtime, &featurize(story_text(s)), false);
            (s.id, r.score, r.confidence)
        })
        .collect();
    db.begin();
    insert_chunked(
        db,
        UPSERT_SCORE_HEAD,
        4,
        UPSERT_SCORE_TAIL,
        &scored,
        |(id, score, confidence), params| {
            params.push(Box::new(*id));
            params.push(Box::new(*score));
            params.push(Box::new(*confidence));
            params.push(Box::new(current.rev));
        },
    );
    db.commit();
    scored.len()
}

/// The five columns `featurize` reads, in `scoring_story`'s order.
const SCORING_COLUMNS: &str = "s.id, s.title, s.url, s.domain, s.author";

/// A story with only the scoring columns filled in. The rest are never read on
/// this path — `featurize` sees the title, the url, the domain and the author,
/// and nothing else is a feature.
fn scoring_story(r: &Row) -> Story {
    Story {
        id: r.get(0),
        title: r.get(1),
        url: r.get(2),
        domain: r.get(3),
        author: r.get(4),
        points: 0,
        num_comments: 0,
        created_at: 0,
        day: String::new(),
        fetched_at: 0,
    }
}

pub fn rescore_all(db: &Db, current: &Cached) -> usize {
    let stories: Vec<Story> = db
        .query(&format!("SELECT {SCORING_COLUMNS} FROM stories s"), &[])
        .expect("stories query")
        .iter()
        .map(scoring_story)
        .collect();
    write_scores(db, &stories, current)
}

/// Score any freshly fetched stories without a full retrain.
pub fn score_missing(db: &Db, cache: &ModelCache) -> usize {
    let Some(current) = load_model(db, cache) else {
        return 0;
    };
    let stories: Vec<Story> = db
        .query(
            &format!(
                "SELECT {SCORING_COLUMNS} FROM stories s
                 LEFT JOIN scores sc ON sc.story_id = s.id
                 WHERE sc.story_id IS NULL OR sc.model_rev != $1"
            ),
            &[&current.rev],
        )
        .expect("missing query")
        .iter()
        .map(scoring_story)
        .collect();
    write_scores(db, &stories, &current)
}

#[derive(Debug, Clone, Default)]
pub struct SyncRequest {
    pub days: Option<u32>,
    pub from: Option<String>,
    pub to: Option<String>,
    pub front_page: Option<bool>,
    pub options: Option<SyncOptions>,
}

impl SyncRequest {
    pub fn to_json(&self) -> Value {
        let mut out = serde_json::Map::new();
        if let Some(from) = &self.from {
            out.insert("from".into(), json!(from));
            if let Some(to) = &self.to {
                out.insert("to".into(), json!(to));
            }
        } else {
            out.insert("days".into(), json!(self.days.unwrap_or(2)));
        }
        if let Some(o) = &self.options {
            out.insert("pagesPerDay".into(), json!(o.pages_per_day));
            out.insert("minPoints".into(), json!(o.min_points));
        }
        Value::Object(out)
    }
}

/// Pull stories from HN into the database, then score whatever the current
/// model has not seen. The one way stories enter the database: give it either a
/// rolling window (`days`, default the last two) or an explicit range
/// (`from`/`to`, defaulting `to` to today), and it walks those days
/// oldest-first through `sync_days()`.
///
/// Scoring is folded in on purpose — a story with no score is invisible to the
/// ranked feed, so "fetch" and "score the new arrivals" are one operation and
/// no caller has to remember the second half.
///
/// The front page is fetched only when today is in scope, since that is the
/// only case where it can hold anything the day queries have not already seen.
pub fn sync(
    db: &Db,
    cache: &ModelCache,
    req: &SyncRequest,
    source: &dyn HnSource,
    on_progress: &mut dyn FnMut(&DayProgress),
) -> Result<SyncOutcome, String> {
    let now = now_seconds();
    let today = day_key(now);
    let mut list = match &req.from {
        Some(from) => days_between(from, req.to.as_deref().unwrap_or(&today))?,
        None => recent_days(req.days.unwrap_or(2), now),
    };
    list.sort();
    let opts = req.options.unwrap_or_default();
    let count = |db: &Db| -> i64 {
        db.query_one("SELECT COUNT(*) FROM stories", &[])
            .expect("count")
            .get(0)
    };
    let before = count(db);
    let mut result = sync_days(db, &list, &opts, source, on_progress);
    result.from = list.first().cloned();
    result.to = list.last().cloned();
    let want_front_page = req.front_page.unwrap_or_else(|| list.contains(&today));
    let front_page = if want_front_page {
        sync_front_page(db, source).map_err(|e| e.message)?
    } else {
        0
    };
    result.front_page = Some(front_page);
    result.fetched += front_page;
    // sync_days counts its own inserts; recount so front-page arrivals are in it.
    result.inserted = count(db) - before;
    result.scored = Some(score_missing(db, cache));
    set_meta(db, "last_sync_at", &now.to_string());
    Ok(result)
}

/// Repair a range of days from Firebase: the stories Algolia's index never got.
///
/// Deliberately not part of `sync()` and not on a timer — it costs roughly one
/// request per Hacker News item rather than ten per day, which is affordable
/// once for a known gap and never as a routine. It scores what it recovers, for
/// the same reason `sync()` does: an unscored story is invisible to the feed.
///
/// It does **not** stamp `last_sync_at`. That stamp claims the corpus is fresh
/// through now, which repairing a historical day does not make true.
pub fn backfill(
    db: &Db,
    cache: &ModelCache,
    from: &str,
    to: Option<&str>,
    opts: &BackfillOptions,
    fetch: &dyn Fetch,
    on_progress: &mut dyn FnMut(&DayStat),
) -> Result<BackfillOutcome, String> {
    let list = days_between(from, to.unwrap_or(from))?;
    let mut result =
        backfill_days(db, &list, opts, fetch, on_progress).map_err(|e: FetchError| e.message)?;
    result.from = list.first().cloned();
    result.to = list.last().cloned();
    result.scored = Some(if opts.dry_run {
        0
    } else {
        score_missing(db, cache)
    });
    Ok(result)
}

/* ----------------------------------------------------------------- the feed */

const STORY_COLUMNS: &str = "
  s.id, s.title, s.url, s.domain, s.author, s.points, s.num_comments,
  s.created_at, s.day, sc.score, sc.confidence, v.value AS vote
";
const STORY_JOINS: &str = "
  FROM stories s
  LEFT JOIN scores sc ON sc.story_id = s.id
  LEFT JOIN votes  v  ON v.story_id  = s.id
";

/// One story as the API serves it. The base columns are always present
/// (nulls included); the tail fields only exist where the Node responses
/// carried them (reason on queue cards, tier on Explore, the vote log pair).
#[derive(Debug, Clone, Serialize)]
pub struct StoryRow {
    pub id: i64,
    pub title: String,
    pub url: Option<String>,
    pub domain: Option<String>,
    pub author: Option<String>,
    pub points: i64,
    pub num_comments: i64,
    pub created_at: i64,
    pub day: String,
    pub score: Option<f64>,
    pub confidence: Option<f64>,
    pub vote: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voted_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oof_score: Option<f64>,
}

fn story_row(r: &Row) -> StoryRow {
    StoryRow {
        id: r.get(0),
        title: r.get(1),
        url: r.get(2),
        domain: r.get(3),
        author: r.get(4),
        points: r.get(5),
        num_comments: r.get(6),
        created_at: r.get(7),
        day: r.get(8),
        score: r.get(9),
        confidence: r.get(10),
        vote: r.get(11),
        reason: None,
        tier: None,
        voted_at: None,
        oof_score: None,
    }
}

#[derive(Debug, Clone)]
pub struct FeedOptions {
    pub mode: String,
    pub days: i64,
    pub min_score: f64,
    pub max_score: f64,
    pub min_points: i64,
    pub min_comments: i64,
    pub limit: i64,
    pub offset: i64,
    pub include_voted: bool,
    pub day: Option<String>,
    pub query: Option<String>,
}

impl Default for FeedOptions {
    fn default() -> Self {
        FeedOptions {
            mode: "foryou".to_string(),
            days: 7,
            min_score: 0.0,
            max_score: 1.0,
            min_points: 0,
            min_comments: 0,
            limit: 50,
            offset: 0,
            include_voted: false,
            day: None,
            query: None,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Feed {
    pub total: i64,
    #[serde(rename = "hasModel")]
    pub has_model: bool,
    pub items: Vec<StoryRow>,
}

/// The ranked feed. Filtering, ordering and pagination all happen in SQL so
/// the result is exact however large the corpus grows (a backfilled archive
/// holds tens of thousands of stories; an app-side candidate cap silently
/// dropped everything past it — and, without an ORDER BY, kept the oldest).
pub fn feed(db: &Db, cache: &ModelCache, opts: &FeedOptions) -> Feed {
    let has_model = load_model(db, cache).is_some();

    let mut wheres: Vec<String> = Vec::new();
    let mut params: Params = Vec::new();
    // Two floors on the same axis and deliberately separate: points are the
    // crowd's verdict on the link, comments are how much it was argued about,
    // and a story is regularly one without the other.
    if opts.min_points > 0 {
        wheres.push("s.points >= ?".into());
        params.push(Box::new(opts.min_points));
    }
    if opts.min_comments > 0 {
        wheres.push("s.num_comments >= ?".into());
        params.push(Box::new(opts.min_comments));
    }
    if let Some(day) = &opts.day {
        wheres.push("s.day = ?".into());
        params.push(Box::new(day.clone()));
    } else if opts.days > 0 {
        wheres.push("s.created_at >= ?".into());
        params.push(Box::new(now_seconds() - opts.days * 86400));
    }
    if !opts.include_voted {
        wheres.push("(v.value IS NULL OR v.value = 0)".into());
    }
    if let Some(query) = &opts.query {
        wheres.push("LOWER(s.title) LIKE ?".into());
        params.push(Box::new(format!("%{}%", query.to_lowercase())));
    }
    // Never show unscored stories. A title the model has not looked at has no
    // business in a ranked feed, and pretending it is a 0.5 would leak it into
    // score bands. Before the first model that means an empty feed — the Train
    // tab is how you get past that. Unscored is transient otherwise: sync()
    // runs score_missing() on what it fetched before it returns.
    wheres.push("sc.score IS NOT NULL".into());
    if opts.min_score > 0.0 {
        wheres.push("sc.score >= ?".into());
        params.push(Box::new(opts.min_score));
    }
    // Exclusive upper bound so adjacent histogram buckets don't overlap; 1 means "no cap".
    if opts.max_score < 1.0 {
        wheres.push("sc.score < ?".into());
        params.push(Box::new(opts.max_score));
    }

    let scope = format!(
        "{STORY_JOINS} {}",
        if wheres.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", wheres.join(" AND "))
        }
    );
    let total: i64 = db
        .query_one(
            &numbered(&format!("SELECT COUNT(*) AS n {scope}")),
            &refs(&params),
        )
        .expect("feed count")
        .get(0);

    let mut order_params: Params = Vec::new();
    let order_by = match opts.mode.as_str() {
        "top" => "s.num_comments DESC, s.points DESC".to_string(),
        "new" => "s.created_at DESC".to_string(),
        "hybrid" => {
            // Blends taste with the crowd, so the feed keeps some serendipity.
            // Popularity is log-scaled relative to the busiest story in scope.
            let max_comments: Option<i64> = db
                .query_one(
                    &numbered(&format!("SELECT MAX(s.num_comments) AS m {scope}")),
                    &refs(&params),
                )
                .expect("max comments")
                .get(0);
            let max_comments = max_comments.unwrap_or(0);
            order_params.push(Box::new((1.0 + max_comments.max(20) as f64).ln()));
            // ln() takes double precision; `1 + num_comments` is bigint, which
            // would otherwise resolve to the numeric overload and hand back a
            // numeric the row reader has no mapping for.
            "0.7 * sc.score + 0.3 * ln((1 + s.num_comments)::double precision) / ? DESC".to_string()
        }
        _ => "sc.score DESC, s.num_comments DESC".to_string(),
    };

    let mut all_params = params;
    all_params.extend(order_params);
    all_params.push(Box::new(opts.limit));
    all_params.push(Box::new(opts.offset));
    let items: Vec<StoryRow> = db
        .query(
            &numbered(&format!(
                "SELECT {STORY_COLUMNS} {scope} ORDER BY {order_by}, s.id DESC LIMIT ? OFFSET ?"
            )),
            &refs(&all_params),
        )
        .expect("feed query")
        .iter()
        .map(|r| {
            let mut row = story_row(r);
            if row.confidence.is_none() {
                row.confidence = Some(0.0);
            }
            row
        })
        .collect();

    Feed {
        total,
        has_model,
        items,
    }
}

#[derive(Debug, Serialize)]
pub struct VoteLog {
    pub total: i64,
    pub counts: VoteCounts,
    pub items: Vec<StoryRow>,
}

/// Every vote, newest verdict first — the "my votes" list.
///
/// Filtering and paging stay in SQL, like the feed. `value` is 1 / -1 / 0 to
/// show one verdict only, or None for all of them. Skips are votes too, so
/// they are included unless filtered out.
pub fn vote_log(db: &Db, value: Option<i64>, limit: i64, offset: i64) -> VoteLog {
    let mut wheres: Vec<String> = Vec::new();
    let mut params: Params = Vec::new();
    if let Some(v) = value {
        wheres.push("v.value = ?".into());
        params.push(Box::new(v));
    }

    // Driven from `votes`, so this is an inner join, unlike the feed's joins.
    let scope = format!(
        "FROM votes v
         JOIN stories s ON s.id = v.story_id
         LEFT JOIN scores sc ON sc.story_id = s.id
         LEFT JOIN oof_scores oof ON oof.story_id = s.id
         {}",
        if wheres.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", wheres.join(" AND "))
        }
    );
    let total: i64 = db
        .query_one(
            &numbered(&format!("SELECT COUNT(*) AS n {scope}")),
            &refs(&params),
        )
        .expect("votes count")
        .get(0);
    params.push(Box::new(limit));
    params.push(Box::new(offset));
    let items: Vec<StoryRow> = db
        .query(
            &numbered(&format!(
                "SELECT {STORY_COLUMNS}, v.updated_at AS voted_at, oof.score AS oof_score
                 {scope} ORDER BY v.updated_at DESC, v.story_id DESC LIMIT ? OFFSET ?"
            )),
            &refs(&params),
        )
        .expect("votes query")
        .iter()
        .map(|r| {
            let mut row = story_row(r);
            row.voted_at = r.get(12);
            row.oof_score = r.get(13);
            row
        })
        .collect();

    VoteLog {
        total,
        counts: vote_counts(db),
        items,
    }
}

/* --------------------------------------------------------- training queue */

// A swipe is only worth spending if the submission was worth reading. HN's
// long tail of one- and two-point posts is mostly links nobody opened, and at
// archive scale it is *most* of the corpus — without a floor the deck fills
// with dead weight from 2021. Ten is deliberately steep; raising the pool
// later is a one-line change, unlearning a thousand votes on junk is not.
pub const QUEUE_MIN_POINTS: i64 = 10;

// `scores` holds the shrunk score: 0.5 + (raw - 0.5) * (0.3 + 0.7 * confidence)
// (model.rs). So ordering by |score - 0.5| ranks by *ignorance*, not by
// uncertainty — a title with no known words is pushed onto the boundary and
// outranks one the model knows well and still cannot call. Undoing the
// shrinkage recovers the honest distance, and costs nothing: both halves are
// stored. Signed, so a range seek around 0 is a seek around "undecided", and
// idx_scores_raw_offset indexes exactly this expression.
// Character-identical to the expression `idx_scores_raw_offset` is built on
// (db.rs), alias aside. The `::double precision` casts are the load-bearing
// part: without them the literals are `numeric`, the two expressions do not
// match after type resolution, and the planner drops the index and scans —
// correct answers, and the seek-not-scan promise quietly gone.
const RAW_OFFSET: &str = "((sc.score - 0.5::double precision) / (0.3::double precision + 0.7::double precision * sc.confidence))";

fn raw_offset(r: &StoryRow) -> f64 {
    (r.score.unwrap_or(0.5) - 0.5) / (0.3 + 0.7 * r.confidence.unwrap_or(0.0))
}

const BOUNDARY_BAND: f64 = 0.15; //          how far from 0.5 still counts as undecided
const BOUNDARY_MIN_CONFIDENCE: f64 = 0.4; // below this, hesitation is just an unread word
const NOVEL_MAX_CONFIDENCE: f64 = 0.4; //    the other end: titles with no vocabulary at all
const RECENT_WINDOW_DAYS: i64 = 3;
const MAX_PROBES: usize = 8; //              seeded probes per slot before giving up on a stratum
                             // A seek lands on the first row past its target, so where a band holds few
                             // distinct scores every target in a gap collapses onto the same row and the
                             // next page redraws the last one. Stepping each page a little further past the
                             // target breaks that tie. Bounded and tiny: an index scan of a few rows.
const PAGE_STEP: i64 = 8;

// LIMIT and OFFSET are written into the SQL, never bound. A bound limit is
// opaque to the planner, which then sorts the whole candidate set instead of
// keeping a bounded top-N — measured at 21 ms against a million rows where the
// same query with a literal limit costs 0.4 ms. `int()` is what keeps that
// safe: every interpolated number goes through it.
fn int(n: i64) -> i64 {
    assert!(n >= 0, "bad row count: {n}");
    n
}

// Every stratum drives from `scores` rather than from `stories`, so the
// planner can open an expression index and seek instead of scanning. That is
// the whole scalability story: a batch costs ~`limit` index seeks whether the
// archive holds ten thousand stories or ten million.
const SCORED_FROM: &str = "
  FROM scores sc
  JOIN stories s ON s.id = sc.story_id
";

// The other queue shape: driven from `stories`, for the strata that rank on
// something the scores table does not hold (recency, id order, traction).
const UNSCORED_FROM: &str = "
  FROM stories s
  LEFT JOIN scores sc ON sc.story_id = s.id
";

/// "Nobody has judged this yet" — and a skip is a judgement, so this covers
/// `value = 0` as well.
///
/// An anti-join, deliberately, where this used to be a LEFT JOIN plus
/// `v.value IS NULL`. That form reads the same and plans catastrophically:
/// `votes.value` is NOT NULL, so Postgres's null fraction for it is zero, it
/// estimates the whole join at one row, and from there a sequential scan of
/// `stories` costs the same as anything else — so it takes one, and the
/// score-axis seek this entire module exists to make possible never happens.
/// Measured on the real 52k corpus: a seq scan of `stories` before, an index
/// scan on `idx_scores_raw_offset` and 0.08 ms after. It produces the same
/// rows either way, which is exactly why it needed measuring rather than
/// testing.
const UNJUDGED: &str = "NOT EXISTS (SELECT 1 FROM votes v WHERE v.story_id = s.id)";

// The queue only ever offers unjudged stories, so `vote` is NULL by
// construction rather than by lookup — there is no `votes` row to read it off.
const QUEUE_COLUMNS: &str = "
  s.id, s.title, s.url, s.domain, s.author, s.points, s.num_comments,
  s.created_at, s.day, sc.score, sc.confidence, NULL::bigint AS vote
";

struct DrawContext<'a> {
    quota: usize,
    picked: &'a mut HashSet<i64>,
    rng: &'a mut dyn FnMut() -> f64,
    min_points: i64,
    cursor: i64,
}

/// The deck is drawn from four strata, each answering a different question.
/// Shares are of `limit`; a stratum that comes up short is topped up from the
/// boundary outwards. None of them is ordered by recency — that is what stops a
/// deck from clustering on whichever days happen to be newest.
const STRATA: [(&str, f64); 4] = [
    // Where a vote moves the weights most: the model knows the words and still
    // cannot decide.
    ("boundary", 0.4),
    // Vocabulary growth. The old queue did this with every slot, by accident;
    // here it gets a budget.
    ("novel", 0.2),
    // At archive scale today is a rounding error. A news app that never shows
    // the news is broken however well it ranks.
    ("recent", 0.2),
    // Uniform over the whole history: the only labels not selected by what the
    // model already believes, and so the only ones that can catch a blind spot
    // it does not know it has.
    ("explore", 0.2),
];

/// What to show in the thumbs-up/down trainer.
///
/// With no model: the most discussed stories first (fast, familiar signal).
/// With one: a stratified sample, seeded on the model revision so a refill
/// mid-swipe does not reshuffle the cards behind the one on screen. `cursor`
/// walks that stream for the next page.
pub fn training_queue(
    db: &Db,
    cache: &ModelCache,
    limit: usize,
    cursor: i64,
    min_points: i64,
) -> Vec<StoryRow> {
    let Some(current) = load_model(db, cache) else {
        return cold_queue(db, limit, min_points);
    };

    let seed = (current.rev as i32)
        .wrapping_mul(0x9e37_79b1_u32 as i32)
        .wrapping_add(((cursor + 1) as i32).wrapping_mul(0x85eb_ca6b_u32 as i32))
        as u32;
    let mut rng = mulberry32(seed);
    let mut picked: HashSet<i64> = HashSet::new();
    let quotas = allocate(limit, &STRATA.map(|(_, share)| share));
    let mut buckets: Vec<Vec<StoryRow>> = Vec::new();
    for (i, (reason, _)) in STRATA.iter().enumerate() {
        if quotas[i] == 0 {
            buckets.push(Vec::new());
            continue;
        }
        let mut ctx = DrawContext {
            quota: quotas[i],
            picked: &mut picked,
            rng: &mut rng,
            min_points,
            cursor,
        };
        let mut rows = match *reason {
            "boundary" => draw_boundary(db, &mut ctx),
            "novel" => draw_novel(db, &mut ctx),
            "recent" => draw_recent(db, &mut ctx),
            _ => draw_explore(db, &mut ctx),
        };
        for r in &mut rows {
            r.reason = Some((*reason).to_string());
        }
        buckets.push(rows);
    }

    let mut out = interleave(buckets, limit);
    if out.len() < limit {
        out.extend(fill_from_boundary(
            db,
            limit - out.len(),
            &mut picked,
            min_points,
        ));
    }
    out
}

/// Before any model exists there is nothing to be uncertain about.
fn cold_queue(db: &Db, limit: usize, min_points: i64) -> Vec<StoryRow> {
    db.query(
        &format!(
            "SELECT {QUEUE_COLUMNS} {UNSCORED_FROM}
             WHERE {UNJUDGED} AND s.points >= $1
             ORDER BY s.num_comments DESC, s.id DESC
             LIMIT {}",
            int(limit as i64)
        ),
        &[&min_points],
    )
    .expect("cold query")
    .iter()
    .map(|r| {
        let mut row = story_row(r);
        row.reason = Some("popular".to_string());
        row
    })
    .collect()
}

/// Draw `quota` rows by seeded probe: pick a random key, seek the first
/// unjudged story at or past it. Sampling by *key* rather than by row offset is
/// what keeps this O(log n) — counting the band first would be the one query
/// that scans it. A probe past the end wraps to the band's floor.
fn probe(
    quota: usize,
    picked: &mut HashSet<i64>,
    mut once: impl FnMut() -> Option<StoryRow>,
) -> Vec<StoryRow> {
    let mut rows = Vec::new();
    let mut attempts = 0;
    let mut misses = 0;
    while rows.len() < quota && attempts < quota * MAX_PROBES {
        attempts += 1;
        let Some(row) = once() else {
            // Two empty seeks in a row means the stratum itself is empty, not that
            // we were unlucky: stop rather than burn the whole probe budget on it.
            misses += 1;
            if misses >= 2 {
                break;
            }
            continue;
        };
        misses = 0;
        if !picked.insert(row.id) {
            continue;
        }
        rows.push(row);
    }
    rows
}

/// Take up to `quota` not-yet-picked rows from an ordered list.
fn take(rows: Vec<StoryRow>, quota: usize, picked: &mut HashSet<i64>) -> Vec<StoryRow> {
    let mut out = Vec::new();
    for r in rows {
        if out.len() >= quota {
            break;
        }
        if !picked.insert(r.id) {
            continue;
        }
        out.push(r);
    }
    out
}

fn seek_one(db: &Db, sql: &str, params: &Params) -> Option<StoryRow> {
    db.query_opt(sql, &refs(params))
        .expect("seek")
        .as_ref()
        .map(story_row)
}

fn draw_boundary(db: &Db, ctx: &mut DrawContext) -> Vec<StoryRow> {
    let (min_points, quota) = (ctx.min_points, ctx.quota);
    // `, s.id` is not decoration: Postgres promises nothing about how it
    // breaks ties, and a band holds plenty of stories on the same offset. A
    // round has to redraw identically on a reload, which means the seek has to
    // land on the same row every time.
    let body = numbered(&format!(
        "SELECT {QUEUE_COLUMNS} {SCORED_FROM}
         WHERE {RAW_OFFSET} >= ? AND {RAW_OFFSET} <= ?
           AND sc.confidence >= ? AND s.points >= ? AND {UNJUDGED}
         ORDER BY {RAW_OFFSET}, s.id"
    ));
    let paged = format!(
        "{body} LIMIT 1 OFFSET {}",
        int(ctx.cursor.rem_euclid(PAGE_STEP))
    );
    let first = format!("{body} LIMIT 1");
    let seek = move |from: f64| {
        let params: Params = vec![
            Box::new(from),
            Box::new(BOUNDARY_BAND),
            Box::new(BOUNDARY_MIN_CONFIDENCE),
            Box::new(min_points),
        ];
        seek_one(db, &paged, &params).or_else(|| seek_one(db, &first, &params))
    };
    let rng = &mut *ctx.rng;
    probe(quota, ctx.picked, || {
        seek((rng() * 2.0 - 1.0) * BOUNDARY_BAND).or_else(|| seek(-BOUNDARY_BAND))
    })
}

fn draw_novel(db: &Db, ctx: &mut DrawContext) -> Vec<StoryRow> {
    let (min_points, quota) = (ctx.min_points, ctx.quota);
    // `, s.id` for the same reason as `draw_boundary`, and more sharply here:
    // an unread title's confidence is often exactly 0, so a whole stratum can
    // sit on one key.
    let body = numbered(&format!(
        "SELECT {QUEUE_COLUMNS} {SCORED_FROM}
         WHERE sc.confidence >= ? AND sc.confidence < ?
           AND s.points >= ? AND {UNJUDGED}
         ORDER BY sc.confidence, s.id"
    ));
    let paged = format!(
        "{body} LIMIT 1 OFFSET {}",
        int(ctx.cursor.rem_euclid(PAGE_STEP))
    );
    let first = format!("{body} LIMIT 1");
    let seek = move |from: f64| {
        let params: Params = vec![
            Box::new(from),
            Box::new(NOVEL_MAX_CONFIDENCE),
            Box::new(min_points),
        ];
        seek_one(db, &paged, &params).or_else(|| seek_one(db, &first, &params))
    };
    let rng = &mut *ctx.rng;
    probe(quota, ctx.picked, || {
        seek(rng() * NOVEL_MAX_CONFIDENCE).or_else(|| seek(0.0))
    })
}

/// The one stratum that is ranked, not sampled: today's deck, best first.
/// The page offset cycles with PAGE_STEP rather than climbing forever — the
/// recent window is only a few thousand stories wide, and an offset that ran
/// past its end would quietly stop showing the news after a dozen refills.
fn draw_recent(db: &Db, ctx: &mut DrawContext) -> Vec<StoryRow> {
    let quota = ctx.quota as i64;
    let rows: Vec<StoryRow> = db
        .query(
            &format!(
                "SELECT {QUEUE_COLUMNS} {UNSCORED_FROM}
                 WHERE {UNJUDGED} AND s.created_at >= $1 AND s.points >= $2
                 ORDER BY s.num_comments DESC, s.id DESC
                 LIMIT {} OFFSET {}",
                int(quota * 3),
                int(ctx.cursor.rem_euclid(PAGE_STEP) * quota)
            ),
            &[
                &(now_seconds() - RECENT_WINDOW_DAYS * 86400),
                &ctx.min_points,
            ],
        )
        .expect("recent query")
        .iter()
        .map(story_row)
        .collect();
    take(rows, ctx.quota, ctx.picked)
}

/// Uniform over the whole archive. HN ids climb monotonically with time, so a
/// uniform draw over the id range is a uniform draw over history — and the
/// primary key makes each one a single seek, however many years are stored.
fn draw_explore(db: &Db, ctx: &mut DrawContext) -> Vec<StoryRow> {
    // One statement asking for both MIN and MAX scans the table; only a lone
    // MIN or a lone MAX is rewritten into an index lookup, in Postgres as in
    // SQLite. Two queries, 23 ms saved per deck against a million rows.
    let lo: Option<i64> = db
        .query_one("SELECT MIN(id) AS v FROM stories", &[])
        .expect("min id")
        .get(0);
    let hi: Option<i64> = db
        .query_one("SELECT MAX(id) AS v FROM stories", &[])
        .expect("max id")
        .get(0);
    let (Some(lo), Some(hi)) = (lo, hi) else {
        return Vec::new();
    };
    let (min_points, quota) = (ctx.min_points, ctx.quota);
    let body = numbered(&format!(
        "SELECT {QUEUE_COLUMNS} {UNSCORED_FROM}
         WHERE s.id >= ? AND s.points >= ? AND {UNJUDGED}
         ORDER BY s.id"
    ));
    let paged = format!(
        "{body} LIMIT 1 OFFSET {}",
        int(ctx.cursor.rem_euclid(PAGE_STEP))
    );
    let first = format!("{body} LIMIT 1");
    let seek = move |from: i64| {
        let params: Params = vec![Box::new(from), Box::new(min_points)];
        seek_one(db, &paged, &params).or_else(|| seek_one(db, &first, &params))
    };
    let rng = &mut *ctx.rng;
    probe(quota, ctx.picked, || {
        seek(lo + (rng() * (hi - lo + 1) as f64).floor() as i64).or_else(|| seek(lo))
    })
}

/// Fill a short batch from the boundary outwards. Two one-sided seeks merged in
/// the app, rather than `ORDER BY abs(...)`: abs() cannot use the index, and this
/// path exists precisely for the case where the strata came up empty — a young
/// model over a large archive, where a scan would hurt most.
fn fill_from_boundary(
    db: &Db,
    need: usize,
    picked: &mut HashSet<i64>,
    min_points: i64,
) -> Vec<StoryRow> {
    let want = need + picked.len();
    let side = |cmp: &str, dir: &str| -> Vec<StoryRow> {
        db.query(
            &format!(
                "SELECT {QUEUE_COLUMNS} {SCORED_FROM}
                 WHERE {RAW_OFFSET} {cmp} 0 AND s.points >= $1 AND {UNJUDGED}
                 ORDER BY {RAW_OFFSET} {dir}, s.id
                 LIMIT {}",
                int(want as i64)
            ),
            &[&min_points],
        )
        .expect("fill query")
        .iter()
        .map(story_row)
        .collect()
    };
    let mut merged = side(">=", "ASC");
    merged.extend(side("<", "DESC"));
    merged.sort_by(|a, b| {
        raw_offset(a)
            .abs()
            .partial_cmp(&raw_offset(b).abs())
            .expect("finite offsets")
    });
    let mut out = take(merged, need, picked);
    for r in &mut out {
        r.reason = Some("boundary".to_string());
    }
    out
}

/// Split `limit` into whole cards by share, largest remainder first, so the
/// parts sum to exactly the limit. Rounding each share on its own overshoots —
/// a deck of 8 asked for 3+2+2+2, and the ninth card was then truncated off the
/// end, quietly turning a 40/20/20/20 split into 25/25/25/25. Small decks are
/// where that distortion bites, which is exactly the size we now ask for.
fn allocate(limit: usize, shares: &[f64]) -> Vec<usize> {
    let exact: Vec<f64> = shares.iter().map(|share| limit as f64 * share).collect();
    let mut counts: Vec<usize> = exact.iter().map(|v| v.floor() as usize).collect();
    let mut order: Vec<(usize, f64)> = exact
        .iter()
        .enumerate()
        .map(|(i, v)| (i, v - v.floor()))
        .collect();
    order.sort_by(|a, b| b.1.partial_cmp(&a.1).expect("finite").then(a.0.cmp(&b.0)));
    let mut left = limit - counts.iter().sum::<usize>();
    let mut k = 0;
    while left > 0 {
        counts[order[k % order.len()].0] += 1;
        k += 1;
        left -= 1;
    }
    counts
}

/// Round-robin, so the deck never comes out in blocks of one stratum.
fn interleave(buckets: Vec<Vec<StoryRow>>, limit: usize) -> Vec<StoryRow> {
    let mut out = Vec::new();
    let mut buckets: Vec<std::vec::IntoIter<StoryRow>> =
        buckets.into_iter().map(Vec::into_iter).collect();
    loop {
        let mut drained = true;
        for b in &mut buckets {
            let Some(row) = b.next() else { continue };
            drained = false;
            out.push(row);
            if out.len() >= limit {
                return out;
            }
        }
        if drained {
            return out;
        }
    }
}

/* ------------------------------------------------------------------ rounds */

// A dozen cards: about two minutes of judging, and enough to fill every
// stratum (5 boundary / 3 novel / 2 recent / 2 explore).
pub const ROUND_SIZE: usize = 12;
// A round left half-finished yesterday should not greet you today. The votes
// already landed and are not lost — only the deal is discarded.
const ROUND_STALE_SECONDS: i64 = 86400;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DealtCard {
    pub id: i64,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Round {
    pub seq: i64,
    pub rev: i64,
    pub size: usize,
    #[serde(rename = "dealtAt")]
    pub dealt_at: i64,
    pub dealt: Vec<DealtCard>,
    #[serde(
        rename = "finishedAt",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub finished_at: Option<i64>,
}

fn round_shape(round: &Round) -> serde_json::Map<String, Value> {
    let mut m = serde_json::Map::new();
    m.insert("seq".into(), json!(round.seq));
    m.insert("rev".into(), json!(round.rev));
    m.insert("size".into(), json!(round.size));
    m.insert("dealtAt".into(), json!(round.dealt_at));
    m
}

/// Training happens in rounds: twelve cards dealt from one model revision,
/// judged, then a single retrain. The unit matters — before this, a retrain
/// fired after roughly every individual vote, so the accuracy it produced could
/// not be read as the consequence of anything.
///
/// The round in flight lives in `meta`, not in the browser: this app is
/// installed on more than one device, and a round that only exists in one
/// browser is only finite in that browser. It needs no table of its own —
/// because a retrain happens only at a round boundary, a completed round is
/// identified by the model revision it was dealt at, and everything a summary
/// needs (what was guessed, accuracy before and after, signals gained) is
/// already derivable from `vote_predictions` and `models`.
pub fn current_round(db: &Db) -> Option<Round> {
    let raw = get_meta(db, "current_round")?;
    let round: Round = serde_json::from_str(&raw).ok()?;
    if round.dealt.is_empty() {
        return None;
    }
    if now_seconds() - round.dealt_at > ROUND_STALE_SECONDS {
        return None;
    }
    Some(round)
}

/// Deal a fresh round, replacing whatever was in flight.
pub fn deal_round(db: &Db, cache: &ModelCache, size: usize) -> Value {
    let previous = current_round(db);
    let seq = previous
        .map(|r| r.seq)
        .or_else(|| get_meta(db, "round_seq").and_then(|v| v.parse().ok()))
        .unwrap_or(0)
        + 1;
    // The cursor varies the draw between rounds that share a model revision —
    // a round of nothing but skips triggers no retrain, so the next one would
    // otherwise be seeded identically.
    let cards = training_queue(db, cache, size, seq, QUEUE_MIN_POINTS);
    let round = Round {
        seq,
        rev: load_model(db, cache).map(|c| c.rev).unwrap_or(0),
        size: cards.len(),
        dealt_at: now_seconds(),
        dealt: cards
            .iter()
            .map(|c| DealtCard {
                id: c.id,
                reason: c.reason.clone(),
            })
            .collect(),
        finished_at: None,
    };
    set_meta(
        db,
        "current_round",
        &serde_json::to_string(&round).expect("round json"),
    );
    set_meta(db, "round_seq", &seq.to_string());
    let mut out = round_shape(&round);
    out.insert("cards".into(), serde_json::to_value(&cards).expect("cards"));
    Value::Object(out)
}

/// The round in flight with its remaining cards, or None. Progress is a join
/// against `votes` rather than a counter, so it cannot drift from what was
/// actually recorded — including votes cast on another device.
pub fn round_status(db: &Db) -> Option<Value> {
    let round = current_round(db)?;
    // `= ANY($1)` rather than a generated `IN (?, ?, …)`: one bound array
    // instead of a statement whose text changes with the size of the round.
    let ids: Vec<i64> = round.dealt.iter().map(|d| d.id).collect();
    let votes: HashMap<i64, i64> = db
        .query(
            "SELECT story_id, value FROM votes WHERE story_id = ANY($1)",
            &[&ids],
        )
        .expect("round votes")
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    let rows: HashMap<i64, StoryRow> = db
        .query(
            &format!("SELECT {STORY_COLUMNS} {STORY_JOINS} WHERE s.id = ANY($1)"),
            &[&ids],
        )
        .expect("round rows")
        .iter()
        .map(|r| {
            let row = story_row(r);
            (row.id, row)
        })
        .collect();
    let reasons: HashMap<i64, Option<String>> = round
        .dealt
        .iter()
        .map(|d| (d.id, d.reason.clone()))
        .collect();

    let mut judged = 0;
    let mut skipped = 0;
    let mut cards: Vec<StoryRow> = Vec::new();
    for id in &ids {
        match votes.get(id) {
            None => {
                // A story can vanish between deals only if the database was rebuilt;
                // treat it as spent rather than serving a hole.
                if let Some(row) = rows.get(id) {
                    let mut card = row.clone();
                    card.reason = reasons.get(id).cloned().flatten();
                    cards.push(card);
                }
            }
            Some(0) => skipped += 1,
            Some(_) => judged += 1,
        }
    }
    let mut out = round_shape(&round);
    out.insert("judged".into(), json!(judged));
    out.insert("skipped".into(), json!(skipped));
    out.insert("cards".into(), serde_json::to_value(&cards).expect("cards"));
    out.insert("finished".into(), json!(round.finished_at.is_some()));
    Some(Value::Object(out))
}

/// What a finished round did. Called once the retrain has landed, while the
/// round is still in `meta` — that is what carries which stratum drew each
/// card, and the next deal overwrites it.
///
/// Ordered by how much each number means, which is not the order of how
/// impressive they look. Signals gained is monotonic and caused by these votes.
/// Accuracy over a dozen votes sits at the noise floor, so it is reported with
/// the band it has to clear before it is worth believing.
pub fn round_summary(db: &Db, cache: &ModelCache) -> Option<Value> {
    let round = current_round(db)?;
    let ids: Vec<i64> = round.dealt.iter().map(|d| d.id).collect();
    let reasons: HashMap<i64, Option<String>> = round
        .dealt
        .iter()
        .map(|d| (d.id, d.reason.clone()))
        .collect();
    let rows: Vec<(i64, i64, Option<f64>)> = db
        .query(
            "SELECT v.story_id, v.value, p.score
             FROM votes v LEFT JOIN vote_predictions p ON p.story_id = v.story_id
             WHERE v.story_id = ANY($1)",
            &[&ids],
        )
        .expect("summary query")
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2)))
        .collect();

    let mut judged = 0;
    let mut skipped = 0;
    let mut guessed = 0;
    let mut guessable = 0;
    // The explore cards are the only unbiased sample in a round: boundary cards
    // are picked *because* the model cannot call them, so its hit rate on those
    // is pinned near chance however much it learns. This subset can climb.
    let mut explore_right = 0;
    let mut explore_total = 0;
    for (story_id, value, score) in &rows {
        if *value == 0 {
            skipped += 1;
            continue;
        }
        judged += 1;
        let Some(score) = score else { continue };
        guessable += 1;
        let right = (*score >= 0.5) == (*value > 0);
        if right {
            guessed += 1;
        }
        if reasons.get(story_id).cloned().flatten().as_deref() == Some("explore") {
            explore_total += 1;
            if right {
                explore_right += 1;
            }
        }
    }

    let before = model_at(db, round.rev);
    let after = load_model(db, cache);
    let was_trained = after.as_ref().map(|a| a.rev != round.rev).unwrap_or(false);

    // Mark it spent, so reopening the tab on a finished round shows the summary
    // again instead of paying for a second retrain of the same votes.
    if round.finished_at.is_none() {
        let spent = Round {
            finished_at: Some(now_seconds()),
            ..round.clone()
        };
        set_meta(
            db,
            "current_round",
            &serde_json::to_string(&spent).expect("round json"),
        );
    }

    let flips = paired_flips(db, Some(round.rev), after.as_ref().map(|a| a.rev));
    let mut out = round_shape(&round);
    out.insert("judged".into(), json!(judged));
    out.insert("skipped".into(), json!(skipped));
    out.insert("trained".into(), json!(was_trained));
    out.insert(
        "guessed".into(),
        if guessable > 0 {
            json!({"right": guessed, "of": guessable})
        } else {
            Value::Null
        },
    );
    out.insert(
        "explore".into(),
        if explore_total > 0 {
            json!({"right": explore_right, "of": explore_total})
        } else {
            Value::Null
        },
    );
    out.insert(
        "signals".into(),
        match (&before, &after) {
            (Some(b), Some(a)) => {
                let total = a.runtime.model.names.len();
                json!({"gained": total as i64 - b.model.names.len() as i64, "total": total})
            }
            _ => Value::Null,
        },
    );
    out.insert(
        "accuracy".into(),
        accuracy_move(
            before.as_ref().and_then(|b| b.metrics.as_ref()),
            after.as_ref().and_then(|a| a.metrics.as_ref()),
            flips,
        ),
    );
    out.insert(
        "learned".into(),
        if was_trained {
            weight_movers(
                before.as_ref(),
                &after.as_ref().expect("trained").runtime.model,
                3,
            )
        } else {
            json!({"likes": [], "dislikes": []})
        },
    );
    Some(Value::Object(out))
}

fn model_at(db: &Db, rev: i64) -> Option<Payload> {
    let payload: String = db
        .query_opt("SELECT payload FROM models WHERE rev = $1", &[&rev])
        .expect("model_at")?
        .get(0);
    Some(serde_json::from_str(&payload).expect("payload json"))
}

/// The accuracy move, and whether it means anything. Twelve votes move this
/// number by about as much as nothing at all does, so a change that clears
/// nothing is reported as flat rather than dressed up as progress.
///
/// Two revisions' accuracies are two scorings of nearly the same votes, so the
/// comparison is **paired** and `flips` is the evidence: of the votes both
/// revisions held out, how many changed sides, and which way. Everything else is
/// a proxy for that. Where the flips are known the summary can say the thing no
/// aggregate can — "thirty-five moved, net twelve" — and `significant` is
/// McNemar's test on them, so a big net out of a small discordant set counts and
/// a small net out of a large one does not.
///
/// `band` is kept beside it for the case where they are not known (the first
/// train after this shipped, a revision gap, too few votes to cross-validate).
/// It is the single-figure `noise` widened by sqrt(2) — quadrature on two equal
/// bands, the independent case — which overstates it by however correlated the
/// two scorings really are. That is the safe direction, and it is only a
/// fallback. Deliberately no absolute floor: at 500 votes the band is around 4
/// points and a 3-point move is noise, at 50k votes a half-point move is real,
/// and a constant would be wrong at one end or the other.
const COMPARE_BAND: f64 = std::f64::consts::SQRT_2;

fn accuracy_move(before: Option<&Metrics>, after: Option<&Metrics>, flips: Option<Flips>) -> Value {
    let Some(after) = after else {
        return Value::Null;
    };
    if after.accuracy == 0.0 {
        return Value::Null;
    }
    let band = before.map(|b| b.noise).unwrap_or(0.0).max(after.noise) * COMPARE_BAND;
    let delta = before.map(|b| after.accuracy - b.accuracy);
    let significant = match &flips {
        Some(f) => f.significant,
        // The paired test when there is one, the fallback band when there is not.
        None => delta.map(|d| d.abs() > band).unwrap_or(false),
    };
    json!({
        "before": before.map(|b| b.accuracy),
        "after": after.accuracy,
        "baseline": after.baseline,
        "band": band,
        "flips": flips,
        "significant": significant,
    })
}

// Two-sided 95%, normal approximation to McNemar's exact binomial. They agree
// where it matters here: 6 discordant votes all one way clears both (z: 6 >
// 4.8; exact: p = 0.03), and 3 all one way clears neither.
const MCNEMAR_Z: f64 = 1.96;

#[derive(Debug, Clone, Serialize)]
struct Flips {
    shared: i64,
    moved: i64,
    net: i64,
    gained: i64,
    lost: i64,
    /// A vote count, not a rate: the move expressed on the votes both revisions
    /// actually scored. The percentages the summary shows are the full-history
    /// figures and have a dozen more votes under the second one, so they differ
    /// from net/shared a little. This is the one being tested.
    delta: f64,
    significant: bool,
}

/// The votes whose held-out call changed sides between two revisions.
///
/// Only the *discordant* votes carry information about the move: one scored
/// right then wrong is evidence against, wrong then right is evidence for, and a
/// vote called the same way twice says nothing whichever way it was called. So
/// the test is on `gained` against `lost`, not on the two accuracies — which is
/// the whole point, since those differ by a dozen examples of denominator as
/// well as by the flips.
///
/// Returns None unless both revisions are actually on hand: the revs must be the
/// ones asked for (a no-op retrain between the deal and the round's end shifts
/// `oof_previous` past the revision the round was dealt at) and there must be
/// votes in common. The caller then falls back to the unpaired band.
fn paired_flips(db: &Db, from_rev: Option<i64>, to_rev: Option<i64>) -> Option<Flips> {
    let (from_rev, to_rev) = (from_rev?, to_rev?);
    if from_rev == to_rev {
        return None;
    }
    // `was_right` / `is_right` come back as genuine booleans, not SQLite's
    // 0/1, so the outer CASEs test them rather than compare them to integers.
    let row = db
        .query_one(
            "SELECT
               COUNT(*) AS shared,
               SUM(CASE WHEN NOT was_right AND is_right THEN 1 ELSE 0 END) AS gained,
               SUM(CASE WHEN was_right AND NOT is_right THEN 1 ELSE 0 END) AS lost
             FROM (
               SELECT ((prev.score >= 0.5) = (v.value > 0)) AS was_right,
                      ((cur.score  >= 0.5) = (v.value > 0)) AS is_right
               FROM votes v
               JOIN oof_previous prev ON prev.story_id = v.story_id
               JOIN oof_scores   cur  ON cur.story_id  = v.story_id
               WHERE v.value != 0 AND prev.model_rev = $1 AND cur.model_rev = $2
             ) AS paired",
            &[&from_rev, &to_rev],
        )
        .expect("paired flips");
    let (shared, gained, lost): (i64, Option<i64>, Option<i64>) =
        (row.get(0), row.get(1), row.get(2));
    if shared == 0 {
        return None;
    }
    let (gained, lost) = (gained.unwrap_or(0), lost.unwrap_or(0));
    let discordant = gained + lost;
    let net = gained - lost;
    Some(Flips {
        shared,
        moved: discordant,
        net,
        gained,
        lost,
        delta: net as f64 / shared as f64,
        significant: discordant > 0 && (net.abs() as f64) > MCNEMAR_Z * (discordant as f64).sqrt(),
    })
}

/// What the round changed in the model's picture of you: the features whose
/// weight moved most. Restricted to signals seen at least twice — a word read
/// once has a large weight and no evidence, and naming it would promise a
/// pattern that does not exist yet.
const MOVER_MIN_SUPPORT: u32 = 2;

fn weight_movers(before: Option<&Payload>, after: &Model, limit: usize) -> Value {
    let Some(before) = before else {
        return json!({"likes": [], "dislikes": []});
    };
    let was: HashMap<&str, f64> = before
        .model
        .names
        .iter()
        .enumerate()
        .map(|(i, n)| (n.as_str(), before.model.weights[i]))
        .collect();
    #[derive(Serialize, Clone)]
    struct Mover {
        kind: String,
        label: String,
        delta: f64,
        weight: f64,
        support: u32,
    }
    let mut moves: Vec<Mover> = Vec::new();
    for (i, name) in after.names.iter().enumerate() {
        if name == "__bias__" || name.starts_with("t:") {
            continue;
        }
        if after.counts[i] < MOVER_MIN_SUPPORT {
            continue;
        }
        let delta = after.weights[i] - was.get(name.as_str()).copied().unwrap_or(0.0);
        if delta.abs() < 1e-3 {
            continue;
        }
        let FeatureDesc { kind, label } = describe_feature(name);
        moves.push(Mover {
            kind,
            label,
            delta,
            weight: after.weights[i],
            support: after.counts[i],
        });
    }
    moves.sort_by(|a, b| {
        b.delta
            .abs()
            .partial_cmp(&a.delta.abs())
            .expect("finite delta")
    });
    // Delta and weight must agree in sign. A signal can move a long way toward
    // "no" this round and still sit firmly on the yes side — github.com did
    // exactly that — and calling it a dislike would state the opposite of what
    // the model believes. Only a signal the round moved *and* left on that side
    // is something the model now genuinely reads that way.
    let likes: Vec<&Mover> = moves
        .iter()
        .filter(|m| m.delta > 0.0 && m.weight > 0.0)
        .take(limit)
        .collect();
    let dislikes: Vec<&Mover> = moves
        .iter()
        .filter(|m| m.delta < 0.0 && m.weight < 0.0)
        .take(limit)
        .collect();
    json!({"likes": likes, "dislikes": dislikes})
}

/* ----------------------------------------------------------------- explore */

/// What to show in the Explore deck.
///
/// Same judging loop as the trainer, drawn from a deliberately different pool.
/// `training_queue` optimises for what teaches the model most, and on HN that is
/// mostly titles nobody stopped on — the 2-comment tail. Explore inverts it:
/// a story only gets in if the crowd actually engaged with it, and the deck is
/// ordered in two tiers.
///
///  - `probably`: cleared the traction bar AND the model scores it >= 0.6.
///  - `possibly`: cleared the bar, the model is unsure (0.35..0.6) — the crowd
///    is the reason it is here.
///
/// Anything the model reads as a clear no (< 0.35) is dropped, however popular:
/// skipping those is the point of the tab. Before there is a model nothing has
/// a score, so every card falls into `possibly` and the deck is pure crowd —
/// unlike the feed, which hides unscored stories, an unscored story here is
/// exactly what "the crowd is on it" means.
///
/// Filtering and ordering are SQL, like the feed.
pub struct ExploreBar {
    // "The crowd stopped on this." Either bar alone is enough: a link-and-run
    // post can clear 200 points with 12 comments, a small controversy the other
    // way round. Both numbers are well past HN's long tail, which is where the
    // uninteresting stories the trainer kept serving actually live.
    pub min_points: i64,
    pub min_comments: i64,
    // Tier cutoffs on the stored (shrunk) score. 0.6 is a warm-but-not-certain
    // match; below 0.35 the model has a real objection and the story is dropped.
    pub probably_score: f64,
    pub possibly_score: f64,
}

pub const EXPLORE: ExploreBar = ExploreBar {
    min_points: 50,
    min_comments: 25,
    probably_score: 0.6,
    possibly_score: 0.35,
};

pub fn explore_queue(
    db: &Db,
    cache: &ModelCache,
    limit: i64,
    days: i64,
    bar: &ExploreBar,
) -> Vec<StoryRow> {
    // Skips (value = 0) are judgements too, so `IS NULL` — a story you skipped
    // must not come back, here or in the trainer.
    // Positional, and deliberately fixed: rusqlite's named parameters have no
    // counterpart in the postgres crate, and `$probably` would in any case
    // collide with Postgres's own `$1` syntax. Postgres lets one placeholder be
    // referenced as many times as it likes, which is what the tier expression
    // needs — the first four are always bound, the last two only when their
    // clause is in play, so the numbering never shifts under the fixed ones.
    let mut wheres = vec![
        UNJUDGED.to_string(),
        "(s.points >= $1 OR s.num_comments >= $2)".to_string(),
    ];
    let since = now_seconds() - days * 86400;
    let mut params: Params = vec![
        Box::new(bar.min_points),
        Box::new(bar.min_comments),
        Box::new(bar.probably_score),
        Box::new(limit),
    ];
    if days > 0 {
        wheres.push("s.created_at >= $5".to_string());
        params.push(Box::new(since));
    }
    if load_model(db, cache).is_some() {
        // $6 when the day window is in force, $5 when it is not.
        wheres.push(format!("sc.score >= ${}", params.len() + 1));
        params.push(Box::new(bar.possibly_score));
    }

    // The tier is also the primary sort key, so every "probably" card is judged
    // before the crowd tier starts; within a tier, taste then traction.
    // NULLS LAST on the second key. An unscored story's CASE is NULL, and
    // Postgres sorts NULLs *first* on DESC — the opposite of SQLite — which
    // would have floated every story the model has never seen above the ones
    // it likes best.
    db.query(
        &format!(
            "SELECT {QUEUE_COLUMNS},
                    CASE WHEN sc.score >= $3 THEN 'probably' ELSE 'possibly' END AS tier
             {UNSCORED_FROM}
             WHERE {}
             ORDER BY CASE WHEN sc.score >= $3 THEN 0 ELSE 1 END ASC,
                      CASE WHEN sc.score >= $3 THEN sc.score END DESC NULLS LAST,
                      s.num_comments DESC, s.points DESC, s.id DESC
             LIMIT $4",
            wheres.join(" AND ")
        ),
        &refs(&params),
    )
    .expect("explore query")
    .iter()
    .map(|r| {
        let mut row = story_row(r);
        row.tier = r.get(12);
        row
    })
    .collect()
}

/* --------------------------------------------------------------- the brain */

pub fn explain(db: &Db, cache: &ModelCache, story_id: i64) -> Option<Value> {
    let story = db
        .query_opt(&format!("{STORY_SELECT} WHERE id = $1"), &[&story_id])
        .expect("explain story")
        .as_ref()
        .map(Story::from_row)?;
    let Some(current) = load_model(db, cache) else {
        return Some(json!({"story": story, "score": null, "contributions": []}));
    };
    let res = score_features(&current.runtime, &featurize(story_text(&story)), true);
    Some(json!({
        "story": story,
        "score": res.score,
        "raw": res.raw,
        "confidence": res.confidence,
        "coverage": res.coverage,
        "contributions": res.contributions.into_iter().take(10).collect::<Vec<_>>(),
    }))
}

/// Per-day story counts, with gap days filled in as zero so thin coverage is
/// visible. Capped to the most recent `window_days` — a sync never reaches
/// further back, and a single stray old story (a repost with an ancient
/// created_at) would otherwise stretch the chart into a sea of empty days.
/// Anything before the window is summarised in `older` instead of drawn.
pub fn stories_per_day(db: &Db, window_days: i64) -> Value {
    let rows: Vec<(String, i64)> = db
        .query(
            "SELECT day, COUNT(*) AS count FROM stories GROUP BY day ORDER BY day",
            &[],
        )
        .expect("days query")
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    if rows.is_empty() {
        return json!({"days": [], "older": null});
    }

    let last_day = &rows[rows.len() - 1].0;
    let last_start = parse_day(last_day).expect("stored day parses");
    let cutoff = day_key(last_start - (window_days - 1) * 86400);

    let in_window: Vec<&(String, i64)> = rows.iter().filter(|r| r.0 >= cutoff).collect();
    let older_rows: Vec<&(String, i64)> = rows.iter().filter(|r| r.0 < cutoff).collect();

    let by_day: HashMap<&str, i64> = in_window.iter().map(|r| (r.0.as_str(), r.1)).collect();
    let mut days = Vec::new();
    let first_start = parse_day(&in_window[0].0).expect("stored day parses");
    let mut t = first_start;
    while t <= last_start {
        let day = day_key(t);
        let count = by_day.get(day.as_str()).copied().unwrap_or(0);
        days.push(json!({"day": day, "count": count}));
        t += 86400;
    }

    json!({
        "days": days,
        "older": if older_rows.is_empty() { Value::Null } else { json!({
            "days": older_rows.len(),
            "stories": older_rows.iter().map(|r| r.1).sum::<i64>(),
            "before": in_window[0].0,
        }) },
    })
}

// How the current model's scores spread across the corpus: unvoted stories
// per SCORE_BINS equal-width bucket over [0, 1]. The user's own votes are
// left out — they are the training set and sit pinned at the extremes, and
// the unvoted population is what the feed actually has to offer. Bins the
// stored (shrunk) score because that is what the feed sorts by.
// Done in SQL: ~70k rows bucket in a few ms.
pub const SCORE_BINS: usize = 20;

pub fn score_distribution(db: &Db, cache: &ModelCache) -> Option<Value> {
    let rev = load_model(db, cache)?.rev;
    // score = 1.0 would land in bin SCORE_BINS; clamp it into the top bin.
    // FLOOR, not a cast. Postgres rounds on `CAST(x AS INTEGER)` where SQLite
    // truncates, which would have put 0.649 in the 0.65 bucket and shifted
    // every bar half a bin. LEAST is the two-argument MIN SQLite spells MIN.
    let rows: Vec<(i64, i64)> = db
        .query(
            &format!(
                "SELECT LEAST(FLOOR(s.score * {SCORE_BINS})::bigint, {}::bigint) AS bin,
                        COUNT(*) AS n
                 FROM scores s LEFT JOIN votes v ON v.story_id = s.story_id
                 WHERE s.model_rev = $1 AND v.story_id IS NULL
                 GROUP BY bin",
                SCORE_BINS - 1
            ),
            &[&rev],
        )
        .expect("dist query")
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    let mut bins = vec![0_i64; SCORE_BINS];
    let mut total = 0;
    for (bin, n) in rows {
        bins[bin as usize] = n;
        total += n;
    }
    Some(json!({"bins": bins, "total": total, "rev": rev}))
}

pub fn stats(db: &Db, cache: &ModelCache) -> Value {
    let counts = vote_counts(db);
    let story_count: i64 = db
        .query_one("SELECT COUNT(*) FROM stories", &[])
        .expect("stories count")
        .get(0);
    let day_count: i64 = db
        .query_one("SELECT COUNT(DISTINCT day) FROM stories", &[])
        .expect("days count")
        .get(0);
    let current = load_model(db, cache);
    json!({
        "stories": story_count,
        "days": day_count,
        "votes": counts,
        "lastSyncAt": get_meta(db, "last_sync_at").and_then(|v| v.parse::<i64>().ok()).unwrap_or(0),
        "model": match current {
            Some(c) => json!({
                "rev": c.rev,
                "trainedAt": c.trained_at,
                "nVotes": c.n_votes,
                "metrics": c.metrics,
                "features": c.runtime.model.names.len(),
                "insights": insights(&c.runtime.model, 12, 2),
                "distribution": score_distribution(db, cache),
            }),
            None => Value::Null,
        },
        "minVotesToTrain": MIN_VOTES_TO_TRAIN,
        // Which build answered. Rides on stats rather than an endpoint of its
        // own because Brain already redraws from this one response.
        "version": crate::version::info(),
    })
}

/// Which parts of this title the model has never seen. These are what the next
/// retrain will actually learn from the vote — the direct, causal answer to
/// "what did that swipe do", and a count that only ever goes up.
///
/// Style features (`t:`) are excluded: they match every title (is-a-question,
/// has-a-number) and were never news. Words come before phrases and sites
/// because a word reads as something you taught it; "6mb rust+tauri" reads as
/// machinery.
fn signal_order(name: &str) -> u8 {
    match name.split(':').next() {
        Some("w") => 0,
        Some("dom") => 1,
        Some("by") => 2,
        Some("tld") => 3,
        Some("b") => 4,
        _ => 9,
    }
}

pub fn new_signals(story: &Story, runtime: &Runtime, limit: usize) -> Value {
    let mut fresh: Vec<String> = featurize(story_text(story))
        .iter()
        .map(|(name, _)| name.to_string())
        .filter(|name| name != "__bias__" && !name.starts_with("t:"))
        .filter(|name| !runtime.index.contains_key(name))
        .collect();
    fresh.sort_by_key(|n| signal_order(n));
    let mut labels: Vec<String> = Vec::new();
    for name in &fresh {
        let label = describe_feature(name).label;
        if !labels.contains(&label) {
            labels.push(label);
        }
    }
    labels.truncate(limit);
    json!({"count": fresh.len(), "labels": labels})
}

/// Record a vote and report what the model had guessed about it, and what the
/// vote gives it that it did not have. The capture happens first, on purpose:
/// a moment later the retrain will have memorised this story, and the score in
/// `scores` will only restate the verdict.
///
/// The trainer card shows this *after* the swipe, never before — a prediction
/// on screen while you are deciding anchors the label it is trying to collect.
pub fn judge(db: &Db, cache: &ModelCache, story_id: i64, value: i64) -> Value {
    let captured = capture_prediction(db, story_id);
    let story: Option<Story> = db
        .query_opt(&format!("{STORY_SELECT} WHERE id = $1"), &[&story_id])
        .expect("judge story")
        .as_ref()
        .map(Story::from_row);
    let current = load_model(db, cache);
    record_vote(db, story_id, value);

    // A skip is not a verdict and not a training example: nothing for a guess to
    // be right about, and nothing taught.
    if value == 0 {
        return json!({"prediction": null, "taught": null});
    }
    json!({
        "prediction": captured.map(|c| json!({
            "score": c.score,
            "confidence": c.confidence,
            "modelRev": c.model_rev,
            "agreed": (c.score >= 0.5) == (value > 0),
        })),
        "taught": match (&current, &story) {
            (Some(c), Some(s)) => new_signals(s, &c.runtime, 3),
            _ => Value::Null,
        },
    })
}

/// The learning curve: accuracy at each training run, with the band that number
/// wobbles inside. Metrics are read out of the stored payloads in SQL rather
/// than by parsing every snapshot in the app — a snapshot carries the whole
/// weight vector.
///
/// `payload` stays TEXT. A JSONB column would re-serialise what `serde_json`
/// wrote (key order, whitespace, duplicate handling) for the sake of two
/// queries over some fifty rows, and the byte-for-byte round trip is the thing
/// that lets a snapshot move between backends untouched. Casting per row is
/// cheaper than that trade.
///
/// Revisions that added no votes are dropped. Before rounds existed a retrain
/// fired after roughly every single vote, and a no-op retrain (the CLI, an
/// import, a repeated trigger) produced a fresh revision identical to the last
/// — so the raw table is mostly the same model over and over. What survives is
/// one point per run that actually learned something, which from here on is one
/// point per round.
///
/// Long histories are thinned by taking every nth point, so the shape stays
/// readable rather than becoming a wall.
pub fn model_history(db: &Db, limit: usize) -> Value {
    #[derive(Clone, Serialize)]
    struct Point {
        rev: i64,
        #[serde(rename = "trainedAt")]
        trained_at: i64,
        votes: i64,
        accuracy: f64,
        baseline: Option<f64>,
        noise: Option<f64>,
        features: Option<i64>,
    }
    let rows: Vec<Point> = db
        .query(
            "SELECT rev, trained_at, n_votes,
                    (payload::jsonb #>> '{metrics,accuracy}')::float8 AS accuracy,
                    (payload::jsonb #>> '{metrics,baseline}')::float8 AS baseline,
                    (payload::jsonb #>> '{metrics,noise}')::float8    AS noise,
                    jsonb_array_length(payload::jsonb #> '{model,names}')::bigint AS features
             FROM models
             ORDER BY rev",
            &[],
        )
        .expect("history query")
        .iter()
        .filter_map(|r| {
            let accuracy: Option<f64> = r.get(3);
            accuracy.map(|accuracy| Point {
                rev: r.get(0),
                trained_at: r.get(1),
                votes: r.get(2),
                accuracy,
                baseline: r.get(4),
                noise: r.get(5),
                features: r.get(6),
            })
        })
        .collect();

    let mut runs: Vec<Point> = Vec::new();
    for row in rows.iter().cloned() {
        // Keep the *last* revision at a given vote count: it is the one whose
        // model the app actually went on to use.
        match runs.last_mut() {
            Some(last) if last.votes == row.votes => *last = row,
            _ => runs.push(row),
        }
    }

    let step = (runs.len() as f64 / limit as f64).ceil().max(1.0) as usize;
    let points: Vec<&Point> = runs
        .iter()
        .enumerate()
        .filter(|(i, _)| i % step == 0 || *i == runs.len() - 1)
        .map(|(_, p)| p)
        .collect();
    json!({"points": points, "runs": runs.len(), "revs": rows.len()})
}

/// Forget every trained model and start the numbering again at rev 1.
///
/// The models table is derived data: the model is a deterministic function of
/// the votes, so a retrain reproduces it exactly. Votes and their frozen
/// predictions are left alone — they are the record. `scores` and `oof_scores`
/// are not touched either, because the retrain that follows rewrites both
/// wholesale. `oof_previous` is cleared, though: it is a baseline naming a
/// revision that will not exist afterwards.
///
/// The reason to do it at all is a vocabulary change. Weights are keyed by
/// feature *name*, so after the tokenizer changed ("s&p" where there was "s"),
/// a diff across that boundary reports thousands of new signals that are the
/// same words renamed, and weight movements that are artefacts of
/// retokenisation — and those diffs are exactly what a round summary shows.
///
/// Destructive and rare: the caller is expected to confirm, and to retrain
/// immediately, since an empty models table leaves the queue on its cold path.
pub fn reset_models(db: &Db, cache: &ModelCache) -> i64 {
    let forgotten: i64 = db
        .query_one("SELECT COUNT(*) FROM models", &[])
        .expect("count models")
        .get(0);
    db.begin();
    // TRUNCATE ... RESTART IDENTITY does in one statement what the SQLite
    // version needed two for: empty the table and wind the sequence back, so
    // the next revision is 1 again rather than carrying on from the old
    // numbering. Safe here because nothing references `models` by foreign key.
    db.execute_batch("TRUNCATE models RESTART IDENTITY")
        .expect("truncate models");
    // Round numbering restarts with the revisions, and a round in flight was
    // dealt by a model that no longer exists.
    db.execute(
        "DELETE FROM meta WHERE key IN ('current_round', 'round_seq')",
        &[],
    )
    .expect("round meta");
    // `oof_previous` exists to be compared against a revision that no longer
    // does. The retrain that follows rewrites `oof_scores` wholesale, so it can
    // be left, but a kept baseline naming a deleted rev is worse than none.
    db.execute_batch("DELETE FROM oof_previous")
        .expect("oof_previous");
    db.commit();
    cache.reset();
    forgotten
}
