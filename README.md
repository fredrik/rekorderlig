# rekorderlig

A personal Hacker News recommender. Thumb titles up or down and it learns what
you want to read, then ranks, filters and explains the firehose for you.

No passwords, no tracking, no third-party services: one Rust binary, one
Postgres database, and a model small enough to show you its own weights.
A handful of people can share the one instance — each gets in with a login
link, and each brain is private.

```
docker compose up -d                    # a local Postgres on :5432
createdb -h localhost -U postgres rekorderlig
cargo run --release -- sync --days 10   # pull ~2,800 recent stories from the HN API
cargo run --release -- serve            # → http://127.0.0.1:4173
```

Vote on a dozen titles and the **Feed** tab starts reordering itself.

## The tabs

**Train** — one title at a time. Press `→` for yes, `←` for no, `↓` to skip
(or use the buttons). Once a model exists the deck shows the stories it is
*least sure* about, because a vote there teaches it the most.

**Explore** — the same one-card judging loop as Train, over a pool the crowd
already filtered: a story only appears if it reached 50 points or 25 comments.
Cards arrive in two tiers, marked on the card — **probably for you** (the model
scores it 0.60 or higher) first, then **possibly** (the model has no strong
opinion; the crowd is why it is there). Anything the model reads as a clear no
(below 0.35) is dropped however popular it got. Range chips pick how far back
the pool reaches. Before a model exists the tiers collapse into pure crowd
order — most discussed first. Votes cast here are ordinary votes; like a vote
cast in Feed, they are trained on when the next Train round finishes.

**Feed** — everything it knows about, ranked. Four orders: **For you** (pure
taste), **Blend** (taste plus crowd activity), **Most commented** (taste
ignored) and **Newest**. A *min match* slider hides anything below a threshold;
every row shows a match percentage, and `why?` lists the terms that moved it.

**Votes** — every verdict you have cast, newest first, one card per story with
the vote marked yes, no or skipped. Filter by verdict; change or remove a vote
inline and it retrains like anywhere else — this is also where a mis-swipe in
Train gets fixed.

**Brain** — what it learned, in words: the sites, phrases and topics pulling
you in or turning you off, plus an honest accuracy number. Also where you fetch
stories, retrain, and export votes as JSON.

## How it learns

Each title becomes a sparse bag of readable features: words and word pairs
(lightly stemmed, hyphens split), the domain and its registrable parent, the
submitter, and a few style flags (Show HN, question, contains a year, length).
An L2-regularised **logistic regression** trained with AdaGrad SGD fits them
against every vote you have cast.

Three details matter more than the algorithm:

- **Nothing is hashed.** Every weight can be shown back as "you like `rust`,
  you avoid `techcrunch.com`". A recommender you can argue with beats a
  slightly better one you can't.
- **Scores shrink toward 50% by evidence.** Logistic regression on 20 votes
  will claim 99% certainty; the displayed number is pulled back by how much of
  the title the model has seen before and how many votes exist, so early
  guesses look like guesses. Regularisation scales with dataset size too.
- **Both classes are weighted equally**, so 90 downvotes and 10 upvotes don't
  collapse into "predict no for everything".

Accuracy in the Brain tab is 5-fold **cross-validation** on your votes, shown
against the majority-class baseline. On a simulated but consistent taste over
2,768 real stories:

| votes | accuracy | AUC | log loss |
|------:|---------:|----:|---------:|
|    20 |    85.0% | 0.87 | 0.61 |
|    50 |    86.0% | 0.94 | 0.49 |
|   120 |    90.8% | 0.95 | 0.39 |
|   240 |    93.3% | 0.98 | 0.28 |
|   312 |    94.2% | 0.99 | 0.25 |

Votes are recorded as they are cast. Finishing a Train round with at least one
yes or no explicitly triggers a single background training run over all current
votes. If more training requests arrive while that run is active, the trainer
coalesces them into one follow-up run. Each fit and full rescore of the corpus
runs on a background thread so the app never stalls. On 2,000 votes it takes
well under a second.

## Commands

One binary, subcommands (`cargo run --release --` in development,
`/app/rekorderlig` on the deployed machine):

```
rekorderlig serve              # web app on $PORT (default 4173, 127.0.0.1)
rekorderlig sync --days 14     # fetch the last N days (--pages 10 → ~1000/day)
rekorderlig sync --from 2026-01-01      # fill the archive from a date to today
rekorderlig train              # retrain and print what it learned
rekorderlig stats              # corpus and model summary
cargo test                     # unit + integration tests
```

### Fetching stories

One command does all of it. `sync` walks a list of days, asks the Algolia API
for the top stories of each and upserts them; `--days N` walks the last N
(default 2), `--from`/`--to` an explicit range. There is no second code path
for history — a year-long fill is the same walk with a longer list:

```
rekorderlig sync                                # today and yesterday
rekorderlig sync --days 14                      # the last two weeks
rekorderlig sync --from 2026-01-01              # everything since new year
rekorderlig sync --from 2026-01-01 --to 2026-03-31
```

Each day commits in its own transaction, one Algolia request per page of 100
stories (`--pages 10`, so up to ~1000 stories a day), pausing 250 ms between
days (`--throttle`). A quiet day costs fewer requests than the ceiling — the
walk stops at the API's last page. Only stories with at least **3 points** are
asked for (`--points`, `0` disables), so a slow starter is picked up on a later
run once it crosses the bar. Every day handed in is fetched: there is no skip
rule, because a day that only partly landed looks the same as a quiet one and
points and comment counts keep moving. Upserts make a refetch cheap in the
database, so a rerun is **idempotent** — but it is not free, it pays full
price over the wire. A day that fails after its retries is logged, stepped
over, and makes the job exit non-zero, so an interrupted run can always be
finished by running it again. A year-long fill is ~3650+ requests and 20+
minutes, and ~70k stories add a few tens of MB. Newly fetched stories are
scored on the way in, against the current model — no retrain.

The current front page is fetched too, but only when today is in range: it is
the one thing a day query can miss, and pointless for an archive fill.

The app never fetches on its own — the machine suspends between visits — so
freshness comes from outside. On Fly that outside is a **scheduled machine**: a
second machine in the same app that Fly starts once an hour to run
`rekorderlig sync-remote`, which POSTs `/api/sync` for today's stories (the
request is what wakes the app machine), polls `GET /api/sync` until the run
finishes, and exits non-zero if a day failed. `scripts/fly-sync-machine.sh`
creates it, and the deploy workflow runs the same script afterwards to put it
back if a deploy disturbed it:

```
scripts/fly-sync-machine.sh              # create or repair it
scripts/fly-sync-machine.sh --dry-run    # say what it would change
fly logs -a rekorderlig --machine <id>   # what the last runs did
```

It is a separate machine, and it pokes the app over HTTP rather than writing
to the database itself. It could reach the database directly — that is no
longer a file on one machine's volume — and deliberately does not: as an HTTP
trigger it holds no credential and knows no schema, and the app it wakes stays
the only writer. It is in the *same app* because Fly injects the app's secrets into every machine it owns, so the
trigger picks up `AUTH_TOKEN` with no second copy to keep in step.

Three things to know about it. Fly's schedule is an interval anchored at
machine creation, not a cron expression — "hourly" means about every hour from
whenever the machine was made, so recreating it at :50 moves the run to :50.
`fly deploy` does not manage it (a schedule cannot be written in `fly.toml`)
and may wipe or destroy it, which is why the reconcile step runs on every
deploy; it only touches the machine when the image, schedule, command or
environment actually differ, since rebuilding it resets that anchor. And the
failure signal is no longer a red workflow run: a failed fetch shows in
`fly logs`, in `GET /api/sync`'s `lastError`, and in the Brain tab.

This replaced an hourly GitHub Actions workflow. Not on Fly? Point any cron at
`POST /api/sync`, or run `rekorderlig sync-remote --url https://your-app` from
one — it takes `AUTH_TOKEN` from the environment and waits for the outcome.

`POST /api/sync` answers `202` at once and fetches on a background thread, so
the request never waits on a few hundred HTTP calls; poll `GET /api/sync` for
progress. **Fetch new stories** in the Brain tab does exactly this. Locally,
`0 * * * * cd /path/to/rekorderlig && ./target/release/rekorderlig sync` works just as well.

On Fly, an archive fill is best run inside the machine, so a few hundred
sequential fetches are not held open through an HTTP request:

```
fly ssh console -C "sh -c 'cd /app && ./rekorderlig sync --from 2026-01-01'"
```

### Repairing a day Algolia lost

Algolia's index can silently drop stories and it never backfills them, so
re-running `sync` over an affected day returns the same partial day forever. It
happened on 2026-08-23/24: for about 27 hours the index carried 54–58% of the
items Hacker News actually created, against a very steady 87–90% on every other
day, losing 216 of 701 live stories on the first day and 546 of 1130 on the
second — while HN itself kept minting ids at a completely normal rate.

`backfill` repairs it from HN's [official item
API](https://github.com/HackerNews/API), which has no index to be missing from:

```
rekorderlig backfill --from 2026-08-23 --to 2026-08-24 --dry-run   # audit
rekorderlig backfill --from 2026-08-23 --to 2026-08-24             # repair
```

It bisects the item API for the id range each day spans and then asks for every
id in it, keeping the live stories above the points floor. That is about one
request per Hacker News item — ~11k and two minutes per day, against ten
requests for a whole day through Algolia — which is why it is a manual command
and not on any timer, and why the hourly trigger above stays on Algolia.
Re-running is idempotent, and it can only ever improve a story already in the
corpus: points and comment counts take the higher of the two. Comments, jobs,
polls and anything `dead` or `deleted` are skipped; they are ~11% of any id
range and are not losses.

`--dry-run` writes nothing and reports the gap — live stories on HN against
what the corpus holds — which is how you confirm a suspect day before repairing
it. A spike or dip in **Brain → stories per day** is the usual reason to look.

## Users

A user is a row: a display name they pick themselves and, if you know it, an
email. What lets them in is a **login link** — good for a week, spent once —
which the browser trades at `/login?t=…` for a year-long cookie on that
device. No passwords: a password system's reset flow *is* a magic link, so
passwords would be that plus a hashing crate, a form and brute-force defence.

```
rekorderlig user invite --email alice@example.com --url https://your-app
                                        # prints the link, once — paste it into a chat
rekorderlig user link alice@example.com # a fresh link: a new phone, a lost cookie
rekorderlig user list                   # who exists, and how many devices each has signed in
rekorderlig user rename 3 Alice         # by id or email, never by display name
rekorderlig user revoke 3               # every device signed out, unspent links voided
rekorderlig user remove 3 --yes         # the user and every vote, model and session they own
```

Without a session the app shows a door instead of the deck: the same header
and card, what rekorderlig is in three lines, and one thing to do about it —
ask Fredrik for an invite. A login link that was already spent (or sat past
its week) lands on the same page, saying that instead.

On the first visit the app asks the invitee what to call them; the name can be
changed later in the **Brain** tab, which is also where **Sign out** (this
device only) and **Add a device** live — the latter mints a one-use link for
your own account and shows it once with a copy button, for the phone in your
other hand. `train`, `stats` and `reset-models` take `--user ID|EMAIL`
(`train` and `stats` also `--all`). On Fly these run as
`fly ssh console -C "/app/rekorderlig user invite --email …"`.

`AUTH_TOKEN` is the **operator** token, not a login: sent as a Bearer it may
trigger a sync and administer users (`/api/users`), and every user route
answers it 403. With `AUTH_TOKEN` unset — the localhost case — an anonymous
request is user 1. Mailing a link instead of pasting it is not built; the
`email` column is where it would start.

## HTTP API

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/feed` | `mode`, `days`, `minScore`, `limit`, `offset`, `includeVoted`, `day`, `q` |
| `GET`  | `/api/queue` | next titles to judge, uncertainty-sampled |
| `GET`  | `/api/explore` | high-traction titles to judge, tiered `probably`/`possibly`: `limit`, `days` (`0` = all) |
| `GET`  | `/api/votes` | your vote history: `value` (`1`/`-1`/`0`/`all`), `limit`, `offset` |
| `POST` | `/api/vote` | `{ id, value }` where value is `1`, `-1` or `0` (skip) |
| `POST` | `/api/unvote` | `{ id }` — removes a vote |
| `POST` | `/api/train` | trigger a background retrain; answers `202` at once (`started` or `queued`) |
| `GET`  | `/api/train` | training status: `running`, `pending`, `last` result, `lastError` |
| `POST` | `/api/sync` | fetch stories in the background; `{ days }` or `{ from, to }`, plus `pagesPerDay`, `minPoints`. Answers `202` (`started` or `busy`) |
| `GET`  | `/api/sync` | sync status: `running`, `progress`, `last` result, `lastError` |
| `GET`  | `/api/explain?id=` | per-feature contributions for one story |
| `GET`  | `/api/stats` | corpus, votes, metrics, learned signals, and `user` (who is signed in) |
| `POST` | `/api/me` | `{ displayName }` — set your own name |
| `POST` | `/api/logout` | end this device's session and clear the cookie |
| `POST` | `/api/me/link` | a one-use login link for another of your own devices, returned once |
| `GET`  | `/login?t=` | spend a login link: sets the session cookie and redirects to `/` |
| `GET`  | `/api/users` | operator only: every user |
| `POST` | `/api/users` | operator only: `{ email?, displayName?, uses? }` → the user and a login link (once) |
| `POST` | `/api/users/{id}/link` | operator only: `{ uses? }` → a fresh login link for an existing user |
| `GET`  | `/api/export` | your votes as JSON |
| `POST` | `/api/import/vote` | restore one historical vote: `{ story_id, value, created_at }`; an id this corpus never fetched is looked up on HN |

## Layout

```
src/features.rs      title → named sparse features
src/model.rs         logistic regression, calibration, cross-validation, insights
src/hn.rs            Algolia HN API fetch + day sync
src/firebase.rs      HN item API — repairs days Algolia's index lost
src/http_client.rs   the shared JSON fetch and its retry rule
src/db.rs            Postgres schema, the connection wrapper, and queries
src/dates.rs         UTC day arithmetic
src/service.rs       train, score, rank, explain
src/server.rs        HTTP API + static hosting
src/syncer.rs        background fetching on its own thread
src/trainer.rs       background training on its own thread
src/main.rs          serve / sync / backfill / train / stats subcommands
public/              the web app (vanilla JS, no build step)
```

Data lives in Postgres; `DATABASE_URL` says where, defaulting to
`postgres://postgres@localhost:5432/rekorderlig`. `docker compose up -d` brings
one up for development, and it is what the Rust tests talk to as well (each
test creates and drops a database of its own). Schema changes are migrations
in `src/db.rs`, applied on connect; a fresh database gets the final shape
directly.

Stories come from the [Algolia HN Search API](https://hn.algolia.com/api), no
key needed. The backend is Rust — synchronous throughout, on the `postgres`
crate — and the frontend is plain JS with no build step.
