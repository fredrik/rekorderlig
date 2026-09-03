# The model store

Why `models` is derived data, what a tokenizer change costs, the one pruning
that was done, and why reposts are nobody's special case. The code is
`src/model.rs`, `src/features.rs` and `reset_models()` in `src/service.rs`.

## `models` is derived data

The model is a deterministic function of the votes, so `reset_models()`
(`rekorderlig reset-models --yes`) can delete one user's every revision and
a retrain reproduces it. Votes and `vote_predictions` are left alone — they are the
record. Reach for it after a change that renames features: weights are keyed
by feature *name*, so a history spanning a tokenizer change diffs
vocabularies rather than models, and the round summary would report
thousands of "new signals" that are the same words renamed.

It clears `oof_previous` too — a baseline naming a revision about to stop
existing is worse than none — and resets the user's round state, since a
round in flight was dealt by a model that no longer exists. The delete is a
plain `DELETE ... WHERE user_id`, and the renumbering comes for free: `rev`
is allocated as that user's `MAX(rev) + 1` inside the INSERT (no sequence),
so with no rows left the next revision is 1. That allocation is why `rev` is
per user rather than one global identity — three things read it as a count
(the learning curve, the round summary's `rev`/`rev + 1`, this reset), and
none of them can under a shared sequence. It is safe because one trainer per
process and one process per app is already the rule; the `(user_id, rev)`
primary key turns a race into a loud error, never a duplicate. Retrain
immediately: an empty models table leaves the queue on its cold path. On the live machine:
`fly ssh console -C "/app/rekorderlig reset-models --yes"`.

## The learning curve is columns, not payloads

`GET /api/history` draws the learning curve: one accuracy per training run,
with the noise band around it and the vocabulary size beside it. Four numbers
per revision, out of a table whose rows are ~124 KB of weights each.

It used to read them back out of the payload in SQL — `payload::jsonb #>>
'{metrics,accuracy}'` and three more like it. The reasoning was sound as far
as it went (better than shipping fifty snapshots to the app and parsing them
in Rust), and it hid the actual cost: `payload::jsonb` is a full parse of the
whole 124 KB to reach one float, Postgres does not share that parse between
the four expressions in the select list, and `jsonb_array_length(… #>
'{model,names}')` materialises the entire vocabulary array to count it. So
the request cost four parses per revision, and both multiplicands grow — one
revision per round, and a vocabulary that only ever gets bigger.

Measured on one database of 120 revisions at ~120 KB each, three runs, median:

| query | time |
|---|---|
| the four casts, as shipped | **680 ms** (657–745 across runs) |
| one cast, one extraction | 136 ms |
| detoast the payloads, touch nothing else | 30 ms |
| read the row without the payload | 0.35 ms |
| the columns | **0.32 ms** |

It was comfortably the slowest read in the app, and the front end issues it on
every visit to the Brain tab.

So the four numbers are columns on `models` now — `accuracy`, `baseline`,
`noise`, `n_features` — written by `train_and_score` from the same values it
serialises into the payload a few lines earlier. Same query, 0.3 ms, and it
never touches TOAST. On the preview app — seeded from a dump of production, so
33 real revisions with a vocabulary of 4,951 to 9,168 features — `/api/history`
went from roughly ten times the cost of `/api/stats` to indistinguishable from
it, both of them network.

Three things worth keeping straight about that:

- **`payload` stays TEXT.** The original note gave a good reason not to make
  it JSONB: a JSONB column re-serialises what `serde_json` wrote (key order,
  whitespace, duplicate keys), and the byte-for-byte round trip is what lets
  a snapshot move between backends untouched. Columns sidestep the trade
  rather than taking the other side of it — nothing on this path parses the
  payload any more, so there is nothing to make faster.
- **The columns are a copy, and a copy can drift.** Nothing at runtime reads
  both, so nothing at runtime would notice; `tests/service.rs` compares the
  columns against the payload after a real train, which is the only place the
  two are held together. They already disagree in one harmless place, and it
  predates the columns: `Metrics.noise` is `#[serde(default)]`, so a snapshot
  written before `noise` existed loads as `0.0` and `/api/stats` reports that,
  while the column — like the `#>>` cast it replaced — is NULL. Null is the
  more honest of the two; there is nothing to reconcile, only to know.
- **All four are nullable.** `metrics` is `Option<Metrics>` — cross-validation
  needs both classes and gives up under five of either, so a new user's first
  trains have no accuracy to store. That is not new: the old query returned
  NULL for those rows and `model_history` dropped them, so `revs` has always
  counted the revisions that charted rather than every row. The filter just
  moved into the WHERE clause.

Migration 3 backfills the columns from the payloads on the way past, which is
the same extraction, once, at boot under the schema lock — about a second per
hundred revisions, slow for exactly the reason the columns exist. It does not
`SET NOT NULL` afterwards: a payload old enough to lack `model.names` should
migrate to NULL, not fail the boot for every database that holds one.

## Retention, and the one pruning done so far

`models` is append-only and nothing prunes it — 51 revisions came to 6.3 MB,
~124 KB each and growing with the vocabulary. Not a problem at a round per
sitting; it will want a retention rule before it is one. Pruning is a plain
`DELETE FROM models WHERE user_id = U AND rev <= N` (plus `VACUUM`) and needs
nothing else: `scores` all carry the current rev, `oof_scores` /
`oof_previous` hold only the last two trains, and as long as the newest
revision survives the next one is allocated past it.

Done once, on 2026-08-29: revs 1–48 (374–416 votes, all trained on
2026-08-25) were the **per-vote retrain era** from before rounds — one
revision per swipe, an hour of them, and the accuracy they charted was the
consequence of nothing. Rev 49 (417 votes) was kept deliberately: it is the
model the first round was dealt from and the baseline that round's summary
pairs against. Rev 50 (429 votes) is the first round-boundary train, which
is where the learning curve now starts. Cutting the flat early climb
(57% → 65%) also cut the headline's best number, by design: "up 2 points
since 417 votes" is the rounds-era slope, and the 11-point one it replaced
was mostly the model finding its feet.

## The tokenizer's edges

The tokenizer keeps `&` and `/` **inside** a word and trims them off the
ends. As separators they shredded things that mean something: "S&P 500"
became `s` + `p` + `500`, and "278 tok/s" left a bare `s` that then surfaced
as a learned term. AT&T, R&D, M&A and km/h have the same shape. `i` is a
stop word for the same reason — a pronoun, not a topic (1,568 titles of
49,281 carry a bare "i"), and the shape it hints at is already carried by
`t:narrative`/`t:showhn`. Changing any of this **renames features and
invalidates every learned weight**, so it is cheap only when the votes are
about to be rebuilt anyway.

## Reposts are not special-cased

A vote binds to the submission it was cast on, every vote is one training
example, and a duplicate submission is just another title to judge. The
model reads titles, so a twin's differently worded title was never something
you judged — deduping by URL would have put words in your mouth. Don't
reintroduce it.
