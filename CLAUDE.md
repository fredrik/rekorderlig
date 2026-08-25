# CLAUDE.md

Personal Hacker News recommender: thumb titles up/down, a small logistic
regression learns your taste, the feed reranks. Single user, single process.
README.md is the full product description; this file is orientation for agents.

## Shape

- Node 24+, ESM, **zero npm dependencies**. SQLite via `node:sqlite`, HTTP via `node:http`.
- No build step. `public/` is served as-is (vanilla JS, one `app.js`).
- One SQLite file (`data/rekorderlig.db`, WAL). Schema lives inline in `src/db.js`;
  there is no migration system — only `CREATE ... IF NOT EXISTS`.

## Where things are

| File | Owns |
|---|---|
| `src/features.js` | title → named sparse features. Names are human-readable on purpose (`w:rust`, `dom:github.com`) — never hash them, the UI shows them back. |
| `src/model.js` | logistic regression (AdaGrad, L2, class-balanced), score shrinkage toward 0.5, 5-fold CV, insights. Deterministic: same votes → same weights. |
| `src/hn.js` | Algolia HN API. `fetchDay()`/`fetchFrontPage()` + `syncDays(conn, days, opts)`, the one loop that puts stories in the database — per-day transaction, failures recorded and stepped over, every day handed in always fetched (there is no skip rule — a covered-looking day is refetched, upserts make that cheap in the database). Pure fetch + `upsertStory`; no meta, no scoring. `fetchStory(id)` looks up one submission (used by the vote import). |
| `src/db.js` | schema, `db()` singleton, `openDb(path)` for tests, vote/story queries. `recordVote` stamps now and keeps the original `created_at`; `importVote` lets a restored history's timestamp win, for `updated_at` too — the Votes view reads `updated_at`, so a restore must not read as "voted a minute ago". |
| `src/service.js` | `trainAndScore()` (train → store snapshot → `rescoreAll()` the corpus) and `scoreMissing()` (score only stories the current model rev hasn't seen — used after a sync, no retrain). `sync()` (the one way stories enter the database: `{days}` or `{from,to}` → `syncDays()` + front page when today is in range + `scoreMissing()` + the `last_sync_at` stamp — never fetch without it, an unscored story is invisible to the feed). Also `feed()`, `trainingQueue()`, `voteLog()` (the Votes view's history list), `explain()`, `stats()` (which embeds `scoreDistribution()`: the unvoted-corpus histogram shown in Brain, binned in SQL over the stored score). Holds the module-level model cache (`resetModelCache()` in tests). Feed filtering/sorting/paging is done **in SQL** — keep it there. `feed()` takes `minScore`/`maxScore` (exclusive) so a histogram bar in Brain can open exactly its bucket. |
| `src/trainer.js` | background training: `requestTrain()` spawns `train-worker.js` in a worker thread on its own DB connection; one run at a time, a trigger mid-run coalesces into a single follow-up run. `trainStatus()`, `trainingIdle()` (tests). |
| `src/syncer.js` | background fetching: `requestSync(opts)` spawns `sync-worker.js` in a worker thread on its own DB connection; one run at a time, a request mid-run is refused as `busy` (options can't be coalesced). `syncStatus()` streams the current day, `syncIdle()` (tests). |
| `src/server.js` | routes table, optional `AUTH_TOKEN` auth, static files. Nothing fetches on a timer — `POST /api/sync` (202) is the only trigger, driven by cron or the Brain tab. |
| `src/cli.js` | `sync` / `train` / `stats`. Flags: run with an unknown command (e.g. `node src/cli.js help`) to get the usage line. |
| `public/app.js` | the whole front end: Train, Feed, Votes, Brain views. |
| `scripts/pull-prod-db.sh` | copies the production database into `data/`: wakes the machine, `VACUUM INTO` over `node:sqlite` (the image has no `sqlite3`), `fly sftp get`, then removes the temp copy from the volume. The local copy is read-only on purpose — it is a snapshot, copy it before using it as a working database. |

## Conventions

- Everything is synchronous around SQLite. Voting only records the vote; the
  client debounces a burst of votes into one `POST /api/train`, which returns
  202 immediately and runs `trainAndScore()` in a worker thread (`trainer.js`)
  on its own DB connection, so the request path never blocks on a rescore of a
  ~70k-story corpus.
- `POST /api/import/vote` restores one historical vote (`story_id`, `value`,
  `created_at`) and is the only import path — there is no bulk import. A story
  id the corpus never fetched is looked up on HN (`fetchStory`) and inserted;
  it is never stubbed from the request, so the title the model trains on is
  always HN's. The response echoes the stored story back so each vote can be
  verified as it lands, and no retrain is triggered per vote — call
  `POST /api/train` once the import is done.
- Scores stored in `scores` are the *shrunk* display scores, tagged with `model_rev`.
- The feed never shows unscored stories (`sc.score IS NOT NULL`) — before the first
  model it is empty by design. Unscored is transient otherwise: `sync()` scores
  what it fetched before it returns.
- Reposts are **not** special-cased anywhere. A vote binds to the submission it
  was cast on, every vote is one training example, and a duplicate submission is
  just another title to judge. The model reads titles, so a twin's differently
  worded title was never something you judged — deduping by URL would have put
  words in your mouth. Don't reintroduce it.
- Fetching has exactly one path: today and a year of history are the same
  `syncDays()` walk over a different list of days — the only difference is the
  list. Every day in that list is fetched; nothing is skipped for looking
  covered already, so recent days stay honest at the cost of requests. Don't
  split it back into a rolling job and an archive job — that split is what this
  replaced. (A `sync_days` ledger of completed days would make a backfill
  resumable again; that is the intended successor, not a second code path.)
- Handlers throw `httpError(status, msg)`; anything else becomes a 500. Nothing may
  escape the request handler — an unhandled rejection kills the process.
- Prefer small, named features and comments that state *why* a number is what it is.

## Testing

`npm test` (`node --test`). Tests use temp DBs next to the test files and set
`REKORDERLIG_DB` / `NODE_ENV=test` *before* importing `server.js` (module-level
singletons). Add a test with every behavioural change; the API tests are cheap.

## Deploy

Fly.io (`Dockerfile`, `fly.toml`): pushes to `main` deploy; every PR gets a
preview app (`.github/workflows/preview.yml`). Data on a 1 GB volume at `/data`.

Machines **suspend** to RAM when idle (`fly.toml`), so the process is frozen
between visits. Nothing in-process fetches on a timer (there is no
`REFRESH_HOURS` any more — a timer that only ticks while awake was never a
freshness guarantee). Keeping the corpus fresh is external: cron POSTs
`/api/sync`, which also wakes the machine. The PR preview workflow seeds a
fresh volume the same way, right after deploy.

## Workflow

Agents never commit to `main`. Work on a feature branch in a git worktree and
open a PR for human review; the PR gets a Fly preview app automatically.

## Keeping this file current

When you change something this file describes — file responsibilities, the
retrain/scoring flow, conventions, test setup, deploy — update CLAUDE.md in the
same change.
