# CLAUDE.md

Personal Hacker News recommender: thumb titles up/down, a small logistic
regression learns your taste, the feed reranks. One process, a handful of
users, each signed in with a login link. README.md is the product; this
file is orientation for agents. Rules are stated tersely — the reasoning is
in the `docs/design/` file named beside each section, and in comments
beside the code. Working in an area? Read its doc first.

## Shape

- Rust, one binary (`rekorderlig`), synchronous throughout. `postgres`,
  `tiny_http`, `ureq`, serde, url, unicode-normalization — the dependency
  list ends there.
- One Postgres database via `DATABASE_URL`. Schema inline in `src/db.rs`:
  `SCHEMA` for a fresh database, `MIGRATIONS` for an existing one, held
  identical by `tests/migration.rs`; a shipped migration is never edited.
  No pool: one connection behind a `Mutex` on the request path, one per
  worker thread, each a `Db` that reconnects once on a dead socket (the Fly
  machine suspends). `docs/postgres-migration.md` is the record of the
  SQLite → Postgres move; read its "what the plan did not predict" list
  before touching the database layer.
- Front end: vanilla ES modules in `public/`, no build step in development.
  The image alone bundles them (`scripts/bundle-frontend.sh`); the bundle is
  never committed.
- Every file's header comment says what it owns. Read that, not this file,
  for what a file does.

## Rules

Training and scoring — `docs/design/rounds.md`, `queue.md`, `models.md`:

- A round boundary is the only retrain trigger. Voting records the vote; the
  last card of a round POSTs `/api/train`. `rekorderlig train` is the manual case.
- A round is `ROUND_SIZE` cards from one model revision. It lives on the
  user's row, progress is a join against `votes`, and a skip teaches nothing.
- A round summary gates an accuracy move paired, on the flips
  (`paired_flips()`, McNemar), never on the aggregate.
- `scores` holds shrunk display scores; the honest number for a voted story
  is the held-out one in `oof_scores`. `heldOut` stays out of
  `models.payload` and `/api/stats`.
- The queue is a stratified sample, ranked on the unshrunk score; seek,
  never scan. The four planner traps are commented in place.
- `models` is derived data (`reset-models --yes` and a retrain reproduce
  it); `rev` is per user and dense. The learning curve is read from columns
  on `models`, never from the payload.
- Changing the tokenizer renames every feature and invalidates every weight.
- Reposts are not special-cased. Don't reintroduce URL dedup.

Users and access — `docs/multi-user.md` (plan and record; phases 1–3, 5, 6
are in), `docs/design/email.md` (mailing a link, not yet built):

- A user is a row; a credential is a session. Tables hold `sha256(token)`,
  never the token. No passwords. The CLI addresses a user by id or email,
  never by display name.
- An invite is a row that does not know who will open it. `POST
  /invite/<token>` is the one route that mints a user without the operator.
  Voiding is `revoked_at`; a row with a user behind it is never deleted.
- Any user may invite a friend; they see and void only their own
  (`invited_by` in every predicate), capped by `INVITES_OUTSTANDING_MAX`.
  The cap comes back with the rows, one shape, one paint.
- A door opens on a POST, never a GET. A GET at `/login?t=` or
  `/invite/<token>` only peeks and shows `doorstep.html`; chat previewers
  fetch URLs but never submit forms.
- Being turned away is a page: `signed-out.html` under a 401, naming both
  ways in. `PUBLIC_FILES` is the one file it may load. `/api/` still
  answers the JSON 401.
- The operator is not a user: `AUTH_TOKEN` as a Bearer gets 403 on every
  user route. With it unset, anonymous is user 1.
- Everything downstream of a vote is one user's; the corpus is shared.
  Scope `LEFT JOIN`s in the `ON` clause, name the user in `UNJUDGED`, start
  a `scores` seek with `user_id`. Sync and backfill score for every user.
- Previews scrub `users.email`, `sessions`, `login_links` and `invites`.

Judging — `docs/design/judging.md`:

- A card never shows its score; the trainer card shows only what the model
  sees. Explore is the exception, and is a second judging deck, not a second
  feed. The feed never shows unscored stories.
- The reveal comes after the swipe, from the frozen `vote_predictions`
  guess, with symmetric halves. Certainty follows the `CERTAINTY` bands.

Front end — `docs/design/frontend.md`, `feed-url.md`:

- One voice: the reader is *you*; the model is Brain. Anything standing
  alone on screen is a sentence.
- One module per view; views never import each other. Cross-view reach goes
  through `registry.js`; `tests/modules.test.mjs` enforces the graph.
- The welcome flow is a view entered from a fact (`displayName` null), not a
  URL; `onboardingRoute()` decides once, at boot.
- The feed's filters live in the GET parameters: `setFeed()` is the one
  mutation, `paintFilters()` the one paint path.

Data — `docs/design/sources.md`:

- `sync()` is the one routine way stories enter: fetch, score, stamp
  `last_sync_at`. Never fetch without scoring. One `syncDays()` walk for
  today and history alike.
- Nothing in the app fetches; `POST /api/sync` is for the hourly machine.
  Repair (`backfill`, Firebase) is a second source, never a timer or part
  of `sync()`. `POST /api/import/vote` is the only import path.
- Handlers return `Err(http_error(status, msg))` for a deliberate 4xx;
  nothing may escape a handler and kill the worker. Everything after URL
  parsing runs under the one `catch_unwind` in `handle()`, the doors and the
  session lookup included; a worker that dies anyway exits the process.
- `/healthz` is Fly's check (`docs/design/deploy.md`): one `SELECT 1` on its
  own connection, no session, 503 when the database is away. `Db::reconnect`
  is fallible and every connect has a timeout, so an outage is 500s, never
  panics and never a hang.
- Prefer small, named features and comments that say *why* a number is what
  it is.

## Testing

`cargo test` and `node --test tests/*.test.mjs`, both run by
`.github/workflows/tests.yml` — the one job `CI` and `Deploy` call. The
Rust tests need Postgres (`docker compose up -d` or `REKORDERLIG_TEST_PG`).
The front end is tested by running it, never by reading its source.
`docs/design/testing.md` says what each file checks.

## Deploy

Fly.io — `docs/design/deploy.md`. Pushes to `main` deploy behind the test
job; every PR gets an ungated preview seeded from a scrubbed prod dump.
Two apps, exactly one app machine; the database is 6PN-only, reached by
`scripts/fly-pg-proxy.sh`. Machines suspend, so freshness is the hourly
`sync-remote` machine reconciled by `scripts/fly-sync-machine.sh` — don't
recreate it casually. Nightly `pg_dump` backups in `backup.yml`, encrypted
with `age` because the artifact is public; the private key is never in GitHub.

## Workflow

Agents never commit to `main`: feature branch in a worktree, PR for human
review. No scheduled PR check-ins — subscribe to events, don't poll.

## Keeping this file current

A file's responsibilities live in its header comment, not here. When a rule
above changes, update this file and the matching `docs/design/` file in
the same change. A new rule is a line here; its justification goes in
`docs/design/`.
