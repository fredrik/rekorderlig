# rekorderlig

A personal Hacker News recommender. Thumb titles up or down and it learns what
you want to read, then ranks, filters and explains the firehose for you.

No accounts, no cloud, no dependencies: one Node process, one SQLite file, and a
model small enough to show you its own weights.

```
npm run sync -- --days 10     # pull ~2,800 recent stories from the HN API
npm start                     # → http://127.0.0.1:4173
```

Vote on a dozen titles and the **Feed** tab starts reordering itself.

## The tabs

**Train** — one title at a time. Press `→` for yes, `←` for no, `↓` to skip
(or use the buttons). Once a model exists the deck shows the stories it is
*least sure* about, because a vote there teaches it the most.

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

Retraining is automatic: a burst of votes debounces into one trigger, and the
fit plus a full rescore of the corpus run in a worker thread so the app never
stalls. On 2,000 votes it takes well under a second.

## Commands

```
npm start                      # web app on $PORT (default 4173, 127.0.0.1)
npm run sync -- --days 14      # fetch the last N days (--pages 10 → ~1000/day)
npm run sync -- --from 2026-01-01       # fill the archive from a date to today
npm run train                  # retrain and print what it learned
npm run stats                  # corpus and model summary
npm test                       # unit + integration tests
```

### Fetching stories

One command does all of it. `sync` walks a list of days, asks the Algolia API
for the top stories of each and upserts them; `--days N` walks the last N
(default 2), `--from`/`--to` an explicit range. There is no second code path
for history — a year-long fill is the same walk with a longer list:

```
npm run sync                                    # today and yesterday
npm run sync -- --days 14                       # the last two weeks
npm run sync -- --from 2026-01-01               # everything since new year
npm run sync -- --from 2026-01-01 --to 2026-03-31
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

Nothing fetches on its own. **Point cron at the app** to keep it fresh:

```
0 * * * * curl -fsS -m 30 -X POST https://your-app/api/sync \
            -H "authorization: Bearer $AUTH_TOKEN" \
            -H 'content-type: application/json' -d '{"days": 2}'
```

`POST /api/sync` answers `202` at once and fetches in a worker thread, so the
request never waits on a few hundred HTTP calls; poll `GET /api/sync` for
progress. **Fetch new stories** in the Brain tab does exactly this. Locally,
`0 * * * * cd /path/to/rekorderlig && npm run sync` works just as well.

On Fly, an archive fill is best run inside the machine so it writes to the
volume without going through HTTP:

```
fly ssh console -C "sh -c 'cd /app && npm run sync -- --from 2026-01-01'"
```

## HTTP API

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/feed` | `mode`, `days`, `minScore`, `limit`, `offset`, `includeVoted`, `day`, `q` |
| `GET`  | `/api/queue` | next titles to judge, uncertainty-sampled |
| `GET`  | `/api/votes` | your vote history: `value` (`1`/`-1`/`0`/`all`), `limit`, `offset` |
| `POST` | `/api/vote` | `{ id, value }` where value is `1`, `-1` or `0` (skip) |
| `POST` | `/api/unvote` | `{ id }` — removes a vote |
| `POST` | `/api/train` | trigger a background retrain; answers `202` at once (`started` or `queued`) |
| `GET`  | `/api/train` | training status: `running`, `pending`, `last` result, `lastError` |
| `POST` | `/api/sync` | fetch stories in the background; `{ days }` or `{ from, to }`, plus `pagesPerDay`, `minPoints`. Answers `202` (`started` or `busy`) |
| `GET`  | `/api/sync` | sync status: `running`, `progress`, `last` result, `lastError` |
| `GET`  | `/api/explain?id=` | per-feature contributions for one story |
| `GET`  | `/api/stats` | corpus, votes, metrics, learned signals |
| `GET`  | `/api/export` | your votes as JSON |
| `POST` | `/api/import/vote` | restore one historical vote: `{ story_id, value, created_at }`; an id this corpus never fetched is looked up on HN |

## Layout

```
src/features.js   title → named sparse features
src/model.js      logistic regression, calibration, cross-validation, insights
src/hn.js         Algolia HN API fetch + day sync
src/db.js         SQLite schema and queries
src/service.js    train, score, rank, explain
src/server.js     HTTP API + static hosting
src/syncer.js     background fetching in a worker thread
src/trainer.js    background training in a worker thread
src/cli.js        sync / train / stats
public/           the web app (vanilla JS, no build step)
```

Data lives in `data/rekorderlig.db` (override with `REKORDERLIG_DB`). Stories
come from the [Algolia HN Search API](https://hn.algolia.com/api), no key
needed. Requires Node 24+ for `node:sqlite`; no npm dependencies.
