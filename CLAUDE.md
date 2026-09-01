# CLAUDE.md

Personal Hacker News recommender: thumb titles up/down, a small logistic
regression learns your taste, the feed reranks. Single user, single process.
README.md is the full product description; this file is orientation for agents.

## Shape

- Rust (one binary, `rekorderlig`), synchronous throughout — nothing in this
  crate is `async`. Postgres via the sync `postgres` crate, HTTP server via
  `tiny_http`, HTTP client via `ureq`; the dependency list ends there plus
  serde/url/unicode-normalization (the Node version's "zero npm dependencies"
  spirit, translated).
- No frontend build step. `public/` is served as-is (vanilla JS, one `app.js`).
- One Postgres database, reached through `DATABASE_URL`. Schema lives inline in
  `src/db.rs`; there is no migration system — only `CREATE ... IF NOT EXISTS`,
  run on every connect under an advisory lock so the server, trainer and syncer
  can all open at boot without racing each other into a `pg_type` duplicate key.
  The schema is a straight port of the SQLite one it replaces — same tables,
  same columns, same `models.payload` JSON — so an imported production database
  reads back identically, and the model retrains to the same weights.
- **No pool.** One connection behind a `Mutex` on the request path, one of its
  own per worker thread. Single user, single process; a pool would be three
  more idle sockets and a configuration surface.
- Every connection is a `Db` (`src/db.rs`), not a bare client, for one reason:
  the Fly machine suspends to RAM, so a held socket is dead on resume and the
  first statement of the first visit meets it. `Db` reopens and retries that
  statement once.

## Where things are

| File | Owns |
|---|---|
| `src/features.rs` | title → named sparse features. Names are human-readable on purpose (`w:rust`, `dom:github.com`) — never hash them, the UI shows them back. |
| `src/model.rs` | logistic regression (AdaGrad, L2, class-balanced), score shrinkage toward 0.5, 5-fold CV, insights. Deterministic: same votes → same weights (`mulberry32` is public for anything else that needs a seeded draw). Beside the aggregates, `crossValidate()` returns `heldOut` (the per-example out-of-fold score, keyed by the `id` the caller attached), `foldAccuracy`, and `noise` — the band on *one* accuracy figure, being the larger of the fold spread (sample sd: five draws, and the population form is biased low, always towards calling a wobble real) and an Agresti-Coull standard error. Gating a *move* needs a wider band than this; see `accuracyMove()`. |
| `src/http_client.rs` | the one JSON fetch (`HttpFetcher` behind the `Fetch` trait, which tests fake), with the retry rule both sources share (retry 429/5xx and transport errors, give up at once on a 4xx). Extracted so `firebase.rs` didn't fork a copy. |
| `src/firebase.rs` | HN's official item API, used for one job only: recovering stories Algolia's index never got. `normalizeItem()` (→ the same story shape `upsertStory` takes, `null` for comments/jobs/polls/`dead`/`deleted` — those are ~11% of any id range and are not losses), `idRangeForDay()` (bisects Firebase's own `maxitem` for a day's id bounds, ~26 requests, so the index whose gaps we're repairing never defines the range to repair; padded by `ID_PAD` because item time is only *nearly* monotonic in id, and each item's own timestamp decides its day), `backfillDays()` (walks every id, upserts live stories at or above the points floor; bounded concurrency, one transaction per day, a failed id recorded and stepped over like `syncDays`). No diff against Algolia first — an id must be fetched to learn whether it's a story at all. See the repair convention below. |
| `src/hn.rs` | Algolia HN API. `fetchDay()`/`fetchFrontPage()` + `syncDays(conn, days, opts)`, the one loop that puts stories in the database — per-day transaction, failures recorded and stepped over, every day handed in always fetched (there is no skip rule — a covered-looking day is refetched, upserts make that cheap in the database). Pure fetch + `upsertStory`; no meta, no scoring. `fetchStory(id)` looks up one submission (used by the vote import). |
| `src/db.rs` | the `Db` connection wrapper (reconnect-on-dead-socket, `begin`/`commit`, `rollback_if_open`), `db_url()`, schema (incl. `oof_scores`, the held-out prediction per vote, `oof_previous`, the same from the train before (what makes an accuracy move testable — see rounds, below), `vote_predictions`, the frozen pre-vote guess, and the two expression indexes the training queue seeks on), `openDb(url)`, vote/story queries. `recordVote` stamps now and keeps the original `created_at`; `importVote` lets a restored history's timestamp win, for `updated_at` too — the Votes view reads `updated_at`, so a restore must not read as "voted a minute ago". `labelledStories` orders `created_at ASC, story_id DESC` — the DESC is not arbitrary, it is the tie order SQLite used to produce, and example order decides the whole AdaGrad trajectory. |
| `src/service.rs` | `trainAndScore()` (train → store snapshot → `rescoreAll()` the corpus) and `scoreMissing()` (score only stories the current model rev hasn't seen — used after a sync, no retrain). `sync()` (the one way stories enter the database: `{days}` or `{from,to}` → `syncDays()` + front page when today is in range + `scoreMissing()` + the `last_sync_at` stamp — never fetch without it, an unscored story is invisible to the feed). `backfill({from,to})` is the repair counterpart: `backfillDays()` + `scoreMissing()`, and pointedly **no** `last_sync_at` stamp, since repairing a historical day says nothing about how fresh the corpus is. `storeHeldOut()` rewrites `oof_scores` whole on every train, so a deleted vote leaves no stale row, shifting the outgoing set into `oof_previous` (SQL-side insert-select) so the next round has a baseline to pair against. One revision back, never a history. `judge()` (capture the prediction, record the vote, report the signals it teaches), the round functions (`dealRound()`, `roundStatus()`, `currentRound()`, `roundSummary()`, `ROUND_SIZE`) and `modelHistory()` (the learning curve: accuracy per *training run*, read out of the stored payloads with `json_extract`; revisions that added no votes are dropped, since a no-op retrain is the same model again and the pre-round table is mostly those). Also `feed()`, `trainingQueue()` (see below), `exploreQueue()` (the Explore deck: same judging loop, opposite selection — a traction bar, `EXPLORE.minPoints` / `minComments`, either one is enough, instead of uncertainty; tiered `probably` (score ≥ 0.6) before `possibly` (≥ 0.35), with a clear no dropped outright), `voteLog()` (the Votes view's history list, which serves `oof_score` beside the stored one), `explain()`, `stats()` (which embeds `scoreDistribution()`: the unvoted-corpus histogram shown in Brain, binned in SQL over the stored score). Holds the module-level model cache (`resetModelCache()` in tests). Feed filtering/sorting/paging is done **in SQL** — keep it there. `feed()` takes `minScore`/`maxScore` (exclusive) so a histogram bar in Brain can open exactly its bucket, `day` — one dated day, which **replaces** `days` rather than narrowing it — so the stories-per-day chart can open exactly its bar, and `min_points` beside `min_comments` (two floors on the same axis, deliberately independent). |
| `src/trainer.rs` | background training: `Trainer::request()` spawns a thread with its own DB connection; one run at a time, a trigger mid-run coalesces into a single follow-up run. `status()`, `wait_idle()` (tests). |
| `src/syncer.rs` | background fetching: `Syncer::request(opts)` spawns a thread with its own DB connection; one run at a time, a request mid-run is refused as `busy` (options can't be coalesced). `status()` streams the current day, `wait_idle()` (tests). |
| `src/sync_remote.rs` | the outward poke: `trigger()` POSTs `/api/sync` on a *running* instance, polls `GET /api/sync` until the run ends, and turns the outcome into an exit code. The only place the binary talks to itself over HTTP — it exists so the hourly trigger can be a machine with no `DATABASE_URL` of its own. Retries the POST on 5xx/transport (a cold boot drops the first connection) and never on a 4xx; tolerates a blip on a poll; `busy` means someone else's run, which it watches instead of failing. |
| `src/server.rs` | routes table, optional `AUTH_TOKEN` auth, static files. Static files carry an **`ETag`** built from size and mtime — not a hash of the bytes, because the point is to answer a revalidation *without* reading the file. `cache-control: no-cache` means "revalidate before reusing", which saved nothing while there was no validator to revalidate against: a repeat visit re-downloaded all 19 files (123 KB) and now transfers none of them. `If-None-Match` is parsed the way browsers send it — a list, possibly `*`, entries possibly `W/`-prefixed — because reading only the bare form would answer 200 to requests that should be 304s, which is correct but never hits, and would not look like a bug. Nothing fetches on a timer — `POST /api/sync` (202) is the only trigger, driven by the hourly Fly machine (`sync-remote`) or the Brain tab. Training's shape lives here too: `GET`/`POST /api/round` (resume or deal), `GET /api/round/summary` (what the finished round changed; also marks it spent), `GET /api/history` (the learning curve). `GET /api/queue` still serves a raw stratified draw and is what the round is dealt from. `GET /api/explore` is the Explore deck's pool, and ships the traction bar along with the cards. |
| `src/main.rs` | subcommands: `serve` (the HTTP server; Docker's CMD) and the CLI companion — `sync` / `sync-remote` (the hourly trigger: `REKORDERLIG_URL`, `REKORDERLIG_SYNC_DAYS`, `AUTH_TOKEN`) / `backfill` (`--from`/`--to`, `--dry-run` to audit without writing) / `train` / `stats` / `reset-models` (forget every trained model and retrain from the votes; insists on `--yes`). Flags: run with an unknown command (e.g. `rekorderlig help`) to get the usage line. `src/dates.rs` holds the UTC day arithmetic (`dayKey`, `daysBetween`) both sources share; `src/lib.rs` re-exports the modules so integration tests drive the same code the binary runs. |
| `public/format.js` | numbers into words (`pct` — never 0% or 100%, the model is a guess; `plural`, `ago`, `scoreColor`). No DOM, no state. |
| `public/certainty.js` | the `CERTAINTY` bands and `certainty()`: how sure a call was, in words, on its *strength* (0.5–1) and never on P(yes). No DOM, no state. Each band's `name` needs a matching `.verdict.sure-<name>` colour in `styles.css` — the one thing here no test can run, so `tests/styles.test.mjs` holds the two files to each other, importing this table rather than parsing it. |
| `public/feed-params.js` | the feed's filters to and from the URL (`FEED_DEFAULTS`, `FEED_PARAM`, `readScore`, `readFeedParams`, `feedParams`). A parser: it decides what a link means, which is why the context a *link* implies (a bucket or a dated day dropping the traction floors) lives here and not in the panel's controls. No DOM — the mode list is passed in rather than read off the chips, which is what lets tests import it. |
| `public/app.js` | the composition root, and nothing else: imports every view so each registers itself, wires the two things that span views (the tab bar and the arrow keys), and boots. Boot strips `?token=` from the address bar before the first `replaceState` — the param is a bootstrap the server trades for a year-long `rk_token` cookie, and every history entry after it carries filter state and nothing secret. The strip sits after `refreshStats()` on purpose: that fetch sends no token of its own, so reaching the rewrite proves the cookie took, and a 401 throws before it and leaves the tokened URL good for a reload. |
| `public/dom.js` | `$`, `el`, `icon`/`ICON_PATHS` (Lucide, inlined — no build step) and `api()`, the one fetch wrapper. Imports nothing: the bottom of the graph. |
| `public/state.js` | the one state object. Every view owns a slice (`feed`, `votes`, `explore`); `judgedIds` is shared by both judging decks, which is why it sits at the top level rather than in a `train` slice. |
| `public/status.js` | the note lines. Status is rendered **into the layout** (`#train-status`, `#explore-status`, `#feed-note`, `#votes-note`, `#data-note`), never as a floating toast — there is no `toast()` any more; `setTrainStatus()` writes to whichever deck is open. |
| `public/registry.js` | how the router reaches a view without importing it. Views `register()` at import; the router and chrome reach them through `hook()`. Hooks: `show`, `url`, `adopt`, `stats`, `sync`. This is what keeps the graph acyclic — see the convention below. |
| `public/router.js` | `showView()`, `viewFromPath()`, `urlFor()`, `navigate()`. Each section owns a path; only the feed carries GET parameters, via its `url` hook. Imports no view. |
| `public/chrome.js` | the frame: `renderTagline()` (view-specific — Train the full picture, Feed only model quality, Brain nothing), `refreshStats()` and the theme toggle. Reaches the open view through the registry's `stats` hook, never by importing it. |
| `public/reveal.js` | the verdict after a swipe, shared by both decks: `showReveal()` and `needMore()`. Names both parties and keeps the halves symmetric; the glyph is `=`/`≠` because the line compares two verdicts rather than grading one. |
| `public/train.js` | Train, round-shaped: `loadRound()` resumes or deals, `finishRound()` runs the one retrain and asks for the summary, `renderRoundSummary()` draws it. There is no refill, no queue cursor and no train debounce — a round replaced all three. Registers `sync: loadRound`, so stories arriving from a fetch get dealt. |
| `public/explore.js` | Explore: the trainer's card over its own queue in `state.explore` (`loadExplore()`, `renderExploreCard()`, `voteExplore()`) — not round-shaped, since a round is a sample from one model revision and this is a reading list you can vote on. |
| `public/feed.js` | the ranked list and its filters. `setFeed()` is the one way a filter moves (write URL → `paintFilters()` → reload); `paintFilters()` is the one paint path, and lights every labelled row with one function over the row's `data-*`. Registers `url` and `adopt`, which is how a bookmarked `/feed?s=70-75` opens filtered. |
| `public/votes.js` | the history list, and the held-out score shown only when it contradicts the verdict by more than `CONFLICT_MARGIN`. |
| `public/brain.js` | the model panels, the learning curve, the score histogram and the stories-per-day chart, plus the fetch and export buttons. Clicking a bar in either chart **navigates** — `/feed?s=70-75` for a score bucket, `/feed?d=2026-08-12` for a day — rather than calling into the feed — Brain has no business knowing how the feed keeps its state, and a bucket is a place the back button should return from. |
| `scripts/fly-sync-machine.sh` | creates or repairs the hourly trigger: the Fly scheduled machine that runs `rekorderlig sync-remote`. A reconciler — it compares image, schedule, restart policy, command and env against what it wants and only rebuilds on a difference, because recreating the machine restarts the hourly interval. `--dry-run` says what it would change. |
| `scripts/pull-prod-db.sh` | `pg_dump -Fc` of production into `data/`, over `fly proxy`. The local copy is read-only on purpose — it is a snapshot, restore it somewhere before changing it. Holds no credential: `PROD_DATABASE_URL` comes from the environment. |
| `scripts/push-db-to-preview.sh` | the manual refresh of an existing preview: drop and recreate its `preview_pr_<n>` database, `pg_restore` into it, `ANALYZE`. Refuses any app whose name isn't `*-pr-*`. Everything the SQLite version needed — `integrity_check`, `mv` over the live file, a machine restart so the process picked up the new inode — went away with the file. |
| `scripts/fly-pg-proxy.sh` | sourced by both: opens `fly proxy` onto the database machine and closes it again. The database publishes no services, so this is the only way in from outside 6PN — the front door, not a workaround. |
| `scripts/fly-db-setup.sh` | one-time (and idempotent) creation of the `rekorderlig-db` app, its volume and its superuser secret, then prints the role setup it cannot do without a running server. Three roles: `rekorderlig` owns the database, `preview_admin` may only CREATEDB, `preview_reader` may only read production. The CI credential must not be able to touch production. |
| `scripts/fly-db-secrets.sh` | sets `DATABASE_URL` on the app and the two preview passwords as repo secrets, prompting without echo so nothing lands in shell history. Tries each credential first — a typo would otherwise surface as a failed deploy, or as a preview workflow that only breaks on someone else's PR — and asserts that `preview_admin` **cannot** connect to the production database, which is the whole reason it is a separate role. Re-run it to rotate. |

## Conventions

- Everything is synchronous around the database. Voting only records the vote; the
  last card of a round triggers one `POST /api/train`, which returns 202
  immediately and runs `train_and_score()` on a background thread (`trainer.rs`) with
  its own DB connection, so the request path never blocks on a rescore of the
  whole corpus (~50k stories: 0.8 s against a local Postgres, where SQLite took
  0.6 s — the scores go up in multi-row `INSERT`s of 500, so that is about 104
  round trips rather than 52k). **A round boundary is the only retrain trigger** — no
  debounce on individual votes, and no manual button (one existed and was
  removed: it asked for a rescore no new evidence justified, and it could split
  a round across two model revisions). A vote cast in Feed or Votes is trained
  on when the next round ends, like every other vote — one rule instead of
  three. `rekorderlig train` covers the rare manual case.
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
- Explore is a second judging deck, not a second feed: it writes the same votes
  through the same `POST /api/vote`. What it changes is *what gets asked about*.
  The trainer optimises for information (uncertain titles, which on HN is mostly
  the 1-comment tail); Explore optimises for the reader (only stories the crowd
  stopped on). Keep the numbers in `EXPLORE` — they are the whole contract, and
  `/api/explore` ships them to the client as `bar` so the empty state can quote
  them without keeping its own copy. Explore is **not** round-shaped and
  triggers no retrain: a round is a sample from one model revision, dealt so
  its before-and-after numbers mean something, while Explore refills as you
  judge. A vote cast here is trained on when the next round finishes — the
  same rule Feed and Votes follow.
- A card never shows its score, in either deck. A percentage in front of a
  thumb anchors the judgement and contaminates the label. Explore's tier chip
  is the deliberate exception: coarse ("probably" / "possibly"), and it is the
  reason the card is on screen at all.
- Unlike the feed, Explore does show unscored stories — before the first model
  every card is `possibly` and the deck is pure crowd order. "The crowd is on
  it" is a claim about points and comments, and needs no model to be true.
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
  **Explore's card is the exception, deliberately**: it shows points, comments
  and the tier chip, because there the traction *is* the offer — it is the
  answer to "why is this story in front of me", and a deck that hid it would
  be unexplained. The cost is real and worth knowing: those votes carry a
  little of the crowd's opinion into the title weights. The model's own score
  stays hidden in both decks, which is the part that would anchor a vote
  outright.
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
  ("Brain guessed no (fairly sure, 81%) — you said yes."): never "you agreed", which casts
  the model as the reference and the vote as the thing falling in line — the
  vote is the truth, the guess is a guess. The glyph is `=` / `≠` for the same
  reason: the line compares two verdicts, where a tick and a cross would grade
  the vote against the guess. ("Got that one wrong" had the same
  fault in reverse: it never said whose mistake it was.) The percentage
  is the confidence in the call the model actually made, not P(yes) — beside
  "guessed no" the raw score reads as its own opposite.
- How sure it was is named in words *and* coloured by that name, on the
  `CERTAINTY` bands (`public/app.js`): ≥0.9 "very sure", ≥0.75 "fairly sure",
  ≥0.6 "leaning", below that "a coin flip". The word carries what the number
  never could on its own — "51% certain" is a coin flip described as a
  conviction, and it was drawn in the same full red as a call made at 96%. The
  bands are on the *strength* of the call (0.5–1), so the hue still comes from
  hit/miss (`--verdict-hue`) and the band decides how much of it is spent:
  `.sure-mid`/`.sure-low` mix towards `--muted`, and `.sure-none` is plain grey,
  because agreeing with a coin flip is not a hit and disagreeing with one is not
  a miss. Adding a band means adding its `.verdict.sure-<name>` colour —
  `tests/styles.test.mjs` holds the two files to that.
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
- **The front end is one module per view, and the views never import each
  other.** `app.js` is a composition root, not a file with everything in it.
  Views reach each other through `registry.js`: each calls `register()` at
  import with the hooks it answers to (`show`, `url`, `adopt`, `stats`,
  `sync`), and the router and chrome call them through `hook()`. That is the
  whole reason the registry exists — the router has to start the feed loading
  and the chrome has to redraw Brain when stats arrive, and a view importing
  the router while the router imported it back would be a cycle. ES modules
  tolerate cycles until they don't: declarations hoist, so it works right up
  until a binding is read during initialisation and is still in its temporal
  dead zone. `tests/modules.test.mjs` walks the real import graph and fails on
  a cycle, on a view importing a view, and on a leaf growing a dependency.
  Two cross-view edges used to exist and both are gone rather than moved:
  Brain called into the feed to open a histogram bucket (it navigates to
  `/feed?s=70-75` now, which is also what makes the back button work), and the
  router called each view's loader by name. The one genuinely shared piece of
  judging UI lives in `reveal.js`, which both decks import — that is a leaf,
  not an edge between views.
  There is still no build step: `index.html` loads `/app.js` as a module and
  the browser fetches the rest — which costs nothing on a repeat visit,
  because `serve_static` sends an `ETag` and answers a matching
  `If-None-Match` with a 304 (see the server row above).
- **The feed's filters live in the GET parameters.** A filtered feed is a place:
  bookmarkable, linkable from the phone to the laptop, and reachable with the
  back button. `state.feed` is the parsed form of `?mode=&days=&minScore=…` and
  is never the source — `setFeed()` folds a patch in, writes the URL, repaints
  the panel from it and reloads, so the chips and the list cannot disagree.
  Rules that keep it honest:
  - **The panel is one labelled row per filter, and one active member per row.**
    The label column is the point: five unlabelled rows of identical pills read
    as one wall, and the top row is not even a filter — it is the sort order,
    and nothing but a label could say so. Every row is now the same shape, so
    `paintFilters()` lights them with one function over the row's `data-*` and
    `chipGroup()` binds them all the same way. Two consequences worth keeping:
    a value no chip carries lights none of them (which is how a dated day
    leaves the window row dark), and the `Voted` row is two chips rather than
    one toggle, because it is a filter with two states and read as a button
    that does something while it was a lone pill in the window row.
  - **Points and comments are two floors, not one traction idea.** Points are
    the crowd's verdict on the link, comments are how much it was argued about,
    and a story is regularly one without the other — a linkbait post with 90
    comments and 2 points, a quiet paper with 120 points and none. `p` and `c`
    are independent, intersect when both are set, and neither implies the
    other.
  Three more rules on how the URL is spelled:
  - **One letter each, and only non-defaults are written**: `?m=top&d=30&c=50&v=1&q=rust`,
    and the common case is a bare `/feed`. State keys stay spelled out — only
    the address bar is terse. `FEED_DEFAULTS` is the single declaration of what
    a filter is and `FEED_PARAM` maps each to its letter; a value that fails to
    parse falls back rather than reaching the API as `NaN` or as a mode the
    server doesn't switch on. A hand-edited link normalizes on arrival, since
    boot writes `urlFor()`'s canonical form back. `tests/feed-params.test.mjs`
    holds the two tables to the same key set and the letters distinct — an
    unlettered filter never round-trips, and two sharing a letter give you a
    bookmark that applies the wrong one — while `tests/app.test.mjs` boots the
    app and checks each one reaches the actual request.
  - **Two letters carry two shapes each**, and in both cases the shapes are one
    idea that is never in force twice over. `s=70` is the slider's floor,
    `s=70-75` a bucket out of the Brain histogram. `d=30` is a window back from
    now, `d=2026-08-12` one dated day out of the stories-per-day chart —
    writing either retires the other, so state never holds two answers about
    time, and `FeedOptions::day` **replaces** the window server-side rather
    than intersecting with it (a clicked day is usually outside the 7-day
    default, so anding them would always give nothing and the bar would look
    broken rather than empty). A third claimant on either letter would have no
    shape left to be told apart by, which is what `tests/feed-params.test.mjs`
    holds them to. The date picker in the window row is the second shape made
    reachable without a chart: it sits *in* that row rather than beside it,
    because there is only ever one answer about time and two controls in two
    places would look like two filters to intersect.
    A **link** carrying either shape implies its own context — all time, no
    traction floor — because the histogram counts the whole unvoted corpus and
    a 7-day window would show nine stories where the bar promised twelve
    hundred. That is what keeps `?s=70-75` from spelling out `d=0&c=0` beside
    it; an explicit `d`/`c` in the link still wins. The implication belongs to
    the link and not to the control: a day named in the **panel** leaves the
    floors standing, because you are looking straight at them and a bar
    promised you nothing. An inverted or unparseable range is rejected whole
    rather than half-applied.
  - **Both score bounds are integer percentages**, in state and in the URL,
    divided by 100 once in `loadFeed()` for the API. That is the slider's unit
    (`step=5`), the band chip's and the histogram's — 20 equal bins over [0,1],
    so every edge is a whole 5% and nothing is lost. Two representations of one
    number is what this replaced.
  - **The panel's controls replace, the histogram drill-down pushes.** Dragging
    the slider or typing a search must leave one history entry, not dozens;
    arriving at a score bucket from Brain is a real navigation and back should
    reach the chart. `setFeed()` defaults to `replaceState` and pushes only when
    asked.
  - **A band restores only what identifies it.** Touching any other filter
    leaves a band — a context clicked out of a Brain chart — but what comes
    back is the day, or the two score bounds, and not the whole view the band
    opened. Leaving a day used to also snap the comment floor back to 10, which
    silently threw away a floor set by hand in the panel; the two exits now
    follow one rule.
  `paintFilters()` is the one paint path. Reaching into a widget from anywhere
  else forks the panel from the URL — which is exactly what `showScoreBand()`
  used to do, mirroring six controls by hand so the closed panel wouldn't lie
  when it was next opened.
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
    the real 49k). Three traps make or break that, and all three are commented
    in place:
    - `LIMIT`/`OFFSET` must be **written into the SQL, never bound** (a bound
      limit stops the planner bounding the sorter: 21 ms vs 0.4 ms). Interpolated
      numbers go through `int()`.
    - `MIN(id)`/`MAX(id)` must be **two statements** (asking for both at once
      scans the table).
    - "unjudged" must be an **anti-join** (`UNJUDGED`), never a `LEFT JOIN
      votes` with `v.value IS NULL`. `votes.value` is NOT NULL, so Postgres's
      null fraction for it is zero, it estimates the whole join at one row, and
      from there every plan looks equally cheap — it took a sequential scan of
      `stories` and never opened `idx_scores_raw_offset`. Same rows, so no test
      caught it; `tests/service.rs` now EXPLAINs the boundary probe against
      twenty thousand seeded rows, which is the only way this fails loudly.
    And one that decides whether the expression index is used at all: the
    `::double precision` casts in `RAW_OFFSET` must stay **character-identical**
    to the ones `db.rs` builds `idx_scores_raw_offset` on. A bare `0.5` is
    `numeric`; the two expressions then differ after type resolution and the
    planner silently ignores the index.
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
  votes, so `reset_models()` (`rekorderlig reset-models --yes`) can delete every
  revision and a retrain reproduces it. Votes and `vote_predictions` are left
  alone — they are the record. Reach for it after a change that renames
  features: weights are keyed by feature *name*, so a history spanning a
  tokenizer change diffs vocabularies rather than models, and the round summary
  would report thousands of "new signals" that are the same words renamed.
  It clears `oof_previous` too — a baseline naming a revision about to stop
  existing is worse than none — and drops the round meta, since a round in
  flight was dealt by a model that no longer exists. `TRUNCATE models RESTART
  IDENTITY` does the delete and the renumbering in one statement; nothing
  references `models` by foreign key, which is what makes TRUNCATE safe here. Retrain immediately: an empty models table
  leaves the queue on its cold path. On the live machine:
  `fly ssh console -C "/app/rekorderlig reset-models --yes"`.
- `models` is also append-only and nothing prunes it — 51 revisions came to
  6.3 MB, ~124 KB each and growing with the vocabulary. Not a problem at a
  round per sitting; it will want a retention rule before it is one.
  Pruning is a plain `DELETE FROM models WHERE rev <= N` (plus `VACUUM`) and
  needs nothing else: `scores` all carry the current rev, `oof_scores` /
  `oof_previous` hold only the last two trains, and the identity sequence keeps
  its own high-water mark past the surviving max. Done once, on 2026-08-29:
  revs 1–48 (374–416 votes, all trained on 2026-08-25) were the **per-vote
  retrain era** from before rounds — one revision per swipe, an hour of them,
  and the accuracy they charted was the consequence of nothing. Rev 49 (417
  votes) was kept deliberately: it is the model the first round was dealt from
  and the baseline that round's summary pairs against. Rev 50 (429 votes) is
  the first round-boundary train, which is where the learning curve now starts.
  Cutting the flat early climb (57% → 65%) also cut the headline's best number,
  by design: "up 2 points since 417 votes" is the rounds-era slope, and the
  11-point one it replaced was mostly the model finding its feet.
- Reposts are **not** special-cased anywhere. A vote binds to the submission it
  was cast on, every vote is one training example, and a duplicate submission is
  just another title to judge. The model reads titles, so a twin's differently
  worded title was never something you judged — deduping by URL would have put
  words in your mouth. Don't reintroduce it.
- Routine fetching has exactly one path: today and a year of history are the same
  `syncDays()` walk over a different list of days — the only difference is the
  list. Every day in that list is fetched; nothing is skipped for looking
  covered already, so recent days stay honest at the cost of requests. Don't
  split it back into a rolling job and an archive job — that split is what this
  replaced. (A `sync_days` ledger of completed days would make a backfill
  resumable again; that is the intended successor, not a second code path.)
- **Repair is the one exception**, and it is a second *source*, not a second
  sync: `src/firebase.rs` reads HN's official item API, because Algolia's index
  can silently lose stories and never backfills them. Verified: 2026-08-23
  15:00 UTC → 2026-08-24 19:00 UTC, Algolia indexed 54–58% of the ids HN minted
  (a stable 87–90% on every other day), losing 216 of 701 live stories on the
  23rd and 546 of 1130 on the 24th, while HN itself minted ids at a normal rate
  throughout. A refetch through `sync()` cannot recover any of it — Algolia
  returns the same partial day forever.
  The two sources stay far apart on purpose. Algolia answers "the top stories
  of a day" in ten requests and is the only way stories routinely arrive;
  Firebase can only answer per id, so a day costs ~11k requests and about two
  minutes. That makes it a command (`rekorderlig backfill`) and never a timer, an
  endpoint or part of `sync()`. It is deliberately **not** wired into
  `fetchStory()` either, so `POST /api/import/vote` still fails on a story
  Algolia lost until a backfill has put it in the corpus.
  `--dry-run` makes the same command the audit: live stories on HN versus what
  the corpus holds, writing nothing. That is how a suspected gap gets confirmed
  before it gets repaired.
- Handlers return `Err(http_error(status, msg))` for deliberate 4xx; anything
  else (a panic — the database queries `expect()`) is caught per request and
  becomes a 500. Nothing may escape a request handler and kill the worker.
- Prefer small, named features and comments that state *why* a number is what it is.

## Testing

`cargo test`, plus `node --test tests/*.test.mjs` — CI runs both.

The Rust tests need a Postgres server: `docker compose up -d` brings up the one
CI uses, or point `REKORDERLIG_TEST_PG` at another (host and port only, no
database). `TempDb` creates and drops a database per test — `cargo test` runs
in parallel, so one shared database would race, exactly as one shared file did.
There is no "skip if no server" path: a suite that silently tests nothing is
worse than one that will not start.

- `tests/reconnect.rs` — the dead socket, deliberately. Fly suspends the app
  machine, so the first statement after a visit meets a connection that closed
  hours ago; untested, that is a 500 on every wake, and it always works on
  reload, so it would read as flakiness. Writing this test is what found that
  `Error::is_closed()` is *not* enough — a backend killed under us surfaces as
  a plain `ConnectionReset`, and the rule that actually holds is "the server
  answered (a SQLSTATE) or it did not (an I/O error)".

The front end is tested by **running it**. `tests/helpers/dom.mjs` is a DOM stub
— element identity per selector, a child tree with readable text, classes,
`hidden`, firable handlers, `history` and `fetch` — which is enough to boot the
real module graph and check what it does. One `mount()` per file, because only
the entry point can be re-imported under a fresh query string; its dependencies
resolve without one and stay cached, so a second mount would leave handlers
bound to the first mount's nodes. `mount()` refuses it rather than let that
confuse anyone, and boot scenarios live in files of their own
(`boot-token.test.mjs`, `boot-unauthorized.test.mjs`).

It is a stub, not a browser: no layout, no CSS, no selector matching, no
bubbling. Assertions needing those do not belong in it.

- `app.test.mjs` — what reaches the feed request, and which navigations push
  history rather than replace it.
- `reveal.test.mjs` — the line shown after a swipe.
- `feed-params.test.mjs`, `certainty.test.mjs`, `format.test.mjs` — the DOM-free
  modules, imported and called.
- `modules.test.mjs` — the import graph, walked: cycles, view-to-view imports,
  and the leaves staying leaves.
- `styles.test.mjs` — **the only text assertions left**, and only because a
  stylesheet has no behaviour to run: a `CERTAINTY` band needing a matching
  `.verdict.sure-<name>` colour, the deck's zero floor, title overflow. The band
  names are *imported* rather than parsed out of the source, so they cannot
  drift from the table.

`tests/frontend.rs` is gone. It read the front end as text and asserted about
its shape, which is a check that cannot fail the way a test fails: it passes
when the code is renamed around it and passes when the behaviour is wrong but
the spelling is right. One of its helpers grabbed a destructured parameter
instead of a function body and made three assertions unfailable without anyone
noticing. When a rule can be exercised, exercise it; reach for text only for an
invariant spanning two files that nothing at runtime notices breaking, and put
it in `styles.test.mjs` with the reason.

## Deploy

Fly.io: pushes to `main` deploy; every PR gets a preview app
(`.github/workflows/preview.yml`).

**Two apps, and exactly one app machine.** The deploy passes `--ha=false`,
because a deploy that finds no machines otherwise creates two, and `Syncer`
refuses a concurrent run only within its own process — a second machine makes
"one sync at a time" unenforceable. (The model cache revalidates against
`MAX(rev)` and the round lives in `meta`, so those are already safe across
processes; the syncer is the one that is not.) This went unnoticed for as long
as the app had one machine created before the workflow existed: deploys updated
it in place and the create-two default never fired.

`rekorderlig` (`Dockerfile`, `fly.toml`) is the app machine and
holds nothing — no volume, no data — so it can be destroyed and redeployed
without losing a vote. `rekorderlig-db` (`fly.db.toml`) is stock
`postgres:17-alpine` on a volume, publishing **no services**: the only way in
is 6PN, the organisation's private WireGuard mesh, where it answers as
`rekorderlig-db.internal:5432`. Anything outside that mesh — a laptop, a CI
runner — reaches it through `fly proxy`, which is why `scripts/fly-pg-proxy.sh`
exists. `DATABASE_URL` is a secret on the app, since it carries a password.
Not Fly Postgres and not a managed provider: this is a single-user app whose
whole database is tens of megabytes, and the operational surface of anything
larger would dwarf it.

No TLS on that connection, deliberately. 6PN is already encrypted end to end,
and the alternative pulls rustls and a certificate story into a binary whose
whole shape is one static musl file. `connect()` in `src/db.rs` is the one
place that changes if this ever has to cross a public network.

**Backups** are a nightly `pg_dump -Fc` kept as a workflow artifact
(`.github/workflows/backup.yml`). SQLite needed no counterpart — Fly snapshots
the volume daily and the database was one file on it — but a volume snapshot of
a running Postgres is a crash-consistent copy that needs recovery, not a backup
you can read. Ninety days, tied to this repository: a deliberate floor rather
than a plan. Rehearse a restore quarterly; the workflow header says how. A
backup nobody has restored is not a backup.

Machines **suspend** to RAM when idle (`fly.toml`), so the process is frozen
between visits. Nothing in-process fetches on a timer (there is no
`REFRESH_HOURS` any more — a timer that only ticks while awake was never a
freshness guarantee). Keeping the corpus fresh is external, and the outside is
now a **Fly scheduled machine** rather than a GitHub cron: a second machine in
the same app, `--schedule hourly`, running `rekorderlig sync-remote`, which
POSTs `/api/sync` for today (the request wakes the app machine) and waits.
`scripts/fly-sync-machine.sh` owns its shape; `.github/workflows/deploy.yml`
runs it after every deploy.

The PR preview workflow seeds each preview with **production's data**: on first
deploy it creates `preview_pr_<n>` on the same database machine and restores a
fresh `pg_dump` of production into it, then `ANALYZE`s (without statistics the
training queue seq-scans the whole corpus per card — correct, and slow enough
to look like a bug). Every deploy still kicks one plain-curl sync to top up
today's stories; a preview is thrown away and does not want an hourly machine
of its own. The close job drops that database *and sweeps any left behind by
earlier PRs* — the job can be skipped entirely (a fork PR, a failed run, Fly
down), and an orphaned preview database is invisible until the volume fills.
`push-db-to-preview.sh` remains the manual path for refreshing one in place.

Two credentials do the preview work and neither is production's:
`preview_reader` can only read `rekorderlig`, `preview_admin` can only
CREATEDB and owns nothing else. `scripts/fly-db-setup.sh` creates them.
"Read" means tables **and sequences**: `pg_dump` reads `last_value` off every
sequence to restore it, and the identity column on `models` owns one, so a
reader granted tables alone connects fine and the seed dies on
`models_rev_seq`. `scripts/fly-db-secrets.sh` checks, as the owner, that the
reader can SELECT every table and sequence before it sets any secret.

Three properties of that trigger decide how it is maintained, and all three
are why it is a reconciler script and not a one-off command:
- The schedule is an **interval anchored at machine creation**, not a cron
  expression. Recreating the machine moves the run, so the script rebuilds it
  only when the image, schedule, restart policy, command or environment
  actually differ.
- `fly deploy` does not manage it. A schedule cannot be expressed in
  `fly.toml`, and giving it a process group there would have deploy start a
  machine whose whole job is to exit — so it lives outside the deploy, which
  is free to leave it alone, wipe its schedule, or destroy it. The reconcile
  step after each deploy makes all three outcomes the same.
- It is in the **same app** (Fly injects `AUTH_TOKEN` into every machine the
  app owns, so there is no second copy of the secret) and it is a **separate
  machine**. It could reach the database directly now that the database is not
  a file on one volume — it deliberately does not. `sync-remote` is an HTTP
  poke, so the trigger holds no credential and no schema, and the app it wakes
  stays the only writer.

The failure signal moved with it: no red Actions run, but a non-zero exit in
`fly logs`, `lastError` on `GET /api/sync`, and the Brain tab.

## Workflow

Agents never commit to `main`. Work on a feature branch in a git worktree and
open a PR for human review; the PR gets a Fly preview app automatically.

## Keeping this file current

When you change something this file describes — file responsibilities, the
retrain/scoring flow, conventions, test setup, deploy — update CLAUDE.md in the
same change.
