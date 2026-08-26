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
| `src/model.js` | logistic regression (AdaGrad, L2, class-balanced), score shrinkage toward 0.5, 5-fold CV, insights. `crossValidate()` also reports `foldAccuracy` and `noise` — the band an accuracy move must clear before it means anything, being the larger of the fold spread and an Agresti-Coull standard error. Deterministic: same votes → same weights. `crossValidate()` also returns `heldOut` — the per-example out-of-fold score, keyed by the `id` the caller attached — instead of only aggregating it into accuracy/AUC. |
| `src/hn.js` | Algolia HN API. `fetchDay()`/`fetchFrontPage()` + `syncDays(conn, days, opts)`, the one loop that puts stories in the database — per-day transaction, failures recorded and stepped over, every day handed in always fetched (there is no skip rule — a covered-looking day is refetched, upserts make that cheap in the database). Pure fetch + `upsertStory`; no meta, no scoring. `fetchStory(id)` looks up one submission (used by the vote import). |
| `src/db.js` | schema (incl. `oof_scores`, the held-out prediction per vote, `vote_predictions`, the frozen pre-vote guess, and the two expression indexes the training queue seeks on), `db()` singleton, `openDb(path)` for tests, vote/story queries. `recordVote` stamps now and keeps the original `created_at`; `importVote` lets a restored history's timestamp win, for `updated_at` too — the Votes view reads `updated_at`, so a restore must not read as "voted a minute ago". |
| `src/service.js` | `trainAndScore()` (train → store snapshot → `rescoreAll()` the corpus) and `scoreMissing()` (score only stories the current model rev hasn't seen — used after a sync, no retrain). `sync()` (the one way stories enter the database: `{days}` or `{from,to}` → `syncDays()` + front page when today is in range + `scoreMissing()` + the `last_sync_at` stamp — never fetch without it, an unscored story is invisible to the feed). `storeHeldOut()` rewrites `oof_scores` whole on every train, so a deleted vote leaves no stale row. `judge()` (capture the prediction, record the vote, report the signals it teaches) and `modelHistory()` (the learning curve: accuracy per *training run*, read out of the stored payloads with `json_extract`; revisions that added no votes are dropped, since a no-op retrain is the same model again and the pre-round table is mostly those) . Also `feed()`, `trainingQueue()` (see below), `voteLog()` (the Votes view's history list, which serves `oof_score` beside the stored one), `explain()`, `stats()` (which embeds `scoreDistribution()`: the unvoted-corpus histogram shown in Brain, binned in SQL over the stored score). Holds the module-level model cache (`resetModelCache()` in tests). Feed filtering/sorting/paging is done **in SQL** — keep it there. `feed()` takes `minScore`/`maxScore` (exclusive) so a histogram bar in Brain can open exactly its bucket. |
| `src/trainer.js` | background training: `requestTrain()` spawns `train-worker.js` in a worker thread on its own DB connection; one run at a time, a trigger mid-run coalesces into a single follow-up run. `trainStatus()`, `trainingIdle()` (tests). |
| `src/syncer.js` | background fetching: `requestSync(opts)` spawns `sync-worker.js` in a worker thread on its own DB connection; one run at a time, a request mid-run is refused as `busy` (options can't be coalesced). `syncStatus()` streams the current day, `syncIdle()` (tests). |
| `src/server.js` | routes table, optional `AUTH_TOKEN` auth, static files. Nothing fetches on a timer — `POST /api/sync` (202) is the only trigger, driven by cron or the Brain tab. |
| `src/cli.js` | `sync` / `train` / `stats`. Flags: run with an unknown command (e.g. `node src/cli.js help`) to get the usage line. |
| `public/app.js` | the whole front end: Train, Feed, Votes, Brain views. Status is rendered **into the layout** (`#train-status`, `#feed-note`, `#votes-note`, `#data-note`), never as a floating toast — there is no `toast()` any more. |
| `scripts/pull-prod-db.sh` | copies the production database into `data/`: wakes the machine, `VACUUM INTO` over `node:sqlite` (the image has no `sqlite3`), `fly sftp get`, then removes the temp copy from the volume. The local copy is read-only on purpose — it is a snapshot, copy it before using it as a working database. |

## Conventions

- Everything is synchronous around SQLite. Voting only records the vote; the
  client debounces a burst of votes into one `POST /api/train`, which returns
  202 immediately and runs `trainAndScore()` in a worker thread (`trainer.js`)
  on its own DB connection, so the request path never blocks on a rescore of a
  ~70k-story corpus. Retraining is **vote-driven only** — there is no manual
  retrain in the UI. A button that retrained on demand invited a rescore that
  no new evidence justified, and it would split a training round across two
  model revisions. `node src/cli.js train` is still there for the rare case.
- `POST /api/import/vote` restores one historical vote (`story_id`, `value`,
  `created_at`) and is the only import path — there is no bulk import. A story
  id the corpus never fetched is looked up on HN (`fetchStory`) and inserted;
  it is never stubbed from the request, so the title the model trains on is
  always HN's. The response echoes the stored story back so each vote can be
  verified as it lands, and no retrain is triggered per vote — call
  `POST /api/train` once the import is done.
- Scores stored in `scores` are the *shrunk* display scores, tagged with `model_rev`.
- A voted story's stored score says nothing. The trained model separates its own
  training set perfectly (every yes ~0.99, every no ~0.00), so on the Votes view
  that number only restates the verdict badge. The honest one is the **held-out**
  score in `oof_scores`: what the model said while trained on a fold that
  excluded that vote. The Votes view shows it only when it contradicts the
  verdict (`CONFLICT_MARGIN` in `public/app.js`) — ~9% of votes, the titles your
  other votes argue against. Don't wire that flag back to `scores`; it can never
  fire there. The held-out score is stale between trains by construction.
- `heldOut` stays out of `models.payload` and out of `/api/stats`: it is one row
  per vote, and a snapshot per rev would carry the whole vote history each time.
- The feed never shows unscored stories (`sc.score IS NOT NULL`) — before the first
  model it is empty by design. Unscored is transient otherwise: `sync()` scores
  what it fetched before it returns.
- **A skip is not a training example**, so it must not trigger a retrain.
  `labelledStories` excludes `value = 0`, so retraining after a skip produces
  an identical model, pays a full corpus rescore for it, and used to announce
  "Learned · 64% accurate" about a story you declined to judge. The client
  triggers a retrain only when the training set actually changed (in the Votes
  view: when a real verdict is on either side of the change).
- The trainer card shows **only what the model can see**: title and domain.
  `featurize()` reads title words, bigrams, style flags, domain, tld and
  author — points, comments and age are not features, so displaying them
  contaminates the label. A yes swayed by "98 comments" reaches the model
  attached to the story's *words*, because that is all it has, and lands as
  noise in the title weights. (Comment counts are frozen at fetch time too, so
  they describe when the sync ran, not the story.) The rule is one-directional:
  showing a non-feature corrupts labels, but training on something unshown —
  author — is just learning. Selection is exempt: the `points >= 10` floor and
  `recent`'s comment ranking choose which stories you are asked about, and the
  model is never asked to explain them.
- The trainer reveals the model's guess **after** the swipe, never before.
  `vote_predictions` freezes what the model said at the instant of judging —
  the vote did not exist yet, so it is a genuine out-of-sample call, unlike the
  `scores` row, which the next retrain memorises. That capture is what makes
  "Called it" honest, and it is why `judge()` captures before it records.
  Undoing a vote drops its prediction with it. Beside the guess, the reveal
  says what the vote *gives* the model — the features of that title it had
  never seen (`newSignals()`), which is what the next retrain learns from it.
  That number is the feedback, not a rolling hit rate: the queue's `boundary`
  stratum deliberately serves the cards the model is least sure about, so its
  hit rate on them is pinned near chance by construction and can never read as
  progress. Signals learned only ever climbs, and every vote moves it. Placement is deliberate: the
  verdict lands **below** the vote buttons with the judged title beside it
  (card and buttons are one cluster — nothing goes between them), while a
  retrain reports itself in the **header line**, because it is news about the
  model rather than about the swipe and must not overwrite what you just
  judged. Every reveal names both parties and keeps the halves symmetric
  ("Brain guessed no (62% certain) — you said yes."): never "you agreed", which casts
  the model as the reference and the vote as the thing falling in line — the
  vote is the truth, the guess is a guess. The glyph is `=` / `≠` for the same
  reason: the line compares two verdicts, where a tick and a cross would grade
  the vote against the guess. ("Got that one wrong" had the same
  fault in reverse: it never said whose mistake it was.) The percentage
  is the confidence in the call the model actually made, not P(yes) — beside
  "guessed no" the raw score reads as its own opposite.
- The training queue is a **stratified sample**, not a ranking: 40% `boundary`
  (near the decision line), 20% `novel` (no vocabulary yet), 20% `recent`
  (last 3 days, most discussed), 20% `explore` (uniform over the whole
  archive), round-robined so no stratum arrives in a block. Only stories with
  `points >= 10` are offered — HN's long tail is most of an archive and none
  of it is worth a swipe. Two rules keep it honest at multi-year scale:
  - Rank on the **unshrunk** score. `scores.score` is pulled toward 0.5 by
    confidence, so `|score - 0.5|` sorts by ignorance, not uncertainty; the
    boundary stratum undoes the shrinkage (`RAW_OFFSET`) and `novel` is where
    low confidence gets its own, budgeted slots.
  - **Seek, never scan.** Every stratum draws by seeded probe — pick a random
    key, seek the first unjudged story past it — so a deck costs ~40 index
    seeks whether the corpus holds 10k stories or 10M (measured: 3.6 ms over a
    million). Two SQLite traps make or break that, and both are commented in
    place: `LIMIT`/`OFFSET` must be **written into the SQL, never bound** (a
    bound limit stops the planner bounding the sorter: 21 ms vs 0.4 ms), and
    `MIN(id)`/`MAX(id)` must be **two statements** (asking for both at once
    scans the table). Interpolated numbers go through `int()`.
  Decks are **small on purpose** — the client asks for a random 8–16 and
  refills with 3 cards still in hand. A large deck's tail was chosen by a
  model many votes out of date, which mattered little when the queue was a
  ranking and matters a lot now that it samples around a moving boundary.
  Quotas are allocated by largest remainder (`allocate()`) so they sum to
  exactly the limit: rounding each share alone overshot, and truncating the
  overshoot flattened 40/20/20/20 into an even split at deck sizes this small.
  The draw is seeded on `model_rev` + `cursor` (the round's sequence number),
  so a round redraws identically on a reload, and two rounds sharing a
  revision — a round of nothing but skips triggers no retrain — still differ.
  `mix` in the `/api/queue` response counts the strata; the trainer card itself
  still says nothing about why a story was picked, because a visible reason
  anchors the vote it is trying to collect.
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
