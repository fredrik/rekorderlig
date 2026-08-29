//! Schema and the vote/story queries. The schema is identical to the one the
//! Node backend created — only `CREATE ... IF NOT EXISTS`, no migration system —
//! so a production database moves between the two backends untouched.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::dates::now_seconds;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS stories (
  id            INTEGER PRIMARY KEY,      -- Hacker News item id
  title         TEXT    NOT NULL,
  url           TEXT,
  domain        TEXT,
  author        TEXT,
  points        INTEGER NOT NULL DEFAULT 0,
  num_comments  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,         -- unix seconds, story creation
  day           TEXT    NOT NULL,         -- YYYY-MM-DD (UTC) for day grouping
  fetched_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_day ON stories(day);
CREATE INDEX IF NOT EXISTS idx_stories_created ON stories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stories_comments ON stories(num_comments DESC);
-- Reposts are collapsed at read time (service.rs), so nothing looks stories up
-- by URL any more; the index only cost us writes on every sync.
DROP INDEX IF EXISTS idx_stories_url;

-- One row per judged story. value: 1 = thumb up, -1 = thumb down, 0 = skipped.
CREATE TABLE IF NOT EXISTS votes (
  story_id   INTEGER PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
  value      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_votes_created ON votes(created_at DESC);

-- Cached model scores so the feed can be sorted in SQL.
CREATE TABLE IF NOT EXISTS scores (
  story_id   INTEGER PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
  score      REAL NOT NULL,               -- probability of 'thumb up', 0..1
  confidence REAL NOT NULL DEFAULT 0,     -- 0..1, how much evidence backs the score
  model_rev  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_score ON scores(score DESC);
-- The training queue seeks into the score axis instead of scanning it, so that
-- a multi-year archive costs the same as a week. Two expression indexes carry
-- that: the *unshrunk* offset from 0.5 (see RAW_OFFSET in service.rs — the
-- stored score is pulled toward 0.5 by confidence, so ranking on it ranks
-- ignorance rather than uncertainty), and confidence on its own for the slots
-- that deliberately hunt titles the model has no vocabulary for.
CREATE INDEX IF NOT EXISTS idx_scores_raw_offset
  ON scores(((score - 0.5) / (0.3 + 0.7 * confidence)));
CREATE INDEX IF NOT EXISTS idx_scores_confidence ON scores(confidence);

-- Held-out predictions: for each voted story, what the model said about it
-- while it was in the fold that trained without it. Unlike the scores table,
-- this is not memorised: the trained model separates its own training set
-- perfectly, so only the out-of-fold number can disagree with a verdict.
-- Rewritten whole on every train; an empty table means no model has held
-- anything out yet.
CREATE TABLE IF NOT EXISTS oof_scores (
  story_id  INTEGER PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
  score     REAL NOT NULL,                -- probability of 'thumb up', 0..1
  model_rev INTEGER NOT NULL
);

-- The same, from the train before last. Kept for one reason: an accuracy move
-- between two revisions is a *paired* comparison — nearly the same votes, scored
-- twice — and the only honest test of it counts the votes whose prediction
-- actually flipped (McNemar). Without this table the two revisions can only be
-- compared as independent measurements, which cannot tell 'twelve flipped one
-- way' from 'thirty-five flipped, net twelve'.
--
-- One row per vote at most, so this doubles the held-out storage and nothing
-- more: it holds the previous revision only, never a history.
CREATE TABLE IF NOT EXISTS oof_previous (
  story_id  INTEGER PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
  score     REAL NOT NULL,
  model_rev INTEGER NOT NULL                -- which revision held these out
);

-- What the model predicted about a story at the instant it was judged.
-- The scores table cannot answer this after the fact: it is rewritten on every
-- retrain, and once a vote exists the model has memorised it (yes ~0.99). The
-- number captured here was a genuine out-of-sample guess — the vote it is
-- compared against did not exist when it was made — which is what makes
-- 'the brain called this one' an honest claim rather than a flattering one.
-- Cleared with the vote, so re-judging captures a fresh prediction.
CREATE TABLE IF NOT EXISTS vote_predictions (
  story_id   INTEGER PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
  score      REAL NOT NULL,
  confidence REAL NOT NULL,
  model_rev  INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Serialised model snapshots (weights + metrics), newest revision wins.
CREATE TABLE IF NOT EXISTS models (
  rev        INTEGER PRIMARY KEY AUTOINCREMENT,
  trained_at INTEGER NOT NULL,
  n_votes    INTEGER NOT NULL,
  payload    TEXT NOT NULL                -- JSON: weights, vocab, metrics
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
";

/// Where the database lives; workers open their own connection here.
pub fn db_path() -> PathBuf {
    match std::env::var("REKORDERLIG_DB") {
        Ok(p) if !p.is_empty() => PathBuf::from(p),
        _ => std::env::current_dir()
            .expect("cwd")
            .join("data")
            .join("rekorderlig.db"),
    }
}

/// Open an independent connection to `path` (server, workers, tests, tooling).
pub fn open_db(path: &Path) -> Connection {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).expect("create db directory");
    }
    let conn = Connection::open(path).expect("open database");
    conn.pragma_update(None, "journal_mode", "WAL")
        .expect("WAL");
    // A background worker (trainer, syncer) may write while the server is
    // serving; with WAL that only ever means waiting out a short transaction.
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .expect("busy_timeout");
    conn.pragma_update(None, "foreign_keys", "ON")
        .expect("foreign_keys");
    // The bundled SQLite is compiled without SQLITE_ENABLE_MATH_FUNCTIONS, so
    // the ln() the hybrid feed's ORDER BY uses is registered here instead —
    // same name, same math as the built-in.
    conn.create_scalar_function(
        "ln",
        1,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let x: f64 = ctx.get(0)?;
            Ok(x.ln())
        },
    )
    .expect("register ln");
    conn.execute_batch(SCHEMA).expect("schema");
    conn
}

pub fn get_meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
        .optional()
        .expect("get_meta")
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .expect("set_meta");
}

/// The story shape both HN sources normalise into, and `upsert_story` takes.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Story {
    pub id: i64,
    pub title: String,
    pub url: Option<String>,
    pub domain: Option<String>,
    pub author: Option<String>,
    pub points: i64,
    pub num_comments: i64,
    pub created_at: i64,
    pub day: String,
    pub fetched_at: i64,
}

pub fn upsert_story(conn: &Connection, s: &Story) {
    conn.execute(
        "INSERT INTO stories (id, title, url, domain, author, points, num_comments, created_at, day, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           url = excluded.url,
           domain = excluded.domain,
           points = MAX(stories.points, excluded.points),
           num_comments = MAX(stories.num_comments, excluded.num_comments),
           fetched_at = excluded.fetched_at",
        params![
            s.id, s.title, s.url, s.domain, s.author,
            s.points, s.num_comments, s.created_at, s.day, s.fetched_at
        ],
    )
    .expect("upsert_story");
}

// A vote is recorded against exactly the submission that was judged. Reposts of
// the same URL are NOT co-signed: the model reads titles, and a twin's title is
// one you never saw. Duplicates are collapsed where they show up instead — the
// training queue (service.rs) offers one card per URL / title.
pub fn record_vote(conn: &Connection, story_id: i64, value: i64) {
    record_vote_at(conn, story_id, value, now_seconds());
}

pub fn record_vote_at(conn: &Connection, story_id: i64, value: i64, now: i64) {
    conn.execute(
        "INSERT INTO votes (story_id, value, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(story_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![story_id, value, now, now],
    )
    .expect("record_vote");
}

// Restoring a vote from an old history: unlike record_vote, the supplied
// timestamp wins on conflict — re-running an import must converge on what the
// export says, not on whenever the first attempt happened to run.
//
// `updated_at` is set to `created_at` too, not to now: a restored vote is the row
// as it was, and nothing has touched it since. Import time is not vote activity,
// and the Votes view reads `updated_at` — stamping it with now made a whole
// restored history read as "voted a minute ago".
pub fn import_vote(conn: &Connection, story_id: i64, value: i64, created_at: i64) {
    conn.execute(
        "INSERT INTO votes (story_id, value, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(story_id) DO UPDATE SET
           value = excluded.value,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at",
        params![story_id, value, created_at, created_at],
    )
    .expect("import_vote");
}

pub fn delete_vote(conn: &Connection, story_id: i64) {
    conn.execute("DELETE FROM votes WHERE story_id = ?1", [story_id])
        .expect("delete_vote");
    // The captured prediction belonged to that vote. Undo means the next
    // judgement gets a fresh one, from whatever the model believes by then.
    conn.execute(
        "DELETE FROM vote_predictions WHERE story_id = ?1",
        [story_id],
    )
    .expect("delete prediction");
}

#[derive(Debug, Clone, Serialize)]
pub struct CapturedPrediction {
    pub score: f64,
    pub confidence: f64,
    #[serde(rename = "modelRev")]
    pub model_rev: i64,
}

/// Freeze what the model currently says about a story, before a vote exists to
/// contaminate it. Returns None when the story has no score yet (nothing
/// honest to claim), which is the normal case before the first model.
pub fn capture_prediction(conn: &Connection, story_id: i64) -> Option<CapturedPrediction> {
    let row: Option<(f64, f64, i64)> = conn
        .query_row(
            "SELECT score, confidence, model_rev FROM scores WHERE story_id = ?1",
            [story_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .expect("capture_prediction read");
    let (score, confidence, model_rev) = row?;
    conn.execute(
        "INSERT INTO vote_predictions (story_id, score, confidence, model_rev, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(story_id) DO UPDATE SET
           score = excluded.score, confidence = excluded.confidence,
           model_rev = excluded.model_rev, created_at = excluded.created_at",
        params![story_id, score, confidence, model_rev, now_seconds()],
    )
    .expect("capture_prediction write");
    Some(CapturedPrediction {
        score,
        confidence,
        model_rev,
    })
}

/// A labelled story: what the model trains on.
pub struct Labelled {
    pub story: Story,
    pub value: i64,
}

/// Every labelled story (skips excluded) — the model's training set.
pub fn labelled_stories(conn: &Connection) -> Vec<Labelled> {
    let mut stmt = conn
        .prepare(
            "SELECT s.id, s.title, s.url, s.domain, s.author, s.points, s.num_comments,
                    s.created_at, s.day, s.fetched_at, v.value
             FROM votes v JOIN stories s ON s.id = v.story_id
             WHERE v.value != 0
             ORDER BY v.created_at ASC",
        )
        .expect("labelled_stories");
    let rows = stmt
        .query_map([], |r| {
            Ok(Labelled {
                story: Story {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    url: r.get(2)?,
                    domain: r.get(3)?,
                    author: r.get(4)?,
                    points: r.get(5)?,
                    num_comments: r.get(6)?,
                    created_at: r.get(7)?,
                    day: r.get(8)?,
                    fetched_at: r.get(9)?,
                },
                value: r.get(10)?,
            })
        })
        .expect("labelled query");
    rows.map(|r| r.expect("labelled row")).collect()
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct VoteCounts {
    pub up: i64,
    pub down: i64,
    pub skip: i64,
    pub total: i64,
}

pub fn vote_counts(conn: &Connection) -> VoteCounts {
    let mut stmt = conn
        .prepare("SELECT value, COUNT(*) AS n FROM votes GROUP BY value")
        .expect("vote_counts");
    let mut out = VoteCounts {
        up: 0,
        down: 0,
        skip: 0,
        total: 0,
    };
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
        .expect("vote_counts query");
    for row in rows {
        let (value, n) = row.expect("vote_counts row");
        if value > 0 {
            out.up = n;
        } else if value < 0 {
            out.down = n;
        } else {
            out.skip = n;
        }
    }
    out.total = out.up + out.down + out.skip;
    out
}
