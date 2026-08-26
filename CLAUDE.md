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
| `src/model.js` | logistic regression (AdaGrad, L2, class-balanced), score shrinkage toward 0.5, 5-fold CV, insights. Deterministic: same votes → same weights (`mulberry32` is exported for anything else that needs a seeded draw). Beside the aggregates, `crossValidate()` returns `heldOut` (the per-example out-of-fold score, keyed by the `id` the caller attached), `foldAccuracy`, and `noise` — the band on *one* accuracy figure, being the larger of the fold spread (sample sd: five draws, and the population form is biased low, always towards calling a wobble real) and an Agresti-Coull standard error. Gating a *move* needs a wider band than this; see `accuracyMove()`. |
| `src/hn.js` | Algolia HN API. `fetchDay()`/`fetchFrontPage()` + `syncDays(conn, days, opts)`, the one loop that puts stories in the database — per-day transaction, failures recorded and stepped over, every day handed in always fetched (there is no skip rule — a covered-looking day is refetched, upserts make that cheap in the database). Pure fetch + `upsertStory`; no meta, no scoring. `fetchStory(id)` looks up one submission (used by the vote import). |
| `src/db.js` | schema (incl. `oof_scores`, the held-out prediction per vote, `oof_previous`, the same from the train before (what makes an accuracy move testable — see rounds, below), `vote_predictions`, the frozen pre-vote guess, and the two expression indexes the training queue seeks on), `db()` singleton, `openDb(path)` for tests, vote/story queries. `recordVote` stamps now and keeps the original `created_at`; `importVote` lets a restored history's timestamp win, for `updated_at` too — the Votes view reads `updated_at`, so a restore must not read as "voted a minute ago". |
| `src/service.js` | `trainAndScore()` (train → store snapshot → `rescoreAll()` the corpus) and `scoreMissing()` (score only stories the current model rev hasn't seen — used after a sync, no retrain). `sync()` (the one way stories enter the database: `{days}` or `{from,to}` → `syncDays()` + front page when today is in range + `scoreMissing()` + the `last_sync_at` stamp — never fetch without it, an unscored story is invisible to the feed). `storeHeldOut()` rewrites `oof_scores` whole on every train, so a deleted vote leaves no stale row, shifting the outgoing set into `oof_previous` (SQL-side insert-select) so the next round has a baseline to pair against. One revision back, never a history. `judge()` (capture the prediction, record the vote, report the signals it teaches), the round functions (`dealRound()`, `roundStatus()`, `currentRound()`, `roundSummary()`, `ROUND_SIZE`) and `modelHistory()` (the learning curve: accuracy per *training run*, read out of the stored payloads with `json_extract`; revisions that added no votes are dropped, since a no-op retrain is the same model again and the pre-round table is mostly those). Also `feed()`, `trainingQueue()` (see below), `voteLog()` (the Votes view's history list, which serves `oof_score` beside the stored one), `explain()`, `stats()` (which embeds `scoreDistribution()`: the unvoted-corpus histogram shown in Brain, binned in SQL over the stored score). Holds the module-level model cache (`resetModelCache()` in tests). Feed filtering/sorting/paging is done **in SQL** — keep it there. `feed()` takes `minScore`/`maxScore` (exclusive) so a histogram bar in Brain can open exactly its bucket. |
| `src/trainer.js` | background training: `requestTrain()` spawns `train-worker.js` in a worker thread on its own DB connection; one run at a time, a trigger mid-run coalesces into a single follow-up run. `trainStatus()`, `trainingIdle()` (tests). |
| `src/syncer.js` | background fetching: `requestSync(opts)` spawns `sync-worker.js` in a worker thread on its own DB connection; one run at a time, a request mid-run is refused as `busy` (options can't be coalesced). `syncStatus()` streams the current day, `syncIdle()` (tests). |
| `src/server.js` | routes table, optional `AUTH_TOKEN` auth, static files. Nothing fetches on a timer — `POST /api/sync` (202) is the only trigger, driven by cron or the Brain tab. Training's shape lives here too: `GET`/`POST /api/round` (resume or deal), `GET /api/round/summary` (what the finished round changed; also marks it spent), `GET /api/history` (the learning curve). `GET /api/queue` still serves a raw stratified draw and is what the round is dealt from. |
| `src/cli.js` | `sync` / `train` / `stats` / `reset-models` (forget every trained model and retrain from the votes; insists on `--yes`). Flags: run with an unknown command (e.g. `node src/cli.js help`) to get the usage line. |
| `public/app.js` | the whole front end: Train, Feed, Votes, Brain views. Train is round-shaped: `loadRound()` resumes or deals, `finishRound()` runs the one retrain and asks for the summary, `renderRoundSummary()` draws it. There is no refill, no queue cursor and no train debounce — a round replaced all three. Status is rendered **into the layout** (`#train-status`, `#feed-note`, `#votes-note`, `#data-note`), never as a floating toast — there is no `toast()` any more. |
| `scripts/pull-prod-db.sh` | copies the production database into `data/`: wakes the machine, `VACUUM INTO` over `node:sqlite` (the image has no `sqlite3`), `fly sftp get`, then removes the temp copy from the volume. The local copy is read-only on purpose — it is a snapshot, copy it before using it as a working database. |

## Conventions

- Everything is synchronous around SQLite. Voting only records the vote; the
  last card of a round triggers one `POST /api/train`, which returns 202
  immediately and runs `trainAndScore()` in a worker thread (`trainer.js`) on
  its own DB connection, so the request path never blocks on a rescore of the
  whole corpus (~50k stories, about 0.6 s). **A round boundary is the only retrain trigger** — no
  debounce on individual votes, and no manual button (one existed and was
  removed: it asked for a rescore no new evidence justified, and it could split
  a round across two model revisions). A vote cast in Feed or Votes is trained
  on when the next round ends, like every other vote — one rule instead of
  three. `node src/cli.js train` covers the rare manual case.
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
  verdict by more than `CONFLICT_MARGIN` (`public/app.js`) — about one vote in
  ten, the titles your other votes argue against. The margin matters: without
  it, 39% of votes "conflict", most of them predictions sitting near 0.5 with
  no opinion to disagree with. Don't wire that flag back to `scores`; it can never
  fire there. The held-out score is stale between trains by construction.
- `heldOut` stays out of `models.payload` and out of `/api/stats`: it is one row
  per vote, and a snapshot per rev would carry the whole vote history each time.
- The feed never shows unscored stories (`sc.score IS NOT NULL`) — before the first
  model it is empty by design. Unscored is transient otherwise: `sync()` scores
  what it fetched before it returns.
- **A skip is not a training example.** `labelledStories` excludes
  `value = 0`, so a skip teaches nothing: it consumes its slot in the round,
  leaves the story judged, and contributes no example. A round of nothing but
  skips therefore retrains nothing and says so. (Before rounds, every swipe
  including a skip triggered a retrain — a full corpus rescore producing a
  model identical to the last, announcing "Learned · 64% accurate" about a
  story you had declined to judge.)
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
- Training is dealt in **rounds**: `ROUND_SIZE` (12) cards drawn from one
  model revision, judged, then one retrain. A skip consumes a slot — a round
  is twelve cards, not twelve verdicts. The first round of a session is
  auto-dealt; every one after it comes from the button on the summary, because
  the pause is what makes the task finite. The unit is the point: before it, a
  retrain fired after roughly every individual vote (a scratch database
  held 162 revisions for 513 votes) and the accuracy it produced could not be read as the consequence of
  anything.
  - The round in flight lives in `meta.current_round` (`dealRound()`,
    `roundStatus()`, `currentRound()`), **not** in the browser: this app is
    installed on more than one device, and a round that exists in one browser
    is only finite in that browser. Progress is a join against `votes`, never
    a counter, so it cannot drift from what was recorded and picks up votes
    cast anywhere else. A deal older than a day is discarded rather than
    resumed; its votes were saved and are trained on at the next boundary.
    `seq` (the round number, from `meta.round_seq`) and `rev` advance
    independently — a round of nothing but skips moves `seq` and not `rev`.
  - It needs **no table**. Because retraining happens only at a round
    boundary, a completed round is identified by the model revision it was
    dealt at, so everything a summary needs is derivable: the votes from
    `vote_predictions WHERE model_rev = R`, and accuracy, signals and weights
    from the `models` payloads at R and R+1.
  - `roundSummary()` reports the round **in order of how much each number
    means**, which is not the order of how impressive they look: what the
    round moved on, then signals gained, then the hit rate, then accuracy.
    - *what it moved on* — the features whose weight shifted most between the
      two revisions, shown as bare green/red chips (the colour says which way;
      labelling it in words as well read as an instruction). Delta and weight
      must agree in sign: `github.com` can move hard towards no and still sit
      on the yes side, and naming it a dislike would state the opposite of
      what the model believes. Support ≥ 2, so a word read once is not sold
      back as a pattern.
    - *accuracy*, last. The move is always shown; what the band decides is
      whether it is coloured (`delta up`/`down`) or grey (`delta flat`, with
      "unchanged within ±n" beside it). Both states name both ends, because
      hiding the before-value on a flat round left only "red arrow" or "bare
      number", and the same wobble then read as a regression one round and as
      nothing at all the next — 65 → 62 → 64 showed as a red drop and then
      silence. A dozen votes shift accuracy about as much as nothing does (±4
      points at ~400 votes).
    - It is gated **paired**, on the flips (`pairedFlips()`), because two
      revisions' accuracies are two scorings of nearly the same votes. Of the
      votes both held out, the ones whose call changed sides are the entire
      evidence: right-then-wrong argues against, wrong-then-right argues for,
      and a vote called the same way twice says nothing whichever way it was
      called. `significant` is McNemar on those (normal approximation, two-sided
      95%), so a big net out of a few flips counts and a small net out of many
      does not. The flip count is shown under the percentages, since it is the
      one thing an aggregate can never say: "four of 72 predictions changed
      sides, net −2" is a different claim from an eight-point drop, and in the
      case that motivated this it was the true one — the aggregate fell because
      a dozen deliberately-hard cards joined the denominator, not because the
      model got worse at the votes it already had. For the same reason
      `flips.delta` (net/shared) and the displayed move differ a little: the
      second percentage has this round's votes under it and the paired one does
      not.
    - `band` is the **fallback**, for when there is nothing to pair against
      (`oof_previous` empty, a revision gap, too few votes to cross-validate):
      `metrics.noise` for the two revisions widened by √2 (`COMPARE_BAND`).
      `noise` itself is the larger of the fold spread and an Agresti-Coull
      standard error — the textbook binomial one collapses to zero when a small
      model separates perfectly, which would make every later wobble look like
      progress — but that is the band on a *single* figure, and this gates a gap
      between two, so √2 is quadrature on two equal bands (the independent case,
      which overstates it by however correlated the scorings really are — the
      safe direction). No absolute floor: at 500 votes a 3-point move is noise,
      at 50k a half-point one is real, and a constant would be wrong at one end.
    - The `explore` hit rate is computed and **not** displayed. It is the only
      unbiased read of true accuracy in a round — boundary cards are picked
      *because* the model can't call them — but shown bare as "1/2 on the
      random cards" it explained none of that. It needs somewhere with room.
  - The summary marks the round spent (`finishedAt`), so reopening the tab on
    a finished round shows it again instead of paying for a second retrain of
    the same votes.
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
    key, seek the first unjudged story past it — so a deck costs about one index
    seek per card whether the corpus holds 10k stories or 10M (measured: 3.6 ms
    for a 40-card draw over a million stories; 32 ms to deal a round of 12 over
    the real 49k). Two SQLite traps make or break that, and both are commented in
    place: `LIMIT`/`OFFSET` must be **written into the SQL, never bound** (a
    bound limit stops the planner bounding the sorter: 21 ms vs 0.4 ms), and
    `MIN(id)`/`MAX(id)` must be **two statements** (asking for both at once
    scans the table). Interpolated numbers go through `int()`.
  Quotas are allocated by largest remainder (`allocate()`) so they sum to
  exactly the limit: rounding each share alone overshot, and truncating the
  overshoot flattened 40/20/20/20 into an even split at a round's size (12 →
  5 boundary / 3 novel / 2 recent / 2 explore).
  The draw is seeded on `model_rev` + `cursor` (the round's sequence number),
  so a round redraws identically on a reload, and two rounds sharing a
  revision — a round of nothing but skips triggers no retrain — still differ.
  `mix` in the `/api/queue` response counts the strata; the trainer card itself
  still says nothing about why a story was picked, because a visible reason
  anchors the vote it is trying to collect.
- The tokenizer keeps `&` and `/` **inside** a word and trims them off the
  ends. As separators they shredded things that mean something: "S&P 500"
  became `s` + `p` + `500`, and "278 tok/s" left a bare `s` that then surfaced
  as a learned term. AT&T, R&D, M&A and km/h have the same shape. `i` is a
  stop word for the same reason — a pronoun, not a topic (1,568 titles of
  49,281 carry a bare "i"), and the shape it hints at is already carried by
  `t:narrative`/`t:showhn`. Changing any of
  this **renames features and invalidates every learned weight**, so it is
  cheap only when the votes are about to be rebuilt anyway.
- `models` is **derived data**. The model is a deterministic function of the
  votes, so `resetModels()` (`cli.js reset-models --yes`) can delete every
  revision and a retrain reproduces it. Votes and `vote_predictions` are left
  alone — they are the record. Reach for it after a change that renames
  features: weights are keyed by feature *name*, so a history spanning a
  tokenizer change diffs vocabularies rather than models, and the round summary
  would report thousands of "new signals" that are the same words renamed.
  It clears `oof_previous` too — a baseline naming a revision about to stop
  existing is worse than none — and `sqlite_sequence`, or AUTOINCREMENT carries on from the old
  numbering, and drops the round meta, since a round in flight was dealt by a
  model that no longer exists. Retrain immediately: an empty models table
  leaves the queue on its cold path. On the live machine:
  `fly ssh console -C "node src/cli.js reset-models --yes"`.
- `models` is also append-only and nothing prunes it — 51 revisions came to
  6.3 MB, ~124 KB each and growing with the vocabulary. Not a problem at a
  round per sitting; it will want a retention rule before it is one.
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
