//! The migration runner: a version-0 database — the shape production has
//! until the multi-user deploy — comes out at the current version, every row
//! it held belongs to user 1, and its catalogs are *identical* to a database
//! created fresh. That last assertion is the one that matters: `SCHEMA` and
//! `MIGRATIONS` are two paths to one place, and without it they drift until a
//! query that passes every test against a fresh database fails in production.

mod common;

use common::TempDb;
use postgres::{Client, NoTls};
use rekorderlig::db::{get_meta, open_db, set_meta, Db, User, SCHEMA_VERSION};
use rekorderlig::model::FitOptions;
use rekorderlig::service::{train_and_score, ModelCache};

/// The schema as `db.rs` spelled it before `users` existed, frozen. A
/// database built from this is version 0. Never edit it: it is what the
/// migration is tested against, and production is what it describes.
const SCHEMA_V0: &str = "
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

/// Build a version-0 database with a little of everything in it, the way a
/// raw `psql` would — `open_db` cannot be used here, it would migrate.
fn version_zero(db: &TempDb) -> Client {
    let mut client = Client::connect(&db.url, NoTls).expect("raw connect");
    client.batch_execute(SCHEMA_V0).expect("v0 schema");
    client
        .batch_execute(
            "INSERT INTO stories (id, title, url, domain, author, points, num_comments, created_at, day, fetched_at)
             SELECT g, CASE WHEN g <= 4 THEN 'Rust story ' ELSE 'Apple story ' END || g,
                    'https://example.com/' || g, 'example.com', 'u' || g, 100, 50,
                    1700000000 + g, '2023-11-14', 1700000000
             FROM generate_series(1, 10) g;
             INSERT INTO votes (story_id, value, created_at, updated_at)
             SELECT g, CASE WHEN g <= 4 THEN 1 ELSE -1 END, 1700000100 + g, 1700000100 + g
             FROM generate_series(1, 8) g;
             INSERT INTO scores (story_id, score, confidence, model_rev)
             SELECT g, 0.5, 0.5, 3 FROM generate_series(1, 10) g;
             INSERT INTO oof_scores (story_id, score, model_rev)
             SELECT g, 0.6, 3 FROM generate_series(1, 8) g;
             INSERT INTO oof_previous (story_id, score, model_rev)
             SELECT g, 0.4, 2 FROM generate_series(1, 8) g;
             INSERT INTO vote_predictions (story_id, score, confidence, model_rev, created_at)
             SELECT g, 0.7, 0.3, 2, 1700000100 FROM generate_series(1, 8) g;
             INSERT INTO models (trained_at, n_votes, payload) VALUES (1, 6, '{}'), (2, 7, '{}'), (3, 8, '{}');
             INSERT INTO meta (key, value) VALUES
               ('last_sync_at', '1700000200'),
               ('round_seq', '7'),
               ('last_train_at', '1700000150'),
               ('current_round', '{\"seq\":7,\"rev\":3,\"size\":1,\"dealtAt\":1700000160,\"dealt\":[{\"id\":9}]}');",
        )
        .expect("v0 rows");
    client
}

fn count(db: &Db, sql: &str) -> i64 {
    db.query_one(sql, &[]).expect("count").get(0)
}

#[test]
fn a_version_zero_database_migrates_and_every_row_belongs_to_user_1() {
    let db = TempDb::new("migration-v0");
    let mut raw = version_zero(&db);
    assert!(raw
        .query_opt("SELECT 1 FROM meta WHERE key = 'schema_version'", &[])
        .unwrap()
        .is_none());
    drop(raw);

    let conn = db.open();
    assert_eq!(
        get_meta(&conn, "schema_version").unwrap(),
        SCHEMA_VERSION.to_string()
    );

    // Every pre-existing row is the owner's, and none went missing.
    for (table, n) in [
        ("votes", 8),
        ("scores", 10),
        ("oof_scores", 8),
        ("oof_previous", 8),
        ("vote_predictions", 8),
        ("models", 3),
    ] {
        assert_eq!(
            count(&conn, &format!("SELECT COUNT(*) FROM {table}")),
            n,
            "{table}"
        );
        assert_eq!(
            count(
                &conn,
                &format!("SELECT COUNT(*) FROM {table} WHERE user_id = 1")
            ),
            n,
            "{table} rows on user 1"
        );
    }
    // Revision numbers survive as they were.
    let revs: Vec<i64> = conn
        .query("SELECT rev FROM models ORDER BY rev", &[])
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    assert_eq!(revs, vec![1, 2, 3]);

    // One user, the owner, carrying the round counter and the train stamp out
    // of meta; the round in flight itself is dropped, its votes were saved.
    let users: Vec<(
        i64,
        String,
        Option<Vec<u8>>,
        i64,
        Option<String>,
        Option<i64>,
    )> = conn
        .query(
            "SELECT id, name, token_hash, round_seq, current_round, last_train_at FROM users",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4), r.get(5)))
        .collect();
    assert_eq!(
        users,
        vec![(1, "owner".to_string(), None, 7, None, Some(1700000150))]
    );
    let mut keys: Vec<String> = conn
        .query("SELECT key FROM meta ORDER BY key", &[])
        .unwrap()
        .iter()
        .map(|r| r.get(0))
        .collect();
    keys.sort();
    assert_eq!(keys, vec!["last_sync_at", "schema_version"]);
    assert_eq!(get_meta(&conn, "last_sync_at").unwrap(), "1700000200");

    // The next user is 2: an explicit id 1 never advanced the identity, and
    // START WITH 2 is what keeps the first real `user add` off the owner.
    let next: i64 = conn
        .query_one(
            "INSERT INTO users (name, created_at) VALUES ('second', 0) RETURNING id",
            &[],
        )
        .unwrap()
        .get(0);
    assert_eq!(next, 2);

    // Opening it again is a no-op, not a second migration.
    let again = db.open();
    assert_eq!(count(&again, "SELECT COUNT(*) FROM users"), 2);

    // And the migrated database works: a retrain allocates the next revision
    // after the ones it inherited, for the user who inherited them.
    let cache = ModelCache::default();
    let outcome = train_and_score(&conn, &cache, User::OWNER, FitOptions::default());
    assert_eq!(
        outcome.rev(),
        Some(4),
        "rev continues from the migrated max"
    );
}

/// One line per column, index, constraint and sequence — everything the two
/// paths could disagree on. Column order included: `user_id` is last in
/// SCHEMA precisely so that ADD COLUMN and CREATE TABLE agree.
fn catalog(db: &Db) -> Vec<String> {
    let mut out = Vec::new();
    for r in db
        .query(
            "SELECT table_name, ordinal_position, column_name, data_type, is_nullable,
                    COALESCE(column_default, ''), is_identity, COALESCE(identity_generation, ''),
                    COALESCE(identity_start, '')
             FROM information_schema.columns WHERE table_schema = 'public'
             ORDER BY table_name, ordinal_position",
            &[],
        )
        .unwrap()
    {
        out.push(format!(
            "column {}.{} #{} {} null={} default={} identity={} {} start={}",
            r.get::<_, String>(0),
            r.get::<_, String>(2),
            r.get::<_, i32>(1),
            r.get::<_, String>(3),
            r.get::<_, String>(4),
            r.get::<_, String>(5),
            r.get::<_, String>(6),
            r.get::<_, String>(7),
            r.get::<_, String>(8),
        ));
    }
    for r in db
        .query(
            "SELECT tablename, indexname, indexdef FROM pg_indexes
             WHERE schemaname = 'public' ORDER BY tablename, indexname",
            &[],
        )
        .unwrap()
    {
        out.push(format!(
            "index {}.{}: {}",
            r.get::<_, String>(0),
            r.get::<_, String>(1),
            r.get::<_, String>(2)
        ));
    }
    for r in db
        .query(
            "SELECT conrelid::regclass::text, conname, contype::text, pg_get_constraintdef(oid)
             FROM pg_constraint WHERE connamespace = 'public'::regnamespace
             ORDER BY 1, 2",
            &[],
        )
        .unwrap()
    {
        out.push(format!(
            "constraint {}.{} {}: {}",
            r.get::<_, String>(0),
            r.get::<_, String>(1),
            r.get::<_, String>(2),
            r.get::<_, String>(3)
        ));
    }
    for r in db
        .query(
            "SELECT sequencename, data_type::text, start_value, increment_by
             FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename",
            &[],
        )
        .unwrap()
    {
        out.push(format!(
            "sequence {} {} start={} by={}",
            r.get::<_, String>(0),
            r.get::<_, String>(1),
            r.get::<_, i64>(2),
            r.get::<_, i64>(3)
        ));
    }
    out
}

#[test]
fn a_migrated_database_has_the_same_shape_as_a_fresh_one() {
    let migrated = TempDb::new("migration-shape-old");
    drop(version_zero(&migrated));
    let migrated_conn = migrated.open();

    let fresh = TempDb::new("migration-shape-new");
    let fresh_conn = fresh.open();

    let (a, b) = (catalog(&migrated_conn), catalog(&fresh_conn));
    assert!(!a.is_empty());
    // Line by line, so a failure names the one thing that differs rather than
    // dumping two catalogs.
    for (line_a, line_b) in a.iter().zip(b.iter()) {
        assert_eq!(line_a, line_b, "migrated vs fresh");
    }
    assert_eq!(
        a.len(),
        b.len(),
        "migrated vs fresh: different number of catalog entries"
    );
}

#[test]
fn a_fresh_database_has_an_owner_and_the_current_version() {
    let db = TempDb::new("migration-fresh");
    let conn = db.open();
    assert_eq!(
        get_meta(&conn, "schema_version").unwrap(),
        SCHEMA_VERSION.to_string()
    );
    let owner: (i64, String) = conn
        .query_one("SELECT id, name FROM users", &[])
        .map(|r| (r.get(0), r.get(1)))
        .unwrap();
    assert_eq!(owner, (1, "owner".to_string()));
    // A second open finds nothing to do and does not insert a second owner.
    drop(db.open());
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM users"), 1);
}

#[test]
fn an_older_binary_refuses_a_newer_database() {
    // "Redeploy the old image" is not a rollback once the schema has moved; a
    // binary that meets a database it does not know must stop, not guess.
    let db = TempDb::new("migration-ahead");
    let conn = db.open();
    set_meta(&conn, "schema_version", &(SCHEMA_VERSION + 1).to_string());
    let url = db.url.clone();
    let result = std::panic::catch_unwind(move || open_db(&url));
    assert!(
        result.is_err(),
        "open_db must refuse a database from the future"
    );
}
