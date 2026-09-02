# CLAUDE.md

Personal Hacker News recommender: thumb titles up/down, a small logistic
regression learns your taste, the feed reranks. One process; single-user on
the surface, per-user underneath — `docs/multi-user.md` is the plan, and its
phase 1 (the schema) has landed.
README.md is the full product description; this file is orientation for
agents. It states the rules tersely on purpose — the reasoning lives in
`docs/design/` (index at the bottom) and in comments beside the code.

## Shape

- Rust (one binary, `rekorderlig`), synchronous throughout — nothing in this
  crate is `async`. Postgres via the sync `postgres` crate, HTTP server via
  `tiny_http`, HTTP client via `ureq`; the dependency list ends there plus
  serde/url/unicode-normalization (and `bytes`, already in the tree, named
  only so the `User` newtype's hand-written `ToSql` can spell its buffer).
- No frontend build step. `public/` is served as-is (vanilla JS, one `app.js`).
- One Postgres database, reached through `DATABASE_URL`. Schema lives inline
  in `src/db.rs`: `SCHEMA` is the documented, final shape and a fresh
  database gets it directly; an existing one is brought up by `MIGRATIONS`
  (one batch per `meta.schema_version`), applied by `open_db` in one
  transaction under an advisory lock. Two paths, held identical by
  `tests/migration.rs`; a migration once shipped is never edited. **No
  pool**: one connection behind a `Mutex` on the request path, one of its
  own per worker thread — one process; a pool would be three more idle
  sockets and a configuration surface. Every
  connection is a `Db`, which reopens and retries once on a dead socket —
  the Fly machine suspends to RAM, so the first statement after a wake meets
  a socket that died hours ago.

## Where things are

| File | Owns |
|---|---|
| `src/features.rs` | title → named sparse features (`w:rust`, `dom:github.com`). Names are shown back in the UI — never hash them. |
| `src/model.rs` | logistic regression (AdaGrad, L2, class-balanced), score shrinkage toward 0.5, 5-fold CV (`heldOut`, `noise`), `accuracyMove()`. Deterministic: same votes → same weights. |
| `src/http_client.rs` | the one JSON fetch (`Fetch` trait, faked in tests); retry 429/5xx/transport, never a 4xx. |
| `src/hn.rs` | Algolia API: `fetchDay()`/`fetchFrontPage()`/`syncDays()` (the one loop that inserts stories), `fetchStory(id)` for the vote import. |
| `src/firebase.rs` | HN's official item API — repairs days Algolia lost (`backfillDays()`, `idRangeForDay()`). |
| `src/db.rs` | the `Db` wrapper (reconnect-on-dead-socket, transactions), the inline schema and the migration runner, the `User` newtype (a bare `i64` user would compile swapped with a story id), vote/story queries and the per-user round state on `users`. `labelledStories`' ORDER BY decides the whole AdaGrad trajectory — keep it byte-stable. |
| `src/service.rs` | the application: train/score, `sync()`/`backfill()`, `judge()`, the round functions, `feed()`, the two queues, `stats()`, the model cache (one entry per `User`). Everything downstream of a vote takes a `User`; the corpus operations end in `score_missing_all()`. Feed filtering/sorting/paging is done **in SQL** — keep it there. |
| `src/trainer.rs` | background training thread; one run at a time, over a queue of users — a user requested mid-run is queued once, status is the asking user's. |
| `src/version.rs` | which code this is: `APP`, `COMMIT`, `built_at()` — baked in at compile time from Docker build args (a plain `cargo build` is a dev build, not an error). `info()` is the `version` object on `/api/stats`; `describe()` the CLI/boot-log line. |
| `src/syncer.rs` | background fetch thread; one run at a time, a request mid-run is refused as `busy`. |
| `src/sync_remote.rs` | `trigger()` POSTs `/api/sync` on a running instance and polls it to an exit code — the hourly machine's whole job, so the trigger needs no `DATABASE_URL`. |
| `src/server.rs` | routes, optional `AUTH_TOKEN` auth, static files with `ETag`/304 (reasoning commented in place). Every request acts as `User::OWNER` until phase 2 resolves the user from the credential. |
| `src/main.rs` | subcommands: `serve` / `sync` / `sync-remote` / `backfill` (`--dry-run` audits) / `train` / `stats` / `reset-models --yes`. `src/dates.rs`: shared UTC day arithmetic; `src/lib.rs` re-exports so integration tests drive the binary's code. |
| `public/dom.js` | `$`, `el`, `icon`, `api()`. Imports nothing: the bottom of the graph. |
| `public/state.js` | the one state object; a slice per view, `judgedIds` shared by both decks. |
| `public/registry.js` | views `register()` their hooks (`show`, `url`, `adopt`, `stats`, `sync`); router and chrome reach views only through `hook()` — what keeps the graph acyclic. |
| `public/router.js` | paths, `urlFor()`, `navigate()`. Imports no view. |
| `public/chrome.js` | tagline, `refreshStats()`, theme toggle. Reaches the open view through the registry. |
| `public/app.js` | the composition root: imports the views, wires the tab bar and arrow keys, boots. Strips `?token=` only after the cookie provably took. |
| `public/status.js` | the note lines, rendered into the layout — never a floating toast. |
| `public/format.js`, `public/certainty.js`, `public/feed-params.js` | DOM-free helpers: numbers into words; the `CERTAINTY` bands; the feed-URL parser (`FEED_DEFAULTS`, `FEED_PARAM`). |
| `public/reveal.js` | the post-swipe verdict line, shared by both decks. |
| `public/train.js` | the round deck: `loadRound()`, `finishRound()`, the summary. |
| `public/explore.js` | the Explore deck — refills as you judge, not round-shaped. |
| `public/feed.js` | the ranked list; `setFeed()` is the one way a filter moves, `paintFilters()` the one paint path. |
| `public/votes.js` | vote history; held-out score shown only past `CONFLICT_MARGIN`. |
| `public/brain.js` | model panels and charts. Chart bars **navigate** (`/feed?s=70-75`, `/feed?d=…`), never call into the feed. The Data panel ends with `#version-note`, from `version` on `/api/stats`. |
| `scripts/fly-sync-machine.sh` | reconciles the hourly trigger machine — only rebuilds on a real difference, because recreating it moves the schedule. |
| `scripts/pull-prod-db.sh`, `scripts/push-db-to-preview.sh` | prod snapshot out (`pg_dump -Fc`, read-only on purpose); preview refresh in (`pg_restore` + `ANALYZE`, refuses non-`*-pr-*` apps). |
| `scripts/fly-pg-proxy.sh` | the only way to the database from outside 6PN — the front door, not a workaround. |
| `scripts/fly-db-setup.sh`, `scripts/fly-db-secrets.sh` | roles and secrets. Three roles; the preview credentials must not be able to touch production. |

## Rules

Training and scoring:

- **A round boundary is the only retrain trigger.** Voting only records the
  vote; the last card of a round POSTs `/api/train` (202, background thread,
  ~0.8 s full rescore). No per-vote debounce, no manual button — a vote cast
  in Feed, Votes or Explore is trained on when the next round ends.
  `rekorderlig train` covers the rare manual case.
- Rounds are `ROUND_SIZE` (12) cards dealt from one model revision, then one
  retrain. The round in flight lives on the user's row
  (`users.current_round`), never in the browser; progress is a join against `votes`, never a counter; a completed
  round is identified by the `model_rev` it was dealt at — it needs no table.
- **A skip is not a training example**: it spends its slot in the round and
  teaches nothing (`labelledStories` excludes `value = 0`).
- A round summary gates an accuracy move **paired, on the flips**
  (`pairedFlips()`, McNemar) — never on the aggregate; `band` is the
  fallback when there is nothing to pair against. It reports in order of how
  much each number means, not how impressive it looks.
- Scores in `scores` are the *shrunk* display scores, tagged `model_rev`. A
  voted story's stored score only restates the verdict; the honest number is
  the **held-out** one in `oof_scores`, shown only past `CONFLICT_MARGIN`
  (`public/votes.js`). Don't wire that flag back to `scores` — it can never
  fire there.
- `heldOut` stays out of `models.payload` and `/api/stats`: one row per
  vote, and a snapshot per rev would carry the whole vote history each time.
- The training queue is a **stratified sample**, not a ranking: 40%
  boundary / 20% novel / 20% recent / 20% explore, `points >= 10`, drawn by
  seeded probe. Rank on the **unshrunk** score (`RAW_OFFSET`); **seek,
  never scan**. Four planner traps guard the seek, all commented in place:
  `LIMIT`/`OFFSET` written literal (through `int()`), `MIN(id)`/`MAX(id)` as
  two statements, "unjudged" as the `UNJUDGED` anti-join, and `RAW_OFFSET`'s
  `::double precision` casts character-identical to the index's expression.
- Changing the tokenizer **renames features and invalidates every learned
  weight** — cheap only when the votes are about to be rebuilt anyway.
- `models` is **derived data**: `rekorderlig reset-models --yes` deletes
  one user's every revision and a retrain reproduces it; votes and
  `vote_predictions` are the record. `rev` is **per user and dense** —
  allocated as that user's `MAX(rev) + 1` inside the INSERT, no sequence —
  so a reset restarts at 1 and the learning curve counts. Append-only, ~124
  KB/rev per user; pruning is `DELETE FROM models WHERE user_id = U AND rev
  <= N` and nothing else needs touching.
- **Everything downstream of a vote is one user's**: `votes`, `scores`,
  `oof_*`, `vote_predictions`, `models`, the round. The corpus (`stories`,
  sync, `last_sync_at`) is shared. Three places that are not mechanical:
  a `LEFT JOIN` on `scores` or `votes` scopes the user **in its `ON`
  clause** (in the `WHERE` it becomes an inner join and Explore loses its
  unscored stories; left out, every story joins one row per user);
  `UNJUDGED` names the user (or one skip hides a story from every deck); a
  seek on `scores` starts `WHERE sc.user_id = ?` because the expression
  indexes lead with `user_id`. `sync()`/`backfill()` score for **every**
  user with a model (`score_missing_all`) — there is no caller whose feed
  is the one that matters.
- Reposts are **not** special-cased anywhere. A vote binds to the submission
  it was cast on. Don't reintroduce URL dedup.

Judging UI:

- A card never shows its score, in either deck; the trainer card shows
  **only what the model can see** (title, domain). Explore's card is the
  deliberate exception — there the traction *is* the offer.
- The reveal comes **after** the swipe (`vote_predictions` freezes the
  genuine pre-vote guess), names both parties and keeps the halves symmetric
  (`=`/`≠`, never "you agreed"); the percentage is confidence in the call
  made, not P(yes).
- Certainty is worded and coloured on the `CERTAINTY` bands
  (`public/certainty.js`); a new band needs its `.verdict.sure-<name>`
  colour — `tests/styles.test.mjs` holds the two files to that.
- The feed never shows unscored stories; Explore does (crowd order needs no
  model to be true).
- Explore is a second judging deck, **not** a second feed: same
  `POST /api/vote`, different selection. The numbers in `EXPLORE` are the
  whole contract; not round-shaped, triggers no retrain.

Front end:

- **One module per view, and views never import each other.** Cross-view
  reach goes through `registry.js` hooks; `tests/modules.test.mjs` fails a
  cycle, a view importing a view, and a leaf growing a dependency.
- **The feed's filters live in the GET parameters** — a filtered feed is a
  bookmarkable place. `setFeed()` is the one mutation, `paintFilters()` the
  one paint path. One letter per filter, only non-defaults written; `s` and
  `d` each carry two shapes (floor/bucket, window/dated day) and a third
  claimant gets neither letter; panel controls `replaceState`, chart
  drill-downs push; a band restores only what identifies it.

Data:

- `sync()` is the one way stories routinely enter: fetch + `scoreMissing()`
  + the `last_sync_at` stamp. Never fetch without scoring — an unscored
  story is invisible to the feed. `backfill()` pointedly does **not** stamp
  `last_sync_at`.
- Routine fetching has exactly one path: today and a year of history are the
  same `syncDays()` walk; no day is skipped for looking covered. Don't split
  it back into a rolling job and an archive job.
- Repair (`rekorderlig backfill`, Firebase) is a second *source*, never a
  timer, an endpoint or part of `sync()`; `--dry-run` is the audit. It is
  deliberately not wired into `fetchStory()`.
- `POST /api/import/vote` is the only import path; the story is always
  fetched from HN, never stubbed from the request. Retrain once, after the
  import.
- Handlers return `Err(http_error(status, msg))` for deliberate 4xx;
  anything else becomes a per-request 500. Nothing may escape a handler and
  kill the worker.
- Prefer small, named features and comments that state *why* a number is
  what it is.

## Testing

`cargo test`, plus `node --test tests/*.test.mjs` — CI runs both.

The Rust tests need a Postgres server: `docker compose up -d`, or point
`REKORDERLIG_TEST_PG` at one (host and port only). `TempDb` creates and drops
a database per test; there is deliberately no skip-if-no-server path.
`tests/reconnect.rs` kills the connection on purpose — the Fly-suspend case;
the retry rule it found is commented at `is_disconnect` in `src/db.rs`.
`tests/migration.rs` builds a version-0 database from the frozen pre-users
schema, opens it, and asserts its catalogs are identical to a fresh one —
the test that lets `SCHEMA` and `MIGRATIONS` be two paths. `tests/users.rs`
is the second user in the room: every isolation bug passes with one.

The front end is tested by **running it** against `tests/helpers/dom.mjs`, a
DOM stub (no layout, no CSS, no bubbling — assertions needing those don't
belong in it). One `mount()` per file; boot scenarios get their own files.
`styles.test.mjs` holds the only text assertions, for cross-file invariants
nothing at runtime notices breaking; never assert on source text elsewhere
(`docs/design/frontend.md` says why).

## Deploy

Fly.io: pushes to `main` deploy; every PR gets a preview app
(`.github/workflows/preview.yml`). Both deploys pass `GIT_SHA`/`BUILD_TIME`
build args so the binary knows which commit it is (`src/version.rs`); the
answer shows on Brain's Data panel, the boot log, and `GET /api/stats`.

- **Two apps, exactly one app machine** (`--ha=false` — a second machine
  breaks "one sync at a time"). `rekorderlig` holds no data;
  `rekorderlig-db` (`fly.db.toml`) is stock `postgres:17-alpine` on a
  volume, publishing no services: 6PN only, `fly proxy` from outside. No TLS
  on that connection — 6PN encrypts; `connect()` in `src/db.rs` is where
  that changes if it ever must.
- App machines **suspend** when idle; nothing in-process fetches on a timer.
  Freshness is the hourly Fly scheduled machine running
  `rekorderlig sync-remote`, reconciled by `scripts/fly-sync-machine.sh`
  after each deploy — its schedule is anchored at machine creation, so don't
  recreate it casually. Failures show in `fly logs`, `lastError` on
  `GET /api/sync`, and the Brain tab — not in Actions.
- **Backups**: nightly `pg_dump -Fc` workflow artifact, 90 days
  (`.github/workflows/backup.yml`). Rehearse a restore quarterly; the
  workflow header says how.
- Previews get `preview_pr_<n>` on the same database machine, seeded from a
  prod dump, then `ANALYZE` (without statistics the queue seq-scans per
  card). The close job drops it and sweeps orphans. The preview credentials
  (`preview_reader`, `preview_admin`) cannot touch production — keep it that
  way; a reader's grant must cover tables **and sequences**, or `pg_dump`
  dies on `models_rev_seq`.

## Workflow

Agents never commit to `main`. Work on a feature branch in a git worktree and
open a PR for human review; the PR gets a Fly preview app automatically.

**No scheduled PR check-ins.** After opening or pushing to a PR, do not
create routines, reminders or `send_later` wake-ups to re-check it hourly
(or on any interval): a session woken every hour with nothing to do is an
interruption, not diligence. Subscribing to PR events is fine; polling is
not.

## Design notes

The arguments behind the rules live in `docs/design/`, one file per topic.
Working in an area? Read its file first — if a rule above looks wrong or
arbitrary, the case for it is there.

| File | Covers |
|---|---|
| `docs/design/queue.md` | the stratified sample; seek-never-scan and the planner traps |
| `docs/design/rounds.md` | why rounds exist, where they live, how a summary gates an accuracy move |
| `docs/design/judging.md` | what a card may show, the reveal's wording, certainty bands, held-out scores |
| `docs/design/feed-url.md` | the feed's URL contract, letter by letter |
| `docs/design/frontend.md` | the module graph, the registry, testing by running, never asserting on source text |
| `docs/design/sources.md` | Algolia vs Firebase, one sync path, repair, vote import |
| `docs/design/models.md` | derived data, the 2026-08-29 pruning, tokenizer edges, reposts |
| `docs/design/deploy.md` | two apps, backups, previews, the sync trigger's three properties |

`docs/multi-user.md` is the multi-user plan: what a user is, the schema,
the four phases. Phase 1 (the schema, the `User` threading, the migration
runner) is in; the app still acts as user 1 until phase 2.

`docs/postgres-migration.md` is the SQLite → Postgres migration plan as
executed — the record of a finished change, not a live topic, but read its
"what the plan did not predict" list before touching the database layer.

## Keeping this file current

When you change something this file describes — file responsibilities, the
retrain/scoring flow, rules, test setup, deploy — update CLAUDE.md in the
same change, and the matching `docs/design/` file with it. New rules state
themselves here in a line or two; if the justification needs more than that,
it goes in `docs/design/` (or a comment beside the code) and only the rule
stays here.
