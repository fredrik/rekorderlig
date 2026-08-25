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
| `src/hn.js` | Algolia HN API ingest and backfill. Pure fetch + `upsertStory`. |
| `src/db.js` | schema, `db()` singleton, `openDb(path)` for tests, vote/story queries. |
| `src/service.js` | train → store snapshot → rescore corpus; `feed()`, `trainingQueue()`, `explain()`, `stats()`. Feed filtering/sorting/paging is done **in SQL** — keep it there. |
| `src/server.js` | routes table, optional `AUTH_TOKEN` auth, static files, auto-refresh. |
| `src/cli.js` | `ingest` / `backfill` / `train` / `stats`. |
| `public/app.js` | the whole front end: Train, Feed, Brain views. |

## Conventions

- Everything is synchronous around SQLite; training runs inside the request that
  cast the vote. Keep per-vote work bounded — the corpus can be ~70k stories after
  a backfill.
- Scores stored in `scores` are the *shrunk* display scores, tagged with `model_rev`.
- Reposts: votes propagate to same-URL twins (`db.js`), training dedupes by title
  (`service.js`), the queue dedupes by both.
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
