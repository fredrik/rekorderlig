# CLAUDE.md

Personal Hacker News recommender: thumb titles up/down, a small logistic
regression learns your taste, the feed reranks. One process, a handful of
users: each signs in with a login link and everything downstream of a vote
is theirs — `docs/multi-user.md` is the plan and the record of it.
README.md is the full product description; this file is orientation for
agents. It states the rules tersely on purpose — the reasoning lives in
`docs/design/` (index at the bottom) and in comments beside the code.

## Shape

- Rust (one binary, `rekorderlig`), synchronous throughout — nothing in this
  crate is `async`. Postgres via the sync `postgres` crate, HTTP server via
  `tiny_http`, HTTP client via `ureq`; the dependency list ends there plus
  serde/url/unicode-normalization (and `bytes`, already in the tree, named
  only so the `User` newtype's hand-written `ToSql` can spell its buffer).
- No frontend build step in development: `public/` is served as-is (vanilla
  JS, one `app.js`). The **image** ships those same modules as one minified
  chunk — `scripts/bundle-frontend.sh` (esbuild, pinned) writes it over
  `app.js` in the Dockerfile's `web` stage, so `index.html`, the tests and a
  dev server all keep naming `/app.js`. It buys the request count first: a
  cold visit is 3 requests instead of 18.
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

`src/` is the Rust binary (one file per concern — features, model, db, the
two HTTP sources, the two background threads, the server, the CLI);
`public/` is the front end (one module per view, plus the shared
DOM/state/router/chrome layer); `scripts/` holds the Fly, database and CI
tooling. Each file's own header comment states what it owns — read that
first, not this file, for what a specific file does.

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
- **The learning curve is columns, never the payloads.** `accuracy`,
  `baseline`, `noise` and `n_features` sit on `models`, written by
  `train_and_score` from the same values that go into the JSON. Reading them
  back out with `payload::jsonb #>> …` is what made `/api/history` the app's
  slowest read — one 124 KB parse per expression per row, ~680 ms at 120
  revisions against 0.3 ms for the columns. Nullable, because `metrics` is.
  Anything else the curve grows wants a column too, not a cast.
- **An invite is a row, and it does not know who will open it.** `invites`
  is the ledger: `note` (the operator's own bookkeeping, shown to nobody),
  `created_at`/`expires_at`, `invited_by` — who sent it — and then
  `redeemed_at`/`revoked_at`/`user_id` — whether it was taken up, and by whom.
  Two references to `users`, and they answer different questions; `invited_by`
  is NULL when the **operator** minted it, which is the honest answer rather
  than a gap, since the operator has no user row. `POST /invite/<token>` claims it and
  **mints the user** in one transaction; that is the only route that creates
  a user without the operator. Single-use by construction (`redeemed_at` is
  a timestamp, not a counter), a week like a login link. Voiding is
  `revoked_at`, so the decision is on record; a row with a user behind it is
  never deleted, and `invite remove` takes only rows nobody is left of
  (`user_id IS NULL`: unopened, or the user since removed). No
  `email` column and no `updated_at`: an invite cannot know the address, and
  a generic mtime would only ever restate `created_at` or `redeemed_at`.
  A redeemed invite cannot be voided — the door it opened is a session, and
  `revoke_access` is what shuts that.
- **Any user may invite a friend**, from Brain's Invite panel
  (`POST /api/me/invites`): same row, same week, same doorstep, and the
  ledger records the sender.
- **An invite is composed, not pressed out.** The button opens a card to
  address — `note`, who it is *for* — and the POST that mints the row is the
  card's submit. Nothing reaches the database from opening or cancelling it,
  which is the sending half of the doorstep's rule at the other end: both
  ends of an invite are a deliberate press. The name is the sender's alone
  (the invitee never sees it) and its pay-off is the ledger, which shows it
  beside the name they chose for themselves. `NOTE_MAX` is 60, like
  `display_name`, because it is a name about a person.
- **The cap is shown, not just enforced.** All three of a user's invite routes
  answer `{invites, cap: {max, left}}` — one shape, one paint (`paintInvites`)
  — so the five pips can never disagree with the rows. A disabled button is
  the courtesy; `INVITES_OUTSTANDING_MAX` in the POST is the rule. A user sees and voids **only their own**
  (`list_invites_by`, and the scoped `revoke_invite` — leave `invited_by` out
  of either predicate and one friend's list is everybody's); the whole ledger
  stays the operator's `/api/invites`. `INVITES_OUTSTANDING_MAX` (5) caps how
  many *live* invites one user may have out — taken-up ones are people, not
  outstanding links — because any user minting invites is any user minting
  users. The operator is not capped.
- **A user is a row; a credential is a session.** `users` holds `display_name`
  (nullable, not unique, the user's to set — the CLI addresses a user by id
  or email, never by name) and `email` (nullable, unique on `lower()`, the
  one personal column). A **login link** (`login_links`: a week, counted
  uses, one for a person) is spent at `POST /login?t=` for a **session**
  (`sessions`: a year, one per device, revocable one at a time or all at
  once); both tables hold `sha256(token)`, never the token, because every
  preview is a copy of production. No passwords: the reset flow of a password
  system *is* a magic link, so passwords would be that plus a hashing crate,
  a form and brute-force defence. Email delivery is a transport for a link,
  not a mechanism, and is not built yet — the operator pastes links into a
  chat. The design for building it is `docs/design/email.md`.
- **A door opens on a POST, never a GET.** A GET at `/login?t=` or
  `/invite/<token>` only peeks (`peek_login_link`/`peek_invite`, reads) and
  shows `public/doorstep.html` — or the shut door if the link is dead; the
  POST its one button makes is what spends the token. Slack, iMessage and
  their kind fetch every URL pasted into a chat to preview it, and on
  2026-09-04 that fetch took up two invites and minted two nameless users;
  under a login link it would have walked off with a year-long session.
  Previewers do not submit forms. The form has no `action` and no fields:
  it posts to the URL the page was loaded from, GET parameters included, so
  the token never has to be written into the page.
- **Being turned away is a page, not a paragraph.** No session (or a spent
  login link) gets `public/signed-out.html` under a 401: the app's header and
  card, the two ways in, and the two reasons picked apart by `data-reason` on
  the root element, so every word of the copy stays in the HTML.
  `PUBLIC_FILES` in `src/server.rs` is what an unauthenticated request may
  still have, and it is one file: the stylesheet the page (and the doorstep)
  wears. Nothing else under `public/` opens up, and `/api/` still answers the
  JSON 401 the front end reads.
- **The door names both ways in, and never only the invite.** An invite mints
  an account; a login link returns you to the one you have. So a signed-out
  reader who already has an account is told to get a link — from **Brain →
  You → Add a device** on a device still signed in, or from the operator —
  and only somebody who never signed up is told to ask for an invite; the
  page says why, because taking up an invite you did not need splits your
  votes across two accounts and neither model has learned you. Until a user
  can mail themselves a link (a route that takes an address, not built), a
  reader signed out on every device has to ask.
- **The operator is not a user.** `AUTH_TOKEN` as a Bearer may sync and hit
  `/api/invites` and `/api/users`; every user route answers it 403 (the role was wrong, not the
  credential — a 401 would send a browser off to find a login link). With
  `AUTH_TOKEN` unset an anonymous request is user 1, unless a live session
  cookie says otherwise.
- **Previews scrub `users.email`, `sessions`, `login_links` and `invites`** on seed
  (`preview.yml`): a copy of production must not know anyone's address or
  admit anyone's cookie. The preview's own way in is a shared link for user 1
  minted through the operator endpoint.
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

- **One voice.** The reader is *you*, never *we*. The model is **Brain** when
  it is a party in a sentence (the reveal, the round summary, the Votes flag)
  and *it* inside the Brain tab, where the tab name is the antecedent. Scores
  are percentages wherever a reader meets them. Anything that stands alone
  on screen is a sentence; a fragment is for chips, labels and tallies. A
  server 4xx a view can trigger is written for the screen, because
  `api()` shows `error` verbatim — and the 401 and a body with no `error`
  are put into words there. `docs/design/frontend.md` has the reasoning.
- **One module per view, and views never import each other.** Cross-view
  reach goes through `registry.js` hooks; `tests/modules.test.mjs` fails a
  cycle, a view importing a view, and a leaf growing a dependency.
- **The bundle is an image artifact, never a checked-in file.** `public/` in
  git is the module graph, and stays what a dev server serves and what the
  front-end tests boot; the shipped chunk is built by
  `scripts/bundle-frontend.sh` in the Dockerfile and in `tests.yml`, and
  never committed — a generated copy of the whole front end beside the
  original is a second thing that can be wrong, and it would sit in the
  directory `tests/modules.test.mjs` reads as the graph, where a
  self-contained chunk passes every rule without meaning anything.
- **The welcome flow is a view, entered from a fact rather than a URL.** It is
  a section like the other five and the router owns it — but `displayName`
  being null is what an invite mints, and the server's answer is the one that
  decides, so `onboardingRoute()` answers in both directions at boot: a
  nameless user gets it whatever link they came in on, and everyone else gets
  the app if they land on `/onboard`. Decided once, at boot, so a `/api/stats`
  poll cannot throw a reader on screen two back to screen one. The tab bar goes
  while it runs (an onboarding you can click past is a prompt). It ends by
  handing off to Train's ordinary round: there is no tutorial round, which
  would need explaining too.
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
- **Nothing in the app fetches**, and no view should grow a control that
  does. `POST /api/sync` is the hourly machine, the preview seed and any cron.
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

`cargo test`, plus `node --test tests/*.test.mjs` — both run in
`.github/workflows/tests.yml`, the one reusable job called by `CI` on a
pull request and by `Deploy` before it ships. Adding a test command means
editing that file, not two. That job also builds the front-end bundle and
throws it away: the tests run the modules, so nothing else would notice an
import that stopped resolving until the deploy tried to build it.

`docs/design/testing.md` covers what each test file actually checks — the
Postgres fixture, the migration/reconnect/invite tests, and why the front
end is tested by running it rather than by reading its source.

## Deploy

Fly.io: pushes to `main` deploy; every PR gets a preview app
(`.github/workflows/preview.yml`). Both deploys pass `GIT_SHA`/`BUILD_TIME`
build args so the binary knows which commit it is (`src/version.rs`); the
answer shows on Brain's Data panel, the boot log, and `GET /api/stats`.

- **Nothing reaches production untested.** `deploy` in `deploy.yml` `needs:` a
  `test` job that calls `tests.yml`, so the commit on `main` is the commit the
  tests ran on. `ci.yml` triggers on `pull_request` only — a `push: [main]`
  trigger there would be a test run standing beside the deploy instead of in
  front of it. Previews are deliberately ungated: a broken one is thrown away.
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
  `GET /api/sync`, and a stale "last fetched" line in the Brain tab — not
  in Actions.
- `fly logs` carries one line per request (`access_line` in
  `src/server.rs`), so a client stuck in a request loop, or a route that got
  slow, is readable after the fact. Handler failures still get their own
  `[METHOD /path] message` line beside it.
- **Backups**: nightly `pg_dump -Fc` workflow artifact, 90 days
  (`.github/workflows/backup.yml`). Rehearse a restore quarterly; the
  workflow header says how.
- Previews get `preview_pr_<n>` on the same database machine, seeded from a
  prod dump with emails and credentials scrubbed, then `ANALYZE` (without
  statistics the queue seq-scans per card); the deploy then mints a shared
  login link for user 1 through the operator endpoint and comments it. The
  close job drops the database and sweeps orphans. The preview credentials
  (`preview_reader`, `preview_admin`) cannot touch production — keep it that
  way; a reader's grant must cover tables **and sequences**, or `pg_dump`
  dies on whichever one the schema has (`users_id_seq` today).

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
| `docs/design/deploy.md` | the tests in front of the deploy, two apps, backups, previews, the sync trigger's three properties |
| `docs/design/email.md` | mailing a login link: what Fly gives it (secrets per app, `FLY_APP_NAME`, no mail primitive), HTTPS to a provider over `ureq`, the work off the request thread, the door's form, the fifteen-minute link — a plan, not yet built |
| `docs/design/feed-url.md` | the feed's URL contract, letter by letter |
| `docs/design/frontend.md` | the module graph, the registry, testing by running, never asserting on source text |
| `docs/design/judging.md` | what a card may show, the reveal's wording, certainty bands, held-out scores |
| `docs/design/models.md` | derived data, the 2026-08-29 pruning, tokenizer edges, reposts |
| `docs/design/queue.md` | the stratified sample; seek-never-scan and the planner traps |
| `docs/design/rounds.md` | why rounds exist, where they live, how a summary gates an accuracy move |
| `docs/design/sources.md` | Algolia vs Firebase, one sync path, repair, vote import |
| `docs/design/testing.md` | what each test file checks, the Postgres fixture, testing the front end by running it |

`docs/multi-user.md` is the multi-user plan: what a user is (and why not a
password), what an invite is (and why it does not know who will open it), the
schema, the phases. Phases 1–3, 5 and 6 (friends inviting friends) are in;
what remains is the cutover on production (phase 4) and, later, mailing a
link (`docs/design/email.md`).

`docs/postgres-migration.md` is the SQLite → Postgres migration plan as
executed — the record of a finished change, not a live topic, but read its
"what the plan did not predict" list before touching the database layer.

## Keeping this file current

A changed file's responsibilities are its own header comment's job, not
this file's — update the header, and CLAUDE.md needs no edit for it. A new
file brings its own header and needs no new row anywhere. When you change
something this file states as a rule — the retrain/scoring flow, judging
UI, deploy, workflow — update CLAUDE.md in the same change, and the
matching `docs/design/` file with it. New rules state themselves here in a
line or two; if the justification or the how-it-works detail needs more
than that, it goes in `docs/design/` (add a row to its table above, kept
sorted by file name) and only the rule stays here.
