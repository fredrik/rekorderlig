//! Schema, the connection wrapper, and the vote/story queries. There is still
//! no migration system — only `CREATE ... IF NOT EXISTS`, run on every connect —
//! and the schema is a straight port of the SQLite one it replaces: same
//! tables, same column names, same `models.payload` JSON, so an imported
//! production database reads back identically.

use std::cell::{Cell, RefCell};

use postgres::types::ToSql;
use postgres::{Client, Error, NoTls, Row};
use serde::Serialize;

use crate::dates::now_seconds;

/// Everything a fresh database needs. Idempotent, and wrapped in an advisory
/// lock by `open_db` because the server, the trainer and the syncer can all
/// connect at boot: two sessions running `CREATE TABLE IF NOT EXISTS` at once
/// race in `pg_type` and one of them fails with a duplicate key error rather
/// than the no-op the statement promises.
///
/// `DOUBLE PRECISION`, never `REAL`: Postgres `REAL` is four bytes, and the
/// scores round-trip through it lossily. `BIGINT` throughout for the same
/// reason SQLite used `INTEGER` — HN item ids are already past 2^31.
const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS stories (
  id            BIGINT PRIMARY KEY,      -- Hacker News item id
  title         TEXT   NOT NULL,
  url           TEXT,
  domain        TEXT,
  author        TEXT,
  points        BIGINT NOT NULL DEFAULT 0,
  num_comments  BIGINT NOT NULL DEFAULT 0,
  created_at    BIGINT NOT NULL,         -- unix seconds, story creation
  day           TEXT   NOT NULL,         -- YYYY-MM-DD (UTC) for day grouping
  fetched_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_day ON stories(day);
CREATE INDEX IF NOT EXISTS idx_stories_created ON stories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stories_comments ON stories(num_comments DESC);
-- Reposts are collapsed at read time (service.rs), so nothing looks stories up
-- by URL any more; the index only cost us writes on every sync.
DROP INDEX IF EXISTS idx_stories_url;

-- One row per judged story. value: 1 = thumb up, -1 = thumb down, 0 = skipped.
CREATE TABLE IF NOT EXISTS votes (
  story_id   BIGINT PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
  value      BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_votes_created ON votes(created_at DESC);

-- Cached model scores so the feed can be sorted in SQL.
CREATE TABLE IF NOT EXISTS scores (
  story_id   BIGINT PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
  score      DOUBLE PRECISION NOT NULL,           -- probability of 'thumb up', 0..1
  confidence DOUBLE PRECISION NOT NULL DEFAULT 0, -- 0..1, how much evidence backs the score
  model_rev  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_score ON scores(score DESC);
-- The training queue seeks into the score axis instead of scanning it, so that
-- a multi-year archive costs the same as a week. Two expression indexes carry
-- that: the *unshrunk* offset from 0.5 (see RAW_OFFSET in service.rs — the
-- stored score is pulled toward 0.5 by confidence, so ranking on it ranks
-- ignorance rather than uncertainty), and confidence on its own for the slots
-- that deliberately hunt titles the model has no vocabulary for.
--
-- The `::double precision` casts are load-bearing. A bare `0.5` literal is
-- `numeric`, so the indexed expression would be numeric arithmetic while the
-- query's is float arithmetic; the two would not match after type resolution
-- and the planner would silently ignore the index. RAW_OFFSET in service.rs
-- must stay character-identical to this, modulo the `sc.` alias.
CREATE INDEX IF NOT EXISTS idx_scores_raw_offset ON scores(
  ((score - 0.5::double precision)
   / (0.3::double precision + 0.7::double precision * confidence))
);
CREATE INDEX IF NOT EXISTS idx_scores_confidence ON scores(confidence);

-- Held-out predictions: for each voted story, what the model said about it
-- while it was in the fold that trained without it. Unlike the scores table,
-- this is not memorised: the trained model separates its own training set
-- perfectly, so only the out-of-fold number can disagree with a verdict.
-- Rewritten whole on every train; an empty table means no model has held
-- anything out yet.
CREATE TABLE IF NOT EXISTS oof_scores (
  story_id  BIGINT PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
  score     DOUBLE PRECISION NOT NULL,   -- probability of 'thumb up', 0..1
  model_rev BIGINT NOT NULL
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
  story_id  BIGINT PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
  score     DOUBLE PRECISION NOT NULL,
  model_rev BIGINT NOT NULL              -- which revision held these out
);

-- What the model predicted about a story at the instant it was judged.
-- The scores table cannot answer this after the fact: it is rewritten on every
-- retrain, and once a vote exists the model has memorised it (yes ~0.99). The
-- number captured here was a genuine out-of-sample guess — the vote it is
-- compared against did not exist when it was made — which is what makes
-- 'the brain called this one' an honest claim rather than a flattering one.
-- Cleared with the vote, so re-judging captures a fresh prediction.
CREATE TABLE IF NOT EXISTS vote_predictions (
  story_id   BIGINT PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
  score      DOUBLE PRECISION NOT NULL,
  confidence DOUBLE PRECISION NOT NULL,
  model_rev  BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

-- Serialised model snapshots (weights + metrics), newest revision wins.
-- BY DEFAULT rather than ALWAYS: the one-shot importer that carried the
-- SQLite database over wrote explicit revision numbers, and the table it
-- created is the one production runs on. IF NOT EXISTS could not change it now.
CREATE TABLE IF NOT EXISTS models (
  rev        BIGINT PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY,
  trained_at BIGINT NOT NULL,
  n_votes    BIGINT NOT NULL,
  payload    TEXT   NOT NULL             -- JSON: weights, vocab, metrics
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
";

// One arbitrary constant, shared by every process that runs SCHEMA. Only the
// value matters, not what it spells.
const SCHEMA_LOCK: i64 = 4_919_420_187;

// The moral replacement for SQLite's `busy_timeout`: a query that has gone
// wrong errors instead of pinning a request thread forever. Generous enough
// that nothing legitimate here comes close — the slowest statement in the app
// is the corpus rescore, and that is a batched write measured in hundreds of
// milliseconds.
const STATEMENT_TIMEOUT: &str = "SET statement_timeout = '30s'";

/// Where the database lives; workers open their own connection here.
pub fn db_url() -> String {
    match std::env::var("DATABASE_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => "postgres://postgres@localhost:5432/rekorderlig".to_string(),
    }
}

fn connect(url: &str) -> Client {
    // No TLS. The only deployment is a second machine on the same Fly app,
    // reached over 6PN — a WireGuard mesh that is already encrypted end to end
    // — and the alternative pulls rustls and a certificate story into a binary
    // whose whole shape is "one static musl file". If this ever has to cross a
    // public network, this function is the one place that changes.
    let mut client = Client::connect(url, NoTls).expect("connect to postgres");
    client
        .batch_execute(STATEMENT_TIMEOUT)
        .expect("statement_timeout");
    client
}

/// Whether an error means "this socket is gone", and so is worth one reopen.
///
/// `is_closed()` alone is not enough, and finding that out the hard way is why
/// the reconnect test exists: a backend killed under us surfaces as a plain
/// `ConnectionReset` I/O error, and `is_closed()` is false for it. The rule
/// that does hold is that anything the *server* answered carries a SQLSTATE —
/// a constraint violation, a syntax error, a statement timeout — and must
/// never be retried, while a connection that died before it could answer
/// carries an I/O error somewhere in its source chain and nothing else.
fn is_disconnect(e: &Error) -> bool {
    if e.is_closed() {
        return true;
    }
    if e.as_db_error().is_some() {
        return false;
    }
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        if s.is::<std::io::Error>() {
            return true;
        }
        source = s.source();
    }
    false
}

/// A connection that survives the machine suspending.
///
/// Fly suspends the app machine to RAM when it is idle, so every socket held
/// across a suspend is dead on resume and the first statement after a visit
/// fails. `Db` reopens and retries that statement once, which is the whole
/// reason this is a wrapper rather than a bare `Client`.
///
/// Interior mutability (`RefCell`) rather than `&mut self`: the callers here
/// pass `&Db` down through closures and helper functions, exactly as they
/// passed `&Connection`, and `postgres::Client`'s `&mut self` methods would
/// have rewritten every signature in the crate for no behavioural gain. The
/// request path holds it behind a `Mutex`, workers own one each; nothing ever
/// shares one without that mutex, and every method here materialises its rows
/// before returning, so a borrow is never live across a call back into `Db`.
pub struct Db {
    url: String,
    client: RefCell<Client>,
    /// Whether a transaction is open. Two jobs: a statement inside one must
    /// never be silently retried on a reconnect (the transaction is already
    /// gone, and half of it would be replayed against a clean session), and
    /// `App::lock_db` uses it to roll back what a panicking handler left open.
    in_tx: Cell<bool>,
}

impl Db {
    fn reconnect(&self) {
        *self.client.borrow_mut() = connect(&self.url);
        self.in_tx.set(false);
    }

    /// Run `f`, and on a closed connection reopen and run it once more.
    ///
    /// Never retried inside a transaction: the disconnect already rolled that
    /// transaction back, so replaying one statement of it on a fresh session
    /// would commit a fragment. The error is reported instead.
    fn retrying<T>(&self, f: impl Fn(&mut Client) -> Result<T, Error>) -> Result<T, Error> {
        let first = f(&mut self.client.borrow_mut());
        match first {
            Err(e) if is_disconnect(&e) && !self.in_tx.get() => {
                self.reconnect();
                f(&mut self.client.borrow_mut())
            }
            other => other,
        }
    }

    pub fn execute(&self, sql: &str, params: &[&(dyn ToSql + Sync)]) -> Result<u64, Error> {
        self.retrying(|c| c.execute(sql, params))
    }

    /// Multiple statements in one round trip. No parameters, by definition.
    pub fn execute_batch(&self, sql: &str) -> Result<(), Error> {
        self.retrying(|c| c.batch_execute(sql))
    }

    pub fn query(&self, sql: &str, params: &[&(dyn ToSql + Sync)]) -> Result<Vec<Row>, Error> {
        self.retrying(|c| c.query(sql, params))
    }

    pub fn query_one(&self, sql: &str, params: &[&(dyn ToSql + Sync)]) -> Result<Row, Error> {
        self.retrying(|c| c.query_one(sql, params))
    }

    pub fn query_opt(
        &self,
        sql: &str,
        params: &[&(dyn ToSql + Sync)],
    ) -> Result<Option<Row>, Error> {
        self.retrying(|c| c.query_opt(sql, params))
    }

    /// Transactions are plain `BEGIN`/`COMMIT` statements rather than the
    /// crate's `Transaction` type, which borrows the client for its lifetime —
    /// and every batched write here calls helpers (`upsert_story`) that take
    /// `&Db` and would then be borrowing it a second time. The flag is what
    /// buys back the two things the typed API would have given: no retry
    /// across a transaction, and a stranded one rolled back before reuse.
    pub fn begin(&self) {
        self.execute_batch("BEGIN").expect("begin");
        self.in_tx.set(true);
    }

    pub fn commit(&self) {
        self.in_tx.set(false);
        self.execute_batch("COMMIT").expect("commit");
    }

    /// Roll back a transaction a panicking caller left open. A no-op when
    /// there is none, and it costs no round trip in that case.
    pub fn rollback_if_open(&self) {
        if self.in_tx.get() {
            self.in_tx.set(false);
            let _ = self.execute_batch("ROLLBACK");
        }
    }

    /// Kill this session's own backend, so the next statement meets a dead
    /// socket. Only the reconnect test wants this; production reaches the same
    /// state by being suspended to RAM and woken an hour later.
    pub fn terminate_for_test(&self) {
        // Straight at the client, not through `retrying`: going through it
        // would reconnect on the spot and hand the test back a live
        // connection, which is the opposite of what it asked for.
        let _ = self
            .client
            .borrow_mut()
            .execute("SELECT pg_terminate_backend(pg_backend_pid())", &[]);
    }
}

/// Open an independent connection to `url` (server, workers, tests, tooling).
pub fn open_db(url: &str) -> Db {
    let db = Db {
        url: url.to_string(),
        client: RefCell::new(connect(url)),
        in_tx: Cell::new(false),
    };
    // One transaction, one lock: `pg_advisory_xact_lock` releases on commit,
    // so nothing has to remember to unlock it — including a process that dies
    // holding it.
    db.execute_batch(&format!(
        "BEGIN; SELECT pg_advisory_xact_lock({SCHEMA_LOCK}); {SCHEMA} COMMIT;"
    ))
    .expect("schema");
    db
}

pub fn get_meta(db: &Db, key: &str) -> Option<String> {
    db.query_opt("SELECT value FROM meta WHERE key = $1", &[&key])
        .expect("get_meta")
        .map(|r| r.get(0))
}

pub fn set_meta(db: &Db, key: &str, value: &str) {
    db.execute(
        "INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        &[&key, &value],
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

impl Story {
    /// The ten base columns, in the order `STORY_SELECT` asks for them.
    pub fn from_row(r: &Row) -> Story {
        Story {
            id: r.get(0),
            title: r.get(1),
            url: r.get(2),
            domain: r.get(3),
            author: r.get(4),
            points: r.get(5),
            num_comments: r.get(6),
            created_at: r.get(7),
            day: r.get(8),
            fetched_at: r.get(9),
        }
    }
}

pub const STORY_SELECT: &str =
    "SELECT id, title, url, domain, author, points, num_comments, created_at, day, fetched_at
     FROM stories";

pub fn upsert_story(db: &Db, s: &Story) {
    db.execute(
        "INSERT INTO stories (id, title, url, domain, author, points, num_comments, created_at, day, fetched_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           url = excluded.url,
           domain = excluded.domain,
           points = GREATEST(stories.points, excluded.points),
           num_comments = GREATEST(stories.num_comments, excluded.num_comments),
           fetched_at = excluded.fetched_at",
        &[
            &s.id, &s.title, &s.url, &s.domain, &s.author,
            &s.points, &s.num_comments, &s.created_at, &s.day, &s.fetched_at,
        ],
    )
    .expect("upsert_story");
}

// A vote is recorded against exactly the submission that was judged. Reposts of
// the same URL are NOT co-signed: the model reads titles, and a twin's title is
// one you never saw. Duplicates are collapsed where they show up instead — the
// training queue (service.rs) offers one card per URL / title.
pub fn record_vote(db: &Db, story_id: i64, value: i64) {
    record_vote_at(db, story_id, value, now_seconds());
}

pub fn record_vote_at(db: &Db, story_id: i64, value: i64, now: i64) {
    db.execute(
        "INSERT INTO votes (story_id, value, created_at, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(story_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        &[&story_id, &value, &now, &now],
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
pub fn import_vote(db: &Db, story_id: i64, value: i64, created_at: i64) {
    db.execute(
        "INSERT INTO votes (story_id, value, created_at, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT(story_id) DO UPDATE SET
           value = excluded.value,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at",
        &[&story_id, &value, &created_at, &created_at],
    )
    .expect("import_vote");
}

pub fn delete_vote(db: &Db, story_id: i64) {
    db.execute("DELETE FROM votes WHERE story_id = $1", &[&story_id])
        .expect("delete_vote");
    // The captured prediction belonged to that vote. Undo means the next
    // judgement gets a fresh one, from whatever the model believes by then.
    db.execute(
        "DELETE FROM vote_predictions WHERE story_id = $1",
        &[&story_id],
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
pub fn capture_prediction(db: &Db, story_id: i64) -> Option<CapturedPrediction> {
    let row = db
        .query_opt(
            "SELECT score, confidence, model_rev FROM scores WHERE story_id = $1",
            &[&story_id],
        )
        .expect("capture_prediction read")?;
    let (score, confidence, model_rev): (f64, f64, i64) = (row.get(0), row.get(1), row.get(2));
    db.execute(
        "INSERT INTO vote_predictions (story_id, score, confidence, model_rev, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT(story_id) DO UPDATE SET
           score = excluded.score, confidence = excluded.confidence,
           model_rev = excluded.model_rev, created_at = excluded.created_at",
        &[&story_id, &score, &confidence, &model_rev, &now_seconds()],
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
///
/// `created_at` is not unique — two votes a second apart in the UI can share a
/// timestamp, and a restored history can carry a whole batch on one — and
/// Postgres promises nothing about ties, so the story id settles them: the
/// training set has to come out in the same order twice for the model to be
/// the deterministic function of the votes it claims to be.
///
/// DESC, which looks arbitrary and is not. It is the order SQLite happened to
/// produce, reverse-scanning `idx_votes_created`, for as long as this ran on
/// SQLite. Example order decides the order features are first seen, and so the
/// whole AdaGrad trajectory: with the other tiebreaker the first retrain after
/// the migration produced a model that scored identically (same features, same
/// cross-validated accuracy to sixteen digits) and weighed everything a little
/// differently. Equally valid, and not what "a retrain reproduces the model"
/// promises. Two votes out of seven hundred were affected; the point is that
/// the number is zero.
pub fn labelled_stories(db: &Db) -> Vec<Labelled> {
    db.query(
        "SELECT s.id, s.title, s.url, s.domain, s.author, s.points, s.num_comments,
                s.created_at, s.day, s.fetched_at, v.value
         FROM votes v JOIN stories s ON s.id = v.story_id
         WHERE v.value != 0
         ORDER BY v.created_at ASC, v.story_id DESC",
        &[],
    )
    .expect("labelled_stories")
    .iter()
    .map(|r| Labelled {
        story: Story::from_row(r),
        value: r.get(10),
    })
    .collect()
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub struct VoteCounts {
    pub up: i64,
    pub down: i64,
    pub skip: i64,
    pub total: i64,
}

pub fn vote_counts(db: &Db) -> VoteCounts {
    let mut out = VoteCounts {
        up: 0,
        down: 0,
        skip: 0,
        total: 0,
    };
    for r in db
        .query("SELECT value, COUNT(*) AS n FROM votes GROUP BY value", &[])
        .expect("vote_counts")
    {
        let (value, n): (i64, i64) = (r.get(0), r.get(1));
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
