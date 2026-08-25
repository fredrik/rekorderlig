# rekorderlig

A personal Hacker News recommender. Thumb titles up or down, and it learns what
you actually want to read — then ranks, filters and explains the firehose for you.

No accounts, no cloud, no dependencies: one Node process, one SQLite file, and a
model small enough to show you its own weights.

```
npm run ingest -- --days 10   # pull ~2,800 recent stories from the HN API
npm start                     # → http://127.0.0.1:4173
```

Vote on a dozen titles and the **Feed** tab starts reordering itself.

## The three tabs

**Train** — one title at a time, big enough to judge in a second. Swipe right or
press `→` for yes, left or `←` for no, `↓` to skip, `u` to undo. Once a model
exists the deck stops showing random stories and starts showing the ones it is
*least sure* about, because a vote there teaches it the most.

**Feed** — everything it knows about, ranked. Four orders: **For you** (pure
taste), **Blend** (taste plus how much the crowd is talking), **Most commented**
(the hcker.news view — taste ignored), and **Newest**. The *min match* slider
hides anything below a threshold. Every row carries a match percentage, and
`why?` opens the actual terms that moved the score.

**Brain** — what it learned, in words: the sites, phrases and topics pulling you
in, the ones turning you off, and an honest accuracy number. Also where you
fetch new stories, retrain, and export or import your votes as JSON.

## How it learns

Each title becomes a sparse bag of readable features — words and pairs of words
(lightly stemmed, hyphenated terms split into parts), the domain and its
registrable parent, the submitter, and a few style flags (Show HN, question,
contains a year, length). Those features feed an L2-regularised **logistic
regression** trained with AdaGrad SGD over every vote you have ever cast.

Three details matter more than the algorithm choice:

- **Nothing is hashed.** Features keep their names, so every weight can be shown
  back to you as "you like `rust`, you avoid `techcrunch.com`". A recommender you
  can argue with beats a slightly better one you can't.
- **Scores are shrunk toward 50% by how much evidence backs them.** Logistic
  regression on 20 votes will happily claim 99% certainty. The number the app
  shows is pulled back by how much of the title the model has actually seen
  before and how many votes exist at all, so early guesses look like guesses.
  Regularisation is scaled by dataset size for the same reason.
- **Both classes are weighted equally**, so a history of 90 downvotes and 10
  upvotes doesn't collapse into "predict no for everything".

Accuracy in the Brain tab is 5-fold **cross-validation** on your own votes, shown
against the majority-class baseline — not accuracy on the data it trained on.

Measured on a simulated but consistent taste over 2,768 real stories:

| votes | accuracy | AUC | log loss |
|------:|---------:|----:|---------:|
|    20 |    85.0% | 0.87 | 0.61 |
|    50 |    86.0% | 0.94 | 0.49 |
|   120 |    90.8% | 0.95 | 0.39 |
|   240 |    93.3% | 0.98 | 0.28 |
|   312 |    94.2% | 0.99 | 0.25 |

Retraining is automatic: after every vote while the model is young, then every
few votes once it has settled. A full retrain plus cross-validation on 2,000
votes takes well under a second, so the model on screen is always the one your
last vote produced.

## Commands

```
npm start                      # web app on $PORT (default 4173, 127.0.0.1)
npm run ingest -- --days 14    # fetch N days of stories (--pages 3 → ~300/day)
npm run backfill -- --from 2026-01-01   # batch-fill the archive up to yesterday
npm run train                  # retrain and print what it learned
npm run stats                  # corpus and model summary
npm test                       # unit + integration tests
```

Keep it fresh from cron, or set `REFRESH_HOURS=6` and the server re-ingests the
last two days by itself whenever its data is older than that:

```
0 * * * * cd /path/to/rekorderlig && npm run ingest -- --days 2
```

### Backfilling the archive

`ingest` keeps a rolling window fresh; **`backfill`** fills history. It is a
batch job, deliberately kept out of the web request lifecycle — run it from a
shell, next to a live server if one is running (the database is WAL-mode
SQLite, so the two coexist):

```
npm run backfill -- --from 2026-01-01              # everything up to yesterday
npm run backfill -- --from 2026-01-01 --to 2026-03-31
```

It walks the range oldest-first, one Algolia request per page of 100 stories
(`--pages 3` per day by default), pausing 250 ms between days (`--throttle`).
Both `ingest` and `backfill` ask the API only for stories with at least
**3 points** (`--points`, `0` disables) — below that nobody engaged, so a
story is dead weight in the corpus. The rolling `ingest` re-polls recent days,
so a story that starts slow is picked up once it crosses the bar.
Days the database already covers with at least 100 stories (`--min`) are
skipped, and each day commits in its own transaction — so the run is
**resumable and idempotent**: if it dies or some days fail (they are logged and
stepped over, and make the job exit non-zero), run the same command again and
only the gaps are refetched. A day fetched with `--pages 1` (100 stories) still
clears the skip bar; use `--min 0` to force a refetch. Cost is modest either
way: a ~240-day backfill is ~700 API requests over a few minutes, far under
Algolia's rate limit, and ~70k stories add only a few tens of MB to the
database.

On Fly, run it inside the machine so it writes to the volume the server reads:

```
fly ssh console -C "sh -c 'cd /app && npm run backfill -- --from 2026-01-01'"
```

Fly may auto-stop the machine mid-run if nothing is hitting the app (an SSH
session doesn't count as traffic) — keep the app open in a tab for the few
minutes the job takes, or just rerun the command: it picks up where it left
off.

New stories are scored with the current model as the job finishes; no retrain
is needed (the model learns from votes, not from the corpus).

## Hosting it (phone access)

The app is mobile-first and installs to the home screen (a web manifest is
included). Two ways to reach it from a phone:

**Own machine + Tailscale** — `HOST=0.0.0.0 npm start`, then open
`http://<machine>:4173`. No auth needed; nothing is exposed publicly.

**Fly.io** — a `Dockerfile` and `fly.toml` are included (tiny machine, SQLite on
a 1 GB volume, scales to zero when idle):

```
fly apps create <name>            # then put <name> in fly.toml
fly volumes create rekorderlig_data --size 1 --region <region>
fly secrets set AUTH_TOKEN=$(openssl rand -hex 16)
fly deploy --remote-only
```

When `AUTH_TOKEN` is set every request must carry it: open
`https://<name>.fly.dev/?token=…` once and a year-long HttpOnly cookie takes
over from there (API calls can also send `Authorization: Bearer …`). Without
`AUTH_TOKEN` the server is open — fine on localhost or a tailnet, not on the
public internet.

### PR previews

Every pull request gets its own throwaway copy of the app at
`https://rekorderlig-pr-<number>.fly.dev` (see
`.github/workflows/preview.yml`): deployed when the PR opens, redeployed on
every push, destroyed — volume and all — when the PR closes. The workflow
comments the URL on the PR, and since the server ingests on boot the preview
fills itself with fresh stories. Two secrets control it:

- `FLY_API_TOKEN` must be **org-scoped** (`fly tokens create org`) so the
  workflow can create and destroy apps, not just deploy one.
- `PREVIEW_AUTH_TOKEN` (optional) becomes each preview's `AUTH_TOKEN`; open
  the preview once with `?token=…` appended. Left unset, previews are public.

## HTTP API

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/feed` | `mode`, `days`, `minScore`, `limit`, `offset`, `includeVoted`, `day`, `q` |
| `GET`  | `/api/queue` | next titles to judge, uncertainty-sampled |
| `POST` | `/api/vote` | `{ id, value }` where value is `1`, `-1` or `0` (skip) |
| `POST` | `/api/unvote` | `{ id }` — removes a vote and retrains |
| `POST` | `/api/train` | force a retrain |
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

Data lives in `data/rekorderlig.db` (override with `REKORDERLIG_DB`). Stories come
from the [Algolia HN Search API](https://hn.algolia.com/api); no key needed.

Requires Node 24+ for the built-in `node:sqlite`. There are no npm dependencies.
