# Replacing SQLite with Postgres — migration plan

Status: **plan only, no code yet.** This document is the design for swapping
`rusqlite` + one database file for a Postgres server, written against the
codebase as of `d57cf4b` (the Rust rewrite). It inventories every place the
app currently leans on SQLite specifically, decides the shape of the
replacement, and sequences the work so each phase lands green on its own.

## Why (and the honest costs)

Reasons to do it: a real database server survives the app process, takes
concurrent writers without a busy-timeout dance, can be examined and backed up
independently of the Fly volume, and removes the 1 GB volume as the corpus
ceiling. It also opens the door to running more than one app instance, which
a single WAL file on one volume forbids.

Costs to name up front, because today's design gets them for free:

- **A file never disconnects; a TCP connection does.** The Fly machine
  *suspends to RAM* when idle (`fly.toml`), so every held Postgres connection
  will be dead on resume. Reconnect handling is new, mandatory code — the
  single biggest behavioural change in this migration, and it has no SQLite
  counterpart to port.
- **Ops goes from "a file on a volume" to "a database server somewhere",**
  with its own cost, credentials, backups, and preview-app story.
- **Tests go from "open a temp file" to "have a Postgres running"** — locally
  and in CI.
- **Byte-compatibility with the old Node backend's database file** stops
  mattering the moment the data is migrated, but the migration itself is a
  one-time tool we must write and verify.

None of these are blockers; all of them are line items below.

## Decisions

### Driver: the `postgres` crate (sync facade over tokio-postgres)

The codebase is deliberately synchronous — no async runtime, and `service.rs`
/ `db.rs` are plain blocking functions taking `&Connection`. The `postgres`
crate keeps that shape exactly: every call blocks, so the port is mechanical
(`&Connection` → `&mut postgres::Client`). It embeds a current-thread tokio
runtime internally, which bends the "no async runtime" *dependency* spirit
while keeping the *code* spirit intact; the alternatives are worse:

- `diesel` (natively sync) binds to libpq via `pq-sys`, which complicates the
  static musl build the Dockerfile depends on. `postgres` is pure Rust and
  keeps `FROM alpine` + a static binary working unchanged.
- `sqlx` drags async through every call site — the one thing this codebase
  was built to avoid.

TLS (needed for any hosted Postgres): `postgres` + `tokio-postgres-rustls`,
staying pure-Rust for the musl build.

### Connection shape: same as today, plus reconnect

Keep the current architecture verbatim — it is already the right one for a
single-user app:

- `App.db: Mutex<Connection>` becomes a `Mutex` around a small `Db` wrapper
  owning a `postgres::Client`.
- Trainer and Syncer threads open **their own** client, exactly as they open
  their own SQLite connection now.
- **No pool.** One user, three connections. r2d2 would be machinery without a
  problem.

The `Db` wrapper is where reconnect lives: on `Error::is_closed()` (suspend /
resume, server restart, idle timeout), reopen the connection and retry the
statement **once**. The retried statements are all idempotent here — upserts,
whole-table rewrites, reads — but retries never span a transaction: a failed
transaction is rolled back by the disconnect itself and reported, not
replayed.

`App::lock_db()`'s poison-recovery rollback (`is_autocommit()` check) becomes
simpler: the request path stays autocommit, transactions move to the
`Transaction` API (see below), so a panic can no longer leave one open on the
shared client.

### Hosting: Fly Managed Postgres, same region

Recommendation: a smallest-tier **Fly Managed Postgres** cluster in `arn`,
next to the app. One vendor, private networking (`.flycast`, no public
exposure), latency in the same building as today's local file (~sub-ms vs.
µs — the feed does a handful of queries per request, so this is invisible).

The considered alternative is **Neon**: its scale-to-zero matches the app's
suspend-to-zero economics and its database branching would give PR previews
free copies. It costs an external vendor, TLS on every hop, and cold-start
latency stacked on top of the machine's own resume. Worth revisiting if the
Fly cluster's monthly cost annoys; nothing in the plan below depends on the
choice except the two workflow files.

The app keeps running on the same suspend-to-RAM machine; Postgres does not
change that. `DATABASE_URL` replaces `REKORDERLIG_DB` everywhere
(`db_path()` → `db_url()`, same env-override pattern).

### No storage trait, no dual-backend period

We port in place on a branch, not behind an abstraction. A `Storage` trait
serving both engines would double every query for a transition nobody is in:
single user, one production database, one cutover evening. The branch *is*
the abstraction. `rusqlite` survives only inside the one-time import tool,
feature-gated (below), and is deleted once production is migrated.

## Inventory: everything SQLite-specific, and its translation

### Schema (`src/db.rs` `SCHEMA`)

| SQLite | Postgres |
|---|---|
| `INTEGER` / `REAL` / `TEXT` | `BIGINT` / `DOUBLE PRECISION` / `TEXT` |
| `rev INTEGER PRIMARY KEY AUTOINCREMENT` | `rev BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY` |
| `CREATE ... IF NOT EXISTS` run on every open | same statements run on every connect — Postgres supports `IF NOT EXISTS` for tables and indexes alike, so the "no migration system" convention survives unchanged |
| expression index `((score - 0.5) / (0.3 + 0.7 * confidence))` | identical syntax; float arithmetic is `IMMUTABLE`, so it's allowed. The SQL text of `RAW_OFFSET` (service.rs) must keep matching the index expression **exactly** for the planner to use it — same rule as today, new planner |
| `DROP INDEX IF EXISTS idx_stories_url` | same |

Note on the schema-on-every-open convention: concurrent first connections
(server + trainer racing at boot) can both run `CREATE TABLE IF NOT EXISTS`
and one loses with a duplicate-key error on `pg_type`. Cheap fix: take
`pg_advisory_lock` around the schema batch. One line, removes the race class.

### Pragmas and connection setup (`open_db`)

- `journal_mode=WAL`, `busy_timeout`, `foreign_keys=ON` — all deleted.
  Postgres is MVCC, enforces FKs by default, and blocking waits are its
  normal behaviour. Set `statement_timeout` (say 30 s) as the moral
  replacement for `busy_timeout`, so a wedged query becomes an error instead
  of a hang.
- The registered `ln()` scalar function — deleted; Postgres has `ln()`
  natively. (The comment in `db.rs` explaining the registration goes with it.)

### SQL dialect, by call site

- **Placeholders**: `?1`/`?` → `$1`/`$2`… everywhere. Mechanical but touches
  every query; `rusqlite::params![]` → `&[&dyn ToSql]` slices.
- **`upsert_story`**: `MAX(stories.points, excluded.points)` — SQLite's
  two-argument scalar `MAX` is Postgres's `GREATEST(...)`. The
  `ON CONFLICT ... DO UPDATE SET ... excluded.x` syntax is otherwise
  identical (SQLite copied it from Postgres).
- **`model_history()`** (`service.rs:2075`): `json_extract(payload, '$.metrics.accuracy')`
  → `(payload::jsonb #>> '{metrics,accuracy}')::float8`, and
  `json_array_length(...)` → `jsonb_array_length(payload::jsonb #> '{model,names}')`.
  Keep `payload` as `TEXT` — the app writes and reads it as a string, only
  these two queries peek inside, and a cast per row on a table of ~50
  revisions is nothing. (Switching the column to `JSONB` would silently
  re-serialize the payload — key order, whitespace — and the payload's bytes
  are currently exactly what `serde_json` wrote.)
- **`reset_models()`**: the `sqlite_master` / `DELETE FROM sqlite_sequence`
  dance → `TRUNCATE models RESTART IDENTITY` (nothing references `models` by
  FK). The test asserting revision numbering restarts at 1
  (`tests/service.rs:2351`) carries over as-is.
- **Transactions**: `execute_batch("BEGIN") … ("COMMIT")` (hn.rs, firebase.rs,
  service.rs ×4) → the `postgres` `Transaction` API
  (`client.transaction()?` … `tx.commit()?`), which can't be left open by a
  panic on the request path.
- **`prepare_cached`**: the `postgres` crate has no statement cache, but
  `query`/`execute` with SQL text use unnamed prepared statements, and the
  hot statements here run at most a few dozen times per request. Port
  `prepare_cached` → plain `query`; if a batch loop measurably regresses
  (rescore_all's ~50k upserts), `prepare()` once per batch inside the
  transaction restores it — same shape the code already has.

### Planner-specific tricks (the commented ones)

CLAUDE.md and the code carry two hard-won SQLite planner rules; both go away
in Postgres, and one deliberate behaviour needs shoring up:

- *"`LIMIT`/`OFFSET` must be written into the SQL, never bound"* — a SQLite
  sorter-bounding quirk. Postgres plans bound limits fine. Keep the `int()`
  interpolation anyway (it's safe and avoids re-litigating parameter types),
  but the comments explaining *why* must be rewritten or dropped — a comment
  stating a false reason is worse than none.
- *"`MIN(id)`/`MAX(id)` must be two statements"* (`draw_explore`) — Postgres
  rewrites both aggregates in one statement into index lookups. Collapse to
  one query, or keep two harmlessly; either way, fix the comment.
- **Determinism of the seeded probes**: the queue promises "a round redraws
  identically on a reload", and the probe queries end in
  `ORDER BY <expr> LIMIT 1` where `<expr>` can tie. SQLite happens to break
  ties stably; Postgres makes no such promise (parallel plans, synchronized
  seqscans). Every probe/queue `ORDER BY` gets an explicit `, s.id` tiebreaker
  (`draw_boundary`, `draw_novel`, `fill_from_boundary`, `explore_queue`'s
  tiered order). The feed and vote log already carry `, s.id DESC` /
  `, v.story_id DESC` — this extends that discipline to the rest.
- **Seek-not-scan survives as the design.** The expression indexes port, the
  seeded probe pattern ports, and the O(log n)-per-card property is the same
  claim under a different planner. Re-measure the two benchmarks CLAUDE.md
  quotes (40-card draw over 1M rows; a 12-card round over the real corpus)
  after the port and update the numbers.

### Typing differences worth a sweep

`rusqlite` is duck-typed (INTEGER column happily yields `f64`); `postgres` is
strict — a `BIGINT` column read as `f64` is a runtime error, `LIMIT $1` wants
`i64`, and a `f64` parameter compared against a `BIGINT` column fails to
infer. The port therefore needs one deliberate pass over every `r.get(n)`
and parameter list checking Rust type ↔ column type, plus casts in SQL where
a comparison mixes them (`score_distribution`'s binning arithmetic,
`stories_per_day`, the hybrid feed's `0.7 * sc.score + 0.3 * ln(...)`
ordering — integer ÷ integer is integer division in both engines, but the
mixed-type promotion rules differ enough to test, not eyeball).

`SqlValue` (`rusqlite::types::Value`) used by `seek_one`'s param vectors gets
a small local enum or switches to `&[&dyn ToSql]` built per call.

## Phases

Each phase compiles and passes `cargo test` before the next starts; the
branch is reviewable phase by phase.

**Phase 1 — test and dev infrastructure.**
Stand up Postgres before touching app code, so the port lands onto a
harness that already works:
- `tests/common/mod.rs`: `TempDb` keeps its name and drop-cleans semantics,
  but becomes "create database `tmp_<name>` on the test server, drop on
  Drop". Server from `REKORDERLIG_TEST_PG` (default
  `postgres://localhost:5432`), with a clear panic message when absent.
  Per-test databases preserve the parallel-`cargo test` isolation the temp
  files give today.
- `.github/workflows/ci.yml`: add a `postgres:17` service container.
- A `docker compose` file (or a documented one-liner) for local dev, and a
  README note. CLAUDE.md's Testing section updates here.

**Phase 2 — `db.rs` port.**
Schema translation, `open_db(url)` with the advisory-locked schema batch,
`db_url()`, the `Db` reconnect wrapper, and the eight query functions in
`db.rs`. Unit-level integration tests for upsert/vote/import semantics come
over from the existing suites.

**Phase 3 — `service.rs`, `hn.rs`, `firebase.rs`, `server.rs` port.**
The bulk: placeholder rewrite, `GREATEST`, `jsonb` extraction, `Transaction`
API, the typing sweep, the `ORDER BY` tiebreakers, `reset_models`'
`TRUNCATE ... RESTART IDENTITY`. `trainer.rs`/`syncer.rs` change only their
`open_db` call. The full test suite (`tests/service.rs` is 2,480 lines and
covers rounds, flips, queue mix, reset numbering) is the safety net — it
ports in Phase 1 and must pass unmodified in spirit here.

**Phase 4 — the import tool.**
`rekorderlig import-sqlite <path.db>` behind a cargo feature
(`--features sqlite-import`) so `rusqlite` leaves the default build. It
streams every table (`stories`, `votes`, `scores`, `oof_scores`,
`oof_previous`, `vote_predictions`, `models`, `meta`) in one Postgres
transaction, then `setval`s the `models` identity to `MAX(rev)`. Verify by
row counts per table plus a spot-check (`stats()` output equal on both
engines against the same snapshot from `scripts/pull-prod-db.sh`). Votes and
`vote_predictions` are the irreplaceable record — everything else is
derivable (`models` is derived data by convention), so the acceptance bar is
those two tables importing byte-faithfully.

**Phase 5 — deploy.**
- `Dockerfile`: drop the `apk add sqlite` runtime dependency and the
  `REKORDERLIG_DB` env; the build stays static musl.
- `fly.toml`: no `[mounts]` — the volume goes (after a grace period holding
  the final SQLite snapshot).
- Secrets: `DATABASE_URL` via `fly secrets set`.
- `.github/workflows/preview.yml`: each PR preview needs a database. Simplest
  on Fly MPG: the workflow creates `preview_pr_<n>` on the shared cluster at
  deploy and drops it on close, mirroring what it already does with apps.
  (This is the step Neon branching would make prettier.)
- `scripts/pull-prod-db.sh` → `scripts/pull-prod-db.sh` rewritten around
  `pg_dump` (`fly mpg connect` / proxy + `pg_dump -Fc`), keeping the
  timestamped-read-only-snapshot convention.
- `sync.yml` is engine-agnostic (it POSTs `/api/sync`) — untouched.

**Phase 6 — cutover.**
1. Deploy the Postgres-backed app to a *preview* app first, import a fresh
   prod snapshot, click through Train/Explore/Feed/Votes/Brain, deal and
   finish a round.
2. Production: `fly machine stop` (stops writes), pull the final snapshot,
   run the import against the production cluster, `fly deploy` the new
   image, smoke-test, re-enable the hourly sync.
3. Keep the volume with the final `.db` for a couple of weeks as the
   rollback: the old image + the volume is a working system the moment we
   repoint, minus only votes cast after cutover (exportable back via
   `POST /api/import/vote` if it ever comes to that).

**Phase 7 — cleanup.**
Delete the `sqlite-import` feature and `rusqlite`, drop the volume, update
CLAUDE.md (the Shape section's "One SQLite file" paragraph, the pragma/WAL
notes, `pull-prod-db.sh`'s row, the Testing section, this file's status
line) and README.

## Risks

- **Suspend/resume vs. connections** (again, because it's the one that will
  actually page someone): the first request after a resume finds three dead
  clients. The reconnect wrapper must be tested deliberately — kill the
  connection under a test server and assert the retry — not discovered in
  production. Also verify Fly MPG's proxy idle-timeout behaviour.
- **Determinism regressions** in the seeded queue are silent (a reload
  reshuffles cards). The existing redraw-identity tests in `tests/service.rs`
  are the guard; run them repeatedly (`--test-threads` high) since tie-break
  instability is load-dependent.
- **The typing sweep** is where a mechanical port breaks at runtime rather
  than compile time. Mitigation is coverage: the integration suite exercises
  nearly every query, which is why Phase 1 comes first.
- **Cost/idle economics**: today idle costs ~nothing; an MPG cluster bills
  continuously. If that grates, the Neon variant is a contained change
  (connection string + preview workflow) — flagging it now so it isn't a
  surprise on the first invoice.

## Out of scope

Connection pooling, multi-instance serving, async, ORMs, a migration
framework, and any schema *redesign* — the schema ports as-is. Each of those
is a separate conversation the moment someone wants it; this migration's
contract is "same app, same behaviour, different engine".
