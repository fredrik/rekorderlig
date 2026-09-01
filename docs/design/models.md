# The model store

Why `models` is derived data, what a tokenizer change costs, the one pruning
that was done, and why reposts are nobody's special case. The code is
`src/model.rs`, `src/features.rs` and `reset_models()` in `src/service.rs`.

## `models` is derived data

The model is a deterministic function of the votes, so `reset_models()`
(`rekorderlig reset-models --yes`) can delete every revision and a retrain
reproduces it. Votes and `vote_predictions` are left alone — they are the
record. Reach for it after a change that renames features: weights are keyed
by feature *name*, so a history spanning a tokenizer change diffs
vocabularies rather than models, and the round summary would report
thousands of "new signals" that are the same words renamed.

It clears `oof_previous` too — a baseline naming a revision about to stop
existing is worse than none — and drops the round meta, since a round in
flight was dealt by a model that no longer exists. `TRUNCATE models RESTART
IDENTITY` does the delete and the renumbering in one statement; nothing
references `models` by foreign key, which is what makes TRUNCATE safe here.
Retrain immediately: an empty models table leaves the queue on its cold
path. On the live machine:
`fly ssh console -C "/app/rekorderlig reset-models --yes"`.

## Retention, and the one pruning done so far

`models` is append-only and nothing prunes it — 51 revisions came to 6.3 MB,
~124 KB each and growing with the vocabulary. Not a problem at a round per
sitting; it will want a retention rule before it is one. Pruning is a plain
`DELETE FROM models WHERE rev <= N` (plus `VACUUM`) and needs nothing else:
`scores` all carry the current rev, `oof_scores` / `oof_previous` hold only
the last two trains, and the identity sequence keeps its own high-water mark
past the surviving max.

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
