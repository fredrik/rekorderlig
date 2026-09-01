# The training queue

Why the queue is a stratified sample drawn by index seeks, and the planner
traps that keep it that way. The rules distilled from this live in CLAUDE.md;
this file is the argument. The code is `trainingQueue()` and the `draw_*`
functions in `src/service.rs`.

## A stratified sample, not a ranking

The queue is 40% `boundary` (near the decision line), 20% `novel` (no
vocabulary yet), 20% `recent` (last 3 days, most discussed), 20% `explore`
(uniform over the whole archive), round-robined so no stratum arrives in a
block. Only stories with `points >= 10` are offered — HN's long tail is most
of an archive and none of it is worth a swipe.

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

## Rank on the unshrunk score

`scores.score` is pulled toward 0.5 by confidence, so `|score - 0.5|` sorts
by ignorance, not uncertainty; the boundary stratum undoes the shrinkage
(`RAW_OFFSET`) and `novel` is where low confidence gets its own, budgeted
slots.

## Seek, never scan

Every stratum draws by seeded probe — pick a random key, seek the first
unjudged story past it — so a deck costs about one index seek per card
whether the corpus holds 10k stories or 10M (measured: 3.6 ms for a 40-card
draw over a million stories; 32 ms to deal a round of 12 over the real 49k).

This is not a tuning note bolted onto the draw — it *is* the draw. The
alternative sampler (count the band, pick a random offset into it) needs the
`COUNT(*)` that scans, and `OFFSET k` is itself O(k). Sampling by key instead
is what keeps the whole thing O(log n), at the price of a gap-weighted rather
than row-uniform sample and the `PAGE_STEP` tie-break (commented at its
definition).

Three traps make or break the seek, and all three are commented in place:

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

The trap that makes the rule worth writing down: violating it is nearly
invisible. At ~50k stories a full scan is fast, the strata still come out
5/3/2/2, and every behavioural test passes — the regression surfaces at
10–100× the corpus, long after the change is buried. The EXPLAIN test above
is the loud alarm; this file is the reasoning behind it.
