# Rounds

Why training is dealt in rounds, where a round lives, and how the summary
gates an accuracy move. The code is the round functions in `src/service.rs`
(`dealRound()`, `roundStatus()`, `currentRound()`, `roundSummary()`,
`ROUND_SIZE`) and the summary rendering in `public/train.js`.

## The unit

Training is dealt in rounds: `ROUND_SIZE` (12) cards drawn from one model
revision, judged, then one retrain. A skip consumes a slot — a round is
twelve cards, not twelve verdicts. The first round of a session is
auto-dealt; every one after it comes from the button on the summary, because
the pause is what makes the task finite. The unit is the point: before it, a
retrain fired after roughly every individual vote (a scratch database held
162 revisions for 513 votes) and the accuracy it produced could not be read
as the consequence of anything.

A round boundary is the only retrain trigger — no debounce on individual
votes, and no manual button (one existed and was removed: it asked for a
rescore no new evidence justified, and it could split a round across two
model revisions). A vote cast in Feed or Votes is trained on when the next
round ends, like every other vote — one rule instead of three.
`rekorderlig train` covers the rare manual case.

## Where a round lives

The round in flight lives on the user's row, `users.current_round`
(`dealRound()`, `roundStatus()`, `currentRound()`), **not** in the browser: this app is
installed on more than one device, and a round that exists in one browser
is only finite in that browser. Progress is a join against `votes`, never
a counter, so it cannot drift from what was recorded and picks up votes
cast anywhere else. A deal older than a day is discarded rather than
resumed; its votes were saved and are trained on at the next boundary.
`seq` (the round number, from `users.round_seq`) and `rev` advance
independently — a round of nothing but skips moves `seq` and not `rev`.

It needs **no table**. Because retraining happens only at a round
boundary, a completed round is identified by the model revision it was
dealt at, so everything a summary needs is derivable: the votes from
`vote_predictions WHERE model_rev = R`, and accuracy, signals and weights
from the `models` payloads at R and R+1.

## The summary

`roundSummary()` reports the round **in order of how much each number
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

## Gating an accuracy move

It is gated **paired**, on the flips (`pairedFlips()`), because two
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

`band` is the **fallback**, for when there is nothing to pair against
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

The `explore` hit rate is computed and **not** displayed. It is the only
unbiased read of true accuracy in a round — boundary cards are picked
*because* the model can't call them — but shown bare as "1/2 on the
random cards" it explained none of that. It needs somewhere with room.

The summary marks the round spent (`finishedAt`), so reopening the tab on
a finished round shows it again instead of paying for a second retrain of
the same votes.
