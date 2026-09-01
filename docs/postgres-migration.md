# Replacing SQLite with Postgres — migration plan

Status: **plan only, no code yet.** This document is the design for swapping
`rusqlite` + one database file for a Postgres server, written against `main`
as of `fcf5663`. It inventories every place the app currently leans on SQLite
specifically, decides the shape of the replacement, and sequences the work so
each phase lands green on its own.

The inventory is only worth what its accuracy is worth, so it is pinned to a
revision on purpose: `main` has since grown a Fly scheduled machine for the
hourly sync and a preview that seeds from a production *volume snapshot*, and
both changed what Phase 5 has to say. Re-read this section against `main`
before starting the work.

## Why (and the honest costs)

Reasons to do it: a real database server survives the app process, takes
concurrent writers without a busy-timeout dance, and can be examined and
backed up while the app is running rather than through a `VACUUM INTO` over
`fly ssh`. It also opens the door to running more than one app instance, which
a single WAL file on one volume forbids.

One reason that does *not* survive the hosting decision below: self-hosting
does not lift the storage ceiling or improve durability, it only moves both to
a different volume. Say the goal out loud so the plan is judged against it —
this migration buys a better *engine*, and buys better *operations* only to
the extent Phase 5 actually builds them.

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

### Hosting: a Postgres machine we run ourselves, on Fly, in `arn`

**Fly Managed Postgres is ruled out on cost.** Its smallest cluster bills
continuously at a multiple of what this whole app costs today, which is not a
sensible trade for a single-user recommender whose machine is asleep most of
the day.

Recommendation: **a second Fly machine running a stock `postgres:17-alpine`
image**, one volume mounted at `/var/lib/postgresql/data`, in `arn` beside the
app and reachable only over the private `.internal` network. Roughly $3–5 a
month for a `shared-cpu-1x` and a small volume.

Stock image rather than `fly pg create`: Fly's own unmanaged Postgres wraps
the database in repmgr and a `fly pg` command surface, and their docs say
plainly that they cannot provide support or guidance for unmanaged Postgres.
For one node that machinery is cost without benefit — a plain Postgres
container is fewer moving parts, is the same thing `docker compose` runs
locally in Phase 1, and can be lifted to another host later without unpicking
Fly-specific scaffolding.

Two properties of this choice matter downstream:

- **Keep the Postgres machine always on** (`auto_stop_machines = false`,
  `min_machines_running = 1`). It is the cheap half of the bill and the
  expensive half of the complexity: if the database also scales to zero, a
  request resumes the app while the database is still cold-starting, and the
  reconnect wrapper needs retry-with-backoff over several seconds instead of
  one immediate retry.
- **Durability is unchanged from today, not improved.** A single node on a Fly
  volume with daily snapshots is exactly the risk profile the SQLite file has
  now; self-hosting moves that risk to a second machine rather than removing
  it. Since votes are the only irreplaceable data — everything else is
  derivable — Phase 5 adds a scheduled `pg_dump` to off-machine storage. That,
  not the migration itself, is what makes the data safer.

**Documented alternatives**, either a contained change (connection string plus
the preview workflow) if the recommendation disappoints:

- **Neon free tier** — genuinely $0 at this app's size: 0.5 GB storage, 100
  compute-hours a month, autosuspend after five minutes, ten branches per
  project. It is the only option that *improves* durability (managed backups,
  point-in-time restore), and its branching is, natively and instantly, the
  feature `main` just built by hand for previews: a copy-on-write copy of
  production's corpus per PR, with no dump, no restore and no seeding step.
  That argument got materially stronger while this plan sat open — see the
  preview bullet in Phase 5, which is the one place self-hosting clearly
  loses something the repo already has. Three costs: an external vendor;
  ~20–30 ms RTT from `arn`, since Stockholm is not a Neon region, which makes
  the batching below mandatory rather than merely wise; and a hard edge where
  exceeding a monthly cap suspends compute until the next billing month, so
  the app stops rather than degrades.
- **Postgres inside the app's own machine**, a second process in the same VM
  over a Unix socket. The cheapest option — no second machine, no second
  volume — and it dissolves the reconnect problem outright, because
  suspend-to-RAM freezes the whole VM, so app and database resume together
  with the socket intact. Against it: the image diverges from a normal
  Postgres deployment in exactly the area this migration is about, the two
  processes share 512 MB, and it gives up most of what a separate database
  server was for. Worth knowing it exists; not what to build first.

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

### Round trips: the write loops that must be batched

This is the one place where a faithful, statement-for-statement port produces
a correct program that is unusably slow, so it is a requirement of the port
rather than a tuning note afterwards.

`rescore_all()` writes one `UPSERT_SCORE` per story in a loop — about 50,000
statements against the real corpus. Against a local file that is the 0.6 s
CLAUDE.md quotes, because a SQLite statement is a function call. Against a
database on the other end of a socket it is 50,000 round trips:

| Deployment | RTT | `rescore_all()` |
|---|---|---|
| SQLite file (today) | — | 0.6 s |
| Postgres, same Fly region | ~0.5 ms | ~25 s |
| Neon from `arn` | ~20 ms | ~17 min |

Even the same-region number is a regression from "runs on a background thread
after every round" to "noticeable". The fix is to stop sending one statement
per row: multi-row `INSERT ... VALUES` in chunks of a few thousand, or `COPY`
into a `TEMP` table plus one `INSERT ... SELECT ... ON CONFLICT`, both of which
collapse the loop to a handful of round trips regardless of distance.

Four sites need it, all already shaped as "loop inside one transaction", so
the change is local to each:

- `rescore_all()` — ~50k upserts, the worst case.
- `score_missing()` — same loop, bounded by a sync's fetch (hundreds).
- `store_held_out()` — one insert per vote on every train.
- the Phase 4 `import-sqlite` tool — every row of every table, once.

Read paths need no equivalent work: the feed, the queue probes and the round
summary are each a handful of statements per request by construction, which is
what the seek-not-scan discipline already bought.

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
API, the typing sweep, the `ORDER BY` tiebreakers, the batched write loops,
`reset_models`' `TRUNCATE ... RESTART IDENTITY`. `trainer.rs`/`syncer.rs`
change only their `open_db` call. The full test suite (`tests/service.rs` is
2,480 lines and covers rounds, flips, queue mix, reset numbering) is the
safety net — it ports in Phase 1 and must pass unmodified in spirit here.
Finish the phase by timing `rescore_all()` against an imported production
snapshot: it is the number that says whether the batching worked, and it
belongs in CLAUDE.md beside the 0.6 s it replaces.

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

**Phase 5 — deploy.** This is the phase self-hosting makes the largest, and
the automation it adds is the honest price of not paying for a managed
cluster:
- **The database app.** A second Fly app (`rekorderlig-db`) from a stock
  `postgres:17-alpine`, one volume at `/var/lib/postgresql/data`, always on,
  no public services — only the private `.internal` address. Its `fly.toml`
  and the one-time `fly volumes create` / role setup are checked in, so the
  machine is reproducible rather than remembered.
- **The app.** `Dockerfile` drops the `apk add sqlite` runtime dependency and
  the `REKORDERLIG_DB` env; the build stays static musl. `fly.toml` loses
  `[mounts]` (after a grace period holding the final SQLite snapshot).
  `DATABASE_URL` goes in via `fly secrets set`.
- **Backups**, the part that has no counterpart today and is the reason
  self-hosting is not free even when the machine is cheap: a scheduled
  `pg_dump -Fc` to storage that is not that volume — a nightly GitHub Actions
  job over `fly proxy` is the least infrastructure, an S3-compatible bucket
  the least coupled. Restore has to be rehearsed once, or it is not a backup.
- **Preview databases — the hardest part, and newly so.** `main` now seeds
  every PR preview from an on-demand **snapshot of the production volume**
  (`fly volumes create --snapshot-id`, cross-app), so a preview opens holding
  the real corpus, votes and models. That trick is available only because the
  whole database is one file on one volume the app mounts: a block copy of a
  live WAL database that SQLite replays on open. Postgres removes both halves
  — the app has no data volume any more, and the data sits on the database
  machine's volume instead. The feature has to be rebuilt, not adapted:
  - *Recommended*: `pg_dump -Fc` production → `pg_restore` into a fresh
    `preview_pr_<n>` on the same database machine, in the deploy job; `DROP
    DATABASE` on close. Tens of seconds for a corpus this size, one machine,
    no per-PR Postgres.
  - *Rejected*: snapshotting the database machine's volume and booting a
    Postgres machine per PR. It is the faithful translation of what `main`
    does and it costs a machine per open PR.
  - Two standing costs either way: CI gains a Postgres credential — scope it
    to a `preview_admin` role owning only `preview_%` databases and unable to
    touch production — and an orphaned database is quieter than an orphaned
    app, so the same job sweeps `preview_pr_%` whose PR is closed.
  - The privacy note `main` already makes stays true and gets sharper: the
    seed is real vote history, and it now lands in a database that shares a
    machine with production.
- **`scripts/pull-prod-db.sh`** rewritten around `pg_dump -Fc` over
  `fly proxy`, keeping the timestamped read-only-snapshot convention.
- **`scripts/push-db-to-preview.sh`** is the reverse trip and is entirely
  SQLite mechanics — `fly sftp put`, `integrity_check`, `mv` over the live
  file, restart the machine because a running SQLite holds the old inode.
  It becomes `pg_restore` into the preview's database; the inode dance and the
  restart disappear, the `*-pr-*` name guard stays.
- **The hourly sync needs no change, but note why.** `sync.yml` is gone;
  `main` runs `rekorderlig sync-remote` from a Fly scheduled machine, and
  `src/sync_remote.rs` speaks only HTTP — it never opens the database, so the
  migration does not touch it. (It exists because a volume attaches to one
  machine and the app holds it. A network database dissolves that constraint,
  so the scheduled machine could eventually run `sync` directly instead of
  poking the app over HTTP. Out of scope here — worth knowing the option
  opens.)

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

- **Suspend/resume vs. connections** (first, because it's the one that will
  actually page someone): the first request after a resume finds three dead
  clients. The reconnect wrapper must be tested deliberately — kill the
  connection under a test server and assert the retry — not discovered in
  production. Verify the idle-timeout behaviour of whatever sits between the
  app and the database, too.
- **We are now the DBA.** Nobody else patches this Postgres, watches its disk
  fill, or notices that the nightly dump has been failing for a month. The
  concrete mitigations are in Phase 5 (checked-in machine config, off-volume
  backups, one rehearsed restore); the residual risk is attention, and it is
  the real price of the cost saving.
- **Determinism regressions** in the seeded queue are silent (a reload
  reshuffles cards). The existing redraw-identity tests in `tests/service.rs`
  are the guard; run them repeatedly (`--test-threads` high) since tie-break
  instability is load-dependent.
- **The typing sweep** is where a mechanical port breaks at runtime rather
  than compile time. Mitigation is coverage: the integration suite exercises
  nearly every query, which is why Phase 1 comes first.
- **Round-trip cost**, if the batching above is skipped or done partially: it
  degrades a background retrain rather than a request, so it will not fail
  loudly — it will just quietly make every round's retrain take a minute.
  Phase 3 ends with the measurement for that reason.

## Out of scope

Connection pooling, multi-instance serving, async, ORMs, a migration
framework, and any schema *redesign* — the schema ports as-is. Each of those
is a separate conversation the moment someone wants it; this migration's
contract is "same app, same behaviour, different engine".
