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
npm run train                  # retrain and print what it learned
npm run stats                  # corpus and model summary
npm test                       # unit + integration tests
```

Keep it fresh from cron:

```
0 * * * * cd /path/to/rekorderlig && npm run ingest -- --days 2
```

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
src/cli.js        ingest / train / stats
public/           the web app (vanilla JS, no build step)
```

Data lives in `data/rekorderlig.db` (override with `REKORDERLIG_DB`). Stories come
from the [Algolia HN Search API](https://hn.algolia.com/api); no key needed.

Requires Node 22.5+ for the built-in `node:sqlite`. There are no npm dependencies.
