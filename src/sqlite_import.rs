//! The one-way trip: a SQLite database written by the old backend, copied into
//! Postgres. Temporary by design — `rekorderlig import-sqlite <path.db>`, only
//! in a build with `--features sqlite-import`, so the shipped binary never
//! links SQLite at all. Delete this module, the feature and the `rusqlite`
//! dependency once the cutover has settled.
//!
//! Every table is streamed in id order, batched, inside one transaction: an
//! interrupted import leaves the database exactly as it found it rather than
//! half-populated, which matters because the thing being carried over is the
//! only copy of the votes.
//!
//! **Votes and `vote_predictions` are the acceptance bar.** Stories are
//! refetchable, scores and held-out predictions are rewritten by the next
//! train, and `models` is a deterministic function of the votes — those tables
//! are carried because rebuilding them costs an afternoon, not because losing
//! one would lose anything. A vote is a judgement that only exists here.

use rusqlite::Connection;

use crate::db::Db;
use crate::service::insert_chunked;

/// What the import found and wrote, per table, so the two sides can be
/// compared without a second tool.
pub struct ImportReport {
    pub tables: Vec<(&'static str, i64)>,
}

impl ImportReport {
    pub fn total(&self) -> i64 {
        self.tables.iter().map(|(_, n)| n).sum()
    }
}

fn count(src: &Connection, table: &str) -> i64 {
    src.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap_or(0)
}

pub fn import_sqlite(db: &Db, path: &str) -> Result<ImportReport, String> {
    let src = Connection::open(path).map_err(|e| format!("open {path}: {e}"))?;
    // Read-only intent, stated: nothing here writes to the snapshot, and a
    // snapshot pulled by `scripts/pull-prod-db.sh` is chmod'd read-only anyway.
    src.execute_batch("PRAGMA query_only = ON")
        .map_err(|e| e.to_string())?;

    // Refuse a target that already holds rows. `ON CONFLICT DO NOTHING` is what
    // makes a re-run after a failure converge instead of doubling — and it is
    // also what would make an import into a populated database keep the rows
    // already there and skip the incoming ones, silently, since the row-count
    // check at the end cannot tell a stale row from a fresh one. A failed
    // import is not this case: the whole thing is one transaction, so it rolls
    // back to empty and re-running is clean. Rows here mean something else put
    // them there.
    for table in ["stories", "votes", "models"] {
        let n: i64 = db
            .query_one(&format!("SELECT COUNT(*) FROM {table}"), &[])
            .expect("check empty")
            .get(0);
        if n > 0 {
            return Err(format!(
                "{table} already holds {n} rows — import wants an empty database.\n\
                 Drop and recreate it, or TRUNCATE, before importing."
            ));
        }
    }

    let mut tables = Vec::new();
    db.begin();

    // Stories first: every other table has a foreign key onto it.
    let stories: Vec<(
        i64,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        i64,
        i64,
        i64,
        String,
        i64,
    )> = rows(
        &src,
        "SELECT id, title, url, domain, author, points, num_comments, created_at, day, fetched_at
                    FROM stories ORDER BY id",
        |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
                r.get(9)?,
            ))
        },
    )?;
    insert_chunked(
        db,
        "INSERT INTO stories (id, title, url, domain, author, points, num_comments, created_at, day, fetched_at)",
        10,
        "ON CONFLICT(id) DO NOTHING",
        &stories,
        |s, p| {
            p.push(Box::new(s.0));
            p.push(Box::new(s.1.clone()));
            p.push(Box::new(s.2.clone()));
            p.push(Box::new(s.3.clone()));
            p.push(Box::new(s.4.clone()));
            p.push(Box::new(s.5));
            p.push(Box::new(s.6));
            p.push(Box::new(s.7));
            p.push(Box::new(s.8.clone()));
            p.push(Box::new(s.9));
        },
    );
    tables.push(("stories", stories.len() as i64));

    let votes: Vec<(i64, i64, i64, i64)> = rows(
        &src,
        "SELECT story_id, value, created_at, updated_at FROM votes ORDER BY story_id",
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    insert_chunked(
        db,
        "INSERT INTO votes (story_id, value, created_at, updated_at)",
        4,
        "ON CONFLICT(story_id) DO NOTHING",
        &votes,
        |v, p| {
            p.push(Box::new(v.0));
            p.push(Box::new(v.1));
            p.push(Box::new(v.2));
            p.push(Box::new(v.3));
        },
    );
    tables.push(("votes", votes.len() as i64));

    for table in ["scores", "vote_predictions"] {
        let sql = if table == "scores" {
            "SELECT story_id, score, confidence, model_rev, 0 FROM scores ORDER BY story_id"
        } else {
            "SELECT story_id, score, confidence, model_rev, created_at
             FROM vote_predictions ORDER BY story_id"
        };
        let items: Vec<(i64, f64, f64, i64, i64)> = rows(&src, sql, |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?;
        let (head, cols, tail) = if table == "scores" {
            (
                "INSERT INTO scores (story_id, score, confidence, model_rev)",
                4,
                "ON CONFLICT(story_id) DO NOTHING",
            )
        } else {
            (
                "INSERT INTO vote_predictions (story_id, score, confidence, model_rev, created_at)",
                5,
                "ON CONFLICT(story_id) DO NOTHING",
            )
        };
        insert_chunked(db, head, cols, tail, &items, |v, p| {
            p.push(Box::new(v.0));
            p.push(Box::new(v.1));
            p.push(Box::new(v.2));
            p.push(Box::new(v.3));
            if cols == 5 {
                p.push(Box::new(v.4));
            }
        });
        tables.push((
            if table == "scores" {
                "scores"
            } else {
                "vote_predictions"
            },
            items.len() as i64,
        ));
    }

    for table in ["oof_scores", "oof_previous"] {
        let items: Vec<(i64, f64, i64)> = rows(
            &src,
            &format!("SELECT story_id, score, model_rev FROM {table} ORDER BY story_id"),
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let head = if table == "oof_scores" {
            "INSERT INTO oof_scores (story_id, score, model_rev)"
        } else {
            "INSERT INTO oof_previous (story_id, score, model_rev)"
        };
        insert_chunked(
            db,
            head,
            3,
            "ON CONFLICT(story_id) DO NOTHING",
            &items,
            |v, p| {
                p.push(Box::new(v.0));
                p.push(Box::new(v.1));
                p.push(Box::new(v.2));
            },
        );
        tables.push((
            if table == "oof_scores" {
                "oof_scores"
            } else {
                "oof_previous"
            },
            items.len() as i64,
        ));
    }

    // Explicit `rev` values, which is why the column is GENERATED BY DEFAULT
    // rather than ALWAYS: the learning curve and every round summary name
    // revisions by number, so renumbering them would silently rewrite history.
    let models: Vec<(i64, i64, i64, String)> = rows(
        &src,
        "SELECT rev, trained_at, n_votes, payload FROM models ORDER BY rev",
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    insert_chunked(
        db,
        "INSERT INTO models (rev, trained_at, n_votes, payload)",
        4,
        "ON CONFLICT(rev) DO NOTHING",
        &models,
        |m, p| {
            p.push(Box::new(m.0));
            p.push(Box::new(m.1));
            p.push(Box::new(m.2));
            p.push(Box::new(m.3.clone()));
        },
    );
    tables.push(("models", models.len() as i64));

    let meta: Vec<(String, String)> =
        rows(&src, "SELECT key, value FROM meta ORDER BY key", |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?;
    insert_chunked(
        db,
        "INSERT INTO meta (key, value)",
        2,
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        &meta,
        |m, p| {
            p.push(Box::new(m.0.clone()));
            p.push(Box::new(m.1.clone()));
        },
    );
    tables.push(("meta", meta.len() as i64));

    // The identity sequence has not moved — every `rev` above was supplied —
    // so the next train would collide with rev 1. Wind it past the highest
    // imported revision.
    db.execute_batch(
        "SELECT setval(pg_get_serial_sequence('models', 'rev'), COALESCE((SELECT MAX(rev) FROM models), 1))",
    )
    .expect("advance models sequence");

    db.commit();

    // A freshly restored database has no statistics, and without them the
    // planner will not choose `idx_scores_raw_offset` — the training queue
    // would seq-scan the whole corpus for every card until autovacuum
    // happened to catch up. Cheap here, invisible if forgotten.
    db.execute_batch("ANALYZE").expect("analyze");

    // Read the source back and compare, so a silently truncated table is a
    // failed import rather than a quiet one.
    for (table, written) in &tables {
        let there = count(&src, table);
        if there != *written {
            return Err(format!("{table}: read {written} of {there} rows"));
        }
        let here: i64 = db
            .query_one(&format!("SELECT COUNT(*) FROM {table}"), &[])
            .expect("verify count")
            .get(0);
        if here != there {
            return Err(format!("{table}: {there} in SQLite, {here} in Postgres"));
        }
    }

    Ok(ImportReport { tables })
}

fn rows<T>(
    src: &Connection,
    sql: &str,
    map: impl Fn(&rusqlite::Row) -> rusqlite::Result<T>,
) -> Result<Vec<T>, String> {
    let mut stmt = src.prepare(sql).map_err(|e| e.to_string())?;
    let out = stmt
        .query_map([], |r| map(r))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<T>>>()
        .map_err(|e| e.to_string())?;
    Ok(out)
}
