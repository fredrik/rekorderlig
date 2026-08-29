# CLAUDE.md

Personal Hacker News recommender: thumb titles up/down, a small logistic
regression learns your taste, the feed reranks. Single user, single process.
README.md is the full product description; this file is orientation for agents.

## Shape

- Rust (one binary, `rekorderlig`), deliberately synchronous — no async runtime.
  SQLite via `rusqlite` (bundled), HTTP server via `tiny_http`, HTTP client via
  `ureq`; the dependency list ends there plus serde/url/unicode-normalization
  (the Node version's "zero npm dependencies" spirit, translated).
- No frontend build step. `public/` is served as-is (vanilla JS, one `app.js`).
- One SQLite file (`data/rekorderlig.db`, WAL). Schema lives inline in `src/db.rs`;
  there is no migration system — only `CREATE ... IF NOT EXISTS`. The schema and
  the `models.payload` JSON are byte-compatible with what the Node backend wrote,
  so a production database predating the Rust rewrite opens unchanged.

## Where things are

| File | Owns |
|---|---|
| `src/features.rs` | title → named sparse features. Names are human-readable on purpose (`w:rust`, `dom:github.com`) — never hash them, the UI shows them back. |
| `src/model.rs` | logistic regression (AdaGrad, L2, class-balanced), score shrinkage toward 0.5, 5-fold CV, insights. Deterministic: same votes → same weights (`mulberry32` is public for anything else that needs a seeded draw). Beside the aggregates, `crossValidate()` returns `heldOut` (the per-example out-of-fold score, keyed by the `id` the caller attached), `foldAccuracy`, and `noise` — the band on *one* accuracy figure, being the larger of the fold spread (sample sd: five draws, and the population form is biased low, always towards calling a wobble real) and an Agresti-Coull standard error. Gating a *move* needs a wider band than this; see `accuracyMove()`. |
| `src/http_client.rs` | the one JSON fetch (`HttpFetcher` behind the `Fetch` trait, which tests fake), with the retry rule both sources share (retry 429/5xx and transport errors, give up at once on a 4xx). Extracted so `firebase.rs` didn't fork a copy. |
| `src/firebase.rs` | HN's official item API, used for one job only: recovering stories Algolia's index never got. `normalizeItem()` (→ the same story shape `upsertStory` takes, `null` for comments/jobs/polls/`dead`/`deleted` — those are ~11% of any id range and are not losses), `idRangeForDay()` (bisects Firebase's own `maxitem` for a day's id bounds, ~26 requests, so the index whose gaps we're repairing never defines the range to repair; padded by `ID_PAD` because item time is only *nearly* monotonic in id, and each item's own timestamp decides its day), `backfillDays()` (walks every id, upserts live stories at or above the points floor; bounded concurrency, one transaction per day, a failed id recorded and stepped over like `syncDays`). No diff against Algolia first — an id must be fetched to learn whether it's a story at all. See the repair convention below. |
| `src/hn.rs` | Algolia HN API. `fetchDay()`/`fetchFrontPage()` + `syncDays(conn, days, opts)`, the one loop that puts stories in the database — per-day transaction, failures recorded and stepped over, every day handed in always fetched (there is no skip rule — a covered-looking day is refetched, upserts make that cheap in the database). Pure fetch + `upsertStory`; no meta, no scoring. `fetchStory(id)` looks up one submission (used by the vote import). |
| `src/db.rs` | schema (incl. `oof_scores`, the held-out prediction per vote, `oof_previous`, the same from the train before (what makes an accuracy move testable — see rounds, below), `vote_predictions`, the frozen pre-vote guess, and the two expression indexes the training queue seeks on), `db()` singleton, `openDb(path)` for tests, vote/story queries. `recordVote` stamps now and keeps the original `created_at`; `importVote` lets a restored history's timestamp win, for `updated_at` too — the Votes view reads `updated_at`, so a restore must not read as "voted a minute ago". |
| `src/service.rs` | `trainAndScore()` (train → store snapshot → `rescoreAll()` the corpus) and `scoreMissing()` (score only stories the current model rev hasn't seen — used after a sync, no retrain). `sync()` (the one way stories enter the database: `{days}` or `{from,to}` → `syncDays()` + front page when today is in range + `scoreMissing()` + the `last_sync_at` stamp — never fetch without it, an unscored story is invisible to the feed). `backfill({from,to})` is the repair counterpart: `backfillDays()` + `scoreMissing()`, and pointedly **no** `last_sync_at` stamp, since repairing a historical day says nothing about how fresh the corpus is. `storeHeldOut()` rewrites `oof_scores` whole on every train, so a deleted vote leaves no stale row, shifting the outgoing set into `oof_previous` (SQL-side insert-select) so the next round has a baseline to pair against. One revision back, never a history. `judge()` (capture the prediction, record the vote, report the signals it teaches), the round functions (`dealRound()`, `roundStatus()`, `currentRound()`, `roundSummary()`, `ROUND_SIZE`) and `modelHistory()` (the learning curve: accuracy per *training run*, read out of the stored payloads with `json_extract`; revisions that added no votes are dropped, since a no-op retrain is the same model again and the pre-round table is mostly those). Also `feed()`, `trainingQueue()` (see below), `exploreQueue()` (the Explore deck: same judging loop, opposite selection — a traction bar, `EXPLORE.minPoints` / `minComments`, either one is enough, instead of uncertainty; tiered `probably` (score ≥ 0.6) before `possibly` (≥ 0.35), with a clear no dropped outright), `voteLog()` (the Votes view's history list, which serves `oof_score` beside the stored one), `explain()`, `stats()` (which embeds `scoreDistribution()`: the unvoted-corpus histogram shown in Brain, binned in SQL over the stored score). Holds the module-level model cache (`resetModelCache()` in tests). Feed filtering/sorting/paging is done **in SQL** — keep it there. `feed()` takes `minScore`/`maxScore` (exclusive) so a histogram bar in Brain can open exactly its bucket. |
| `src/trainer.rs` | background training: `Trainer::request()` spawns a thread with its own DB connection; one run at a time, a trigger mid-run coalesces into a single follow-up run. `status()`, `wait_idle()` (tests). |
| `src/syncer.rs` | background fetching: `Syncer::request(opts)` spawns a thread with its own DB connection; one run at a time, a request mid-run is refused as `busy` (options can't be coalesced). `status()` streams the current day, `wait_idle()` (tests). |
| `src/server.rs` | routes table, optional `AUTH_TOKEN` auth, static files. Nothing fetches on a timer — `POST /api/sync` (202) is the only trigger, driven by cron or the Brain tab. Training's shape lives here too: `GET`/`POST /api/round` (resume or deal), `GET /api/round/summary` (what the finished round changed; also marks it spent), `GET /api/history` (the learning curve). `GET /api/queue` still serves a raw stratified draw and is what the round is dealt from. `GET /api/explore` is the Explore deck's pool, and ships the traction bar along with the cards. |
| `src/main.rs` | subcommands: `serve` (the HTTP server; Docker's CMD) and the CLI companion — `sync` / `backfill` (`--from`/`--to`, `--dry-run` to audit without writing) / `train` / `stats` / `reset-models` (forget every trained model and retrain from the votes; insists on `--yes`). Flags: run with an unknown command (e.g. `rekorderlig help`) to get the usage line. `src/dates.rs` holds the UTC day arithmetic (`dayKey`, `daysBetween`) both sources share; `src/lib.rs` re-exports the modules so integration tests drive the same code the binary runs. |
| `public/format.js` | numbers into words (`pct` — never 0% or 100%, the model is a guess; `plural`, `ago`, `scoreColor`). No DOM, no state. |
| `public/certainty.js` | the `CERTAINTY` bands and `certainty()`: how sure a call was, in words, on its *strength* (0.5–1) and never on P(yes). No DOM, no state. Each band's `name` needs a matching `.verdict.sure-<name>` colour in `styles.css` — the one thing here no test can run, so `tests/frontend.rs` holds the two files to each other. |
| `public/feed-params.js` | the feed's filters to and from the URL (`FEED_DEFAULTS`, `FEED_PARAM`, `readScore`, `readFeedParams`, `feedParams`). A parser: it decides what a link means. No DOM — the mode list is passed in rather than read off the chips, which is what lets tests import it. |
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
| `public/feed.js` | the ranked list and its filters. `setFeed()` is the one way a filter moves (write URL → `paintFilters()` → reload); `paintFilters()` is the one paint path. Registers `url` and `adopt`, which is how a bookmarked `/feed?s=70-75` opens filtered. |
| `public/votes.js` | the history list, and the held-out score shown only when it contradicts the verdict by more than `CONFLICT_MARGIN`. |
| `public/brain.js` | the model panels, the learning curve, the score histogram and the stories-per-day chart, plus the fetch and export buttons. Clicking a histogram bar **navigates** to `/feed?s=70-75` rather than calling into the feed — Brain has no business knowing how the feed keeps its state, and a bucket is a place the back button should return from. |
| `scripts/push-db-to-preview.sh` | copies a snapshot the other way: `fly sftp put` into a preview app's volume, `integrity_check` on the far side, then `mv` over the live file and a machine restart (a running SQLite holds the old inode). Refuses any app whose name isn't `*-pr-*`, and chmods the copy writable — the local snapshot is read-only and the mode rides along. |
| `scripts/pull-prod-db.sh` | copies the production database into `data/`: wakes the machine, `VACUUM INTO` through the `sqlite3` CLI the image ships, `fly sftp get`, then removes the temp copy from the volume. The local copy is read-only on purpose — it is a snapshot, copy it before using it as a working database. |

## Conventions

- Everything is synchronous around SQLite. Voting only records the vote; the
  last card of a round triggers one `POST /api/train`, which returns 202
  immediately and runs `train_and_score()` on a background thread (`trainer.rs`) with
  its own DB connection, so the request path never blocks on a rescore of the
  whole corpus (~50k stories, about 0.6 s). **A round boundary is the only retrain trigger** — no
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
  `tests/frontend.rs` holds the two files to that.
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
  the browser fetches the rest. Note `serve_static` sends `cache-control:
  no-cache` with no `ETag`, so every load refetches all of them.
- **The feed's filters live in the GET parameters.** A filtered feed is a place:
  bookmarkable, linkable from the phone to the laptop, and reachable with the
  back button. `state.feed` is the parsed form of `?mode=&days=&minScore=…` and
  is never the source — `setFeed()` folds a patch in, writes the URL, repaints
  the panel from it and reloads, so the chips and the list cannot disagree.
  Three rules keep it honest:
  - **One letter each, and only non-defaults are written**: `?m=top&d=30&c=50&v=1&q=rust`,
    and the common case is a bare `/feed`. State keys stay spelled out — only
    the address bar is terse. `FEED_DEFAULTS` is the single declaration of what
    a filter is and `FEED_PARAM` maps each to its letter; a value that fails to
    parse falls back rather than reaching the API as `NaN` or as a mode the
    server doesn't switch on. A hand-edited link normalizes on arrival, since
    boot writes `urlFor()`'s canonical form back. `tests/frontend.rs` holds the
    two tables and `loadFeed()`'s request to the same key set, and holds the
    letters distinct — an unlettered filter never round-trips, and two filters
    sharing a letter give you a bookmark that applies the wrong one.
  - **`s` is the one letter carrying two values**: `s=70` is the slider's floor,
    `s=70-75` a bucket clicked out of the Brain histogram. A bucket **implies
    its own context** — all time, no traction floor — because the histogram
    counts the whole unvoted corpus and a 7-day window would show nine stories
    where the bar promised twelve hundred. That is what keeps `?s=70-75` from
    spelling out `d=0&c=0` beside it; an explicit `d`/`c` in the link still
    wins. An inverted or unparseable range is rejected whole rather than
    half-applied.
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
  votes, so `reset_models()` (`rekorderlig reset-models --yes`) can delete every
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
  `fly ssh console -C "/app/rekorderlig reset-models --yes"`.
- `models` is also append-only and nothing prunes it — 51 revisions came to
  6.3 MB, ~124 KB each and growing with the vocabulary. Not a problem at a
  round per sitting; it will want a retention rule before it is one.
  Pruning is a plain `DELETE FROM models WHERE rev <= N` (plus `VACUUM`) and
  needs nothing else: `scores` all carry the current rev, `oof_scores` /
  `oof_previous` hold only the last two trains, and `sqlite_sequence` keeps
  AUTOINCREMENT numbering past the surviving max. Done once, on 2026-08-29:
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

The front end is tested two ways, and the first is preferred wherever it reaches.
**`tests/*.test.mjs` import a module and run it** — `format.js`, `certainty.js`
and `feed-params.js` are DOM-free for exactly this reason, and anything else
pulled out of `app.js` should be. That is what found the one real bug this class
of test has caught: `Number(null)` is 0, a valid `d` and a valid `c`, so a
missing parameter parsed as a real value and a bare `/feed` loaded all-time with
no traction floor.

`tests/modules.test.mjs` is the same idea applied to the split itself: it parses
the imports out of `public/*.js` and walks the graph, so a cycle is *found*
rather than guessed at. Cycles matter more than they look — ES modules tolerate
them until one binding is read during initialisation and is still in its
temporal dead zone, which is a bug that shows up on one page load in one
browser once the file order shifts.

**`tests/frontend.rs` reads source as text**, because the view modules touch
`document` at load and there is nothing to import. These are tripwires: they
assert the *shape* of the source, not behaviour, and they can pass while broken
(a helper that grabbed a destructured parameter instead of a function body once
made three of them unfailable). Reach for one only when there is no way to run
the code — a genuine cross-file invariant like a `CERTAINTY` band needing a
colour in `styles.css`, or statement order that nothing observable depends on.
When logic can be moved into a module and imported instead, move it.
 Unit tests live beside the code (`features.rs`, `model.rs`,
`dates.rs`); integration tests in `tests/` use self-cleaning temp DBs under
`tests/data/` — one per test, because `cargo test` runs in parallel (the Node
suite ran serially and shared one). The API tests start a real server on port 0
via `server::serve()` with an explicit `App` (db path, public dir, auth token) —
no env-var singletons to arrange. `mulberry32` was ported bit-for-bit, so seeded
behaviour (the training shuffle, queue probes) matches the Node backend. Add a
test with every behavioural change; the API tests are cheap.

## Deploy

Fly.io (`Dockerfile`, `fly.toml`): pushes to `main` deploy; every PR gets a
preview app (`.github/workflows/preview.yml`). Data on a 1 GB volume at `/data`.

Machines **suspend** to RAM when idle (`fly.toml`), so the process is frozen
between visits. Nothing in-process fetches on a timer (there is no
`REFRESH_HOURS` any more — a timer that only ticks while awake was never a
freshness guarantee). Keeping the corpus fresh is external:
`.github/workflows/sync.yml` POSTs `/api/sync` hourly for today's stories —
the request wakes the machine — then polls until the run finishes and goes
red when a day fails (needs the `AUTH_TOKEN` repo secret to match the app's).
The PR preview workflow seeds a fresh volume the same way, right after deploy.

## Workflow

Agents never commit to `main`. Work on a feature branch in a git worktree and
open a PR for human review; the PR gets a Fly preview app automatically.

## Keeping this file current

When you change something this file describes — file responsibilities, the
retrain/scoring flow, conventions, test setup, deploy — update CLAUDE.md in the
same change.
