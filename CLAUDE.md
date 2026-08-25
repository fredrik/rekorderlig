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
| `src/hn.js` | Algolia HN API. `fetchDay()`/`fetchFrontPage()` + `syncDays(conn, days, opts)`, the one loop that puts stories in the database — per-day transaction, failures recorded and stepped over, days already holding `minStories` skipped unless inside the `HOT_DAYS` window. Pure fetch + `upsertStory`; no meta, no scoring. |
| `src/db.js` | schema, `db()` singleton, `openDb(path)` for tests, vote/story queries. |
| `src/service.js` | `trainAndScore()` (train → store snapshot → `rescoreAll()` the corpus) and `scoreMissing()` (score only stories the current model rev hasn't seen — used after a sync, no retrain). `sync()` (the one way stories enter the database: `{days}` or `{from,to}` → `syncDays()` + front page when today is in range + `scoreMissing()` + the `last_sync_at` stamp — never fetch without it, an unscored story is invisible to the feed). Also `feed()`, `trainingQueue()`, `voteLog()` (the Votes view's history list), `explain()`, `stats()` (which embeds `scoreDistribution()`: the unvoted-corpus histogram shown in Brain, binned in SQL over the stored score). Holds the module-level model cache (`resetModelCache()` in tests). Feed filtering/sorting/paging is done **in SQL** — keep it there. `feed()` takes `minScore`/`maxScore` (exclusive) so a histogram bar in Brain can open exactly its bucket. |
| `src/trainer.js` | background training: `requestTrain()` spawns `train-worker.js` in a worker thread on its own DB connection; one run at a time, a trigger mid-run coalesces into a single follow-up run. `trainStatus()`, `trainingIdle()` (tests). |
| `src/syncer.js` | background fetching: `requestSync(opts)` spawns `sync-worker.js` in a worker thread on its own DB connection; one run at a time, a request mid-run is refused as `busy` (options can't be coalesced). `syncStatus()` streams the current day, `syncIdle()` (tests). |
| `src/server.js` | routes table, optional `AUTH_TOKEN` auth, static files. Nothing fetches on a timer — `POST /api/sync` (202) is the only trigger, driven by cron or the Brain tab. |
| `src/cli.js` | `sync` / `train` / `stats`. Flags: run with an unknown command (e.g. `node src/cli.js help`) to get the usage line. |
| `public/app.js` | the whole front end: Train, Feed, Votes, Brain views. |

## Conventions

- Everything is synchronous around SQLite. Voting only records the vote; the
  client debounces a burst of votes into one `POST /api/train`, which returns
  202 immediately and runs `trainAndScore()` in a worker thread (`trainer.js`)
  on its own DB connection, so the request path never blocks on a rescore of a
  ~70k-story corpus. Bulk import triggers a retrain server-side.
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
  `syncDays()` walk over a different list of days, and the hot-day rule is what
  keeps recent days honest. Don't split it back into a rolling job and an
  archive job — that split is what this replaced.
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
