# rekorderlig

A personal Hacker News recommender. Thumb titles up or down and it learns what
you want to read, then ranks, filters and explains the firehose for you.

No accounts, no cloud, no dependencies: one Node process, one SQLite file, and a
model small enough to show you its own weights.

```
npm run ingest -- --days 10   # pull ~2,800 recent stories from the HN API
npm start                     # → http://127.0.0.1:4173
```

Vote on a dozen titles and the **Feed** tab starts reordering itself.

## The tabs

**Train** — one title at a time. Press `→` for yes, `←` for no, `↓` to skip
(or use the buttons); the recent votes link in the header opens a log where
any vote can be undone. Once a model exists the deck shows the stories it is
*least sure* about, because a vote there teaches it the most.

**Feed** — everything it knows about, ranked. Four orders: **For you** (pure
taste), **Blend** (taste plus crowd activity), **Most commented** (taste
ignored) and **Newest**. A *min match* slider hides anything below a threshold;
every row shows a match percentage, and `why?` lists the terms that moved it.

**Votes** — every verdict you have cast, newest first, one card per story with
the vote marked yes, no or skipped. Filter by verdict or title; change or
remove a vote inline and it retrains like anywhere else. (The Train tab's
recent-votes log is this session only; this is the whole history.)

**Brain** — what it learned, in words: the sites, phrases and topics pulling
you in or turning you off, plus an honest accuracy number. Also where you fetch
stories, retrain, and export or import votes as JSON.

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
npm run ingest -- --days 14    # fetch N days of stories (--pages 3 → ~300/day)
npm run backfill -- --from 2026-01-01   # batch-fill the archive up to yesterday
npm run train                  # retrain and print what it learned
npm run stats                  # corpus and model summary
npm test                       # unit + integration tests
```

Keep it fresh from cron (`0 * * * * cd /path/to/rekorderlig && npm run ingest -- --days 2`),
or set `REFRESH_HOURS=6` and the server re-ingests the last two days whenever
its data is older than that.

### Backfilling the archive

`ingest` keeps a rolling window fresh; **`backfill`** fills history. It is a
shell batch job, kept out of the web request lifecycle, and can run next to a
live server (WAL-mode SQLite):

```
npm run backfill -- --from 2026-01-01              # everything up to yesterday
npm run backfill -- --from 2026-01-01 --to 2026-03-31
```

It walks the range oldest-first, one Algolia request per page of 100 stories
(`--pages 3` per day), pausing 250 ms between days (`--throttle`). Both
`ingest` and `backfill` only ask for stories with at least **3 points**
(`--points`, `0` disables); the rolling `ingest` re-polls recent days, so a
slow starter is picked up once it crosses the bar. Days already holding at
least 100 stories (`--min`, `0` forces a refetch) are skipped, and each day
commits in its own transaction, so the run is **resumable and idempotent**:
failed days are logged, stepped over and make the job exit non-zero; rerun the
same command and only the gaps are refetched. A ~240-day backfill is ~700 API
requests over a few minutes, and ~70k stories add a few tens of MB.

On Fly, run it inside the machine so it writes to the volume:

```
fly ssh console -C "sh -c 'cd /app && npm run backfill -- --from 2026-01-01'"
```

Fly may auto-stop the machine mid-run if nothing hits the app (SSH doesn't
count) — keep the app open in a tab, or just rerun; it picks up where it left
off. New stories are scored with the current model as the job finishes; no
retrain is needed.

## Hosting it (phone access)

The app is mobile-first and installs to the home screen (web manifest included).

**Own machine + Tailscale** — `HOST=0.0.0.0 npm start`, open
`http://<machine>:4173`. Nothing is exposed publicly, so no auth needed.

**Fly.io** — `Dockerfile` and `fly.toml` included (tiny machine, SQLite on a
1 GB volume, scales to zero when idle):

```
fly apps create <name>            # then put <name> in fly.toml
fly volumes create rekorderlig_data --size 1 --region <region>
fly secrets set AUTH_TOKEN=$(openssl rand -hex 16)
fly deploy --remote-only
```

With `AUTH_TOKEN` set every request must carry it: open
`https://<name>.fly.dev/?token=…` once and a year-long HttpOnly cookie takes
over (API calls can also send `Authorization: Bearer …`). Without it the
server is open — fine on localhost or a tailnet, not on the public internet.

### PR previews

Every pull request gets a throwaway app at `https://rekorderlig-pr-<number>.fly.dev`
(`.github/workflows/preview.yml`): deployed on open, redeployed on push,
destroyed with its volume on close. The workflow comments the URL on the PR,
and the server ingests on boot so the preview fills itself. It needs one
secret, `FLY_ORG_API_TOKEN`, which must be **org-scoped** (`fly tokens create org`)
to create and destroy apps — the app-scoped `FLY_API_TOKEN` used for
production can't.

Each deploy mints a random `AUTH_TOKEN` and posts the `?token=…` link in the PR
comment. On a public repo that token is no secret — it only keeps URL scanners
out of the throwaway app, and dies with it.

## HTTP API

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/feed` | `mode`, `days`, `minScore`, `limit`, `offset`, `includeVoted`, `day`, `q` |
| `GET`  | `/api/queue` | next titles to judge, uncertainty-sampled |
| `GET`  | `/api/votes` | your vote history: `value` (`1`/`-1`/`0`/`all`), `q`, `limit`, `offset` |
| `POST` | `/api/vote` | `{ id, value }` where value is `1`, `-1` or `0` (skip) |
| `POST` | `/api/unvote` | `{ id }` — removes a vote |
| `POST` | `/api/train` | trigger a background retrain; answers `202` at once (`started` or `queued`) |
| `GET`  | `/api/train` | training status: `running`, `pending`, `last` result, `lastError` |
| `POST` | `/api/ingest` | `{ days, pagesPerDay }` |
| `GET`  | `/api/explain?id=` | per-feature contributions for one story |
| `GET`  | `/api/stats` | corpus, votes, metrics, learned signals |
| `GET`/`POST` | `/api/export`, `/api/import` | your votes as JSON |

## Layout

```
src/features.js   title → named sparse features
src/model.js      logistic regression, calibration, cross-validation, insights
src/hn.js         Algolia HN API ingest
src/db.js         SQLite schema and queries
src/service.js    train, score, rank, explain
src/server.js     HTTP API + static hosting
src/cli.js        ingest / backfill / train / stats
public/           the web app (vanilla JS, no build step)
```

Data lives in `data/rekorderlig.db` (override with `REKORDERLIG_DB`). Stories
come from the [Algolia HN Search API](https://hn.algolia.com/api), no key
needed. Requires Node 24+ for `node:sqlite`; no npm dependencies.
