# Judging

What a card may show, what the reveal says and why it says it that way, and
which score is the honest one. The code is `judge()` in `src/service.rs`,
`public/reveal.js`, `public/certainty.js` and the two decks (`train.js`,
`explore.js`).

## The card shows only what the model can see

The trainer card shows **only what the model can see**: title and domain.
`featurize()` reads title words, bigrams, style flags, domain, tld and
author — points, comments and age are not features, so displaying them
contaminates the label. A yes swayed by "98 comments" reaches the model
attached to the story's *words*, because that is all it has, and lands as
noise in the title weights. (Comment counts are frozen at fetch time too, so
they describe when the sync ran, not the story.) The rule is one-directional:
showing a non-feature corrupts labels, but training on something unshown —
author — is just learning. Selection is exempt: the `points >= 10` floor and
`recent`'s comment ranking choose which stories you are asked about, and the
model is never asked to explain them.

**Explore's card is the exception, deliberately**: it shows points, comments
and the tier chip, because there the traction *is* the offer — it is the
answer to "why is this story in front of me", and a deck that hid it would
be unexplained. The cost is real and worth knowing: those votes carry a
little of the crowd's opinion into the title weights. The model's own score
stays hidden in both decks, which is the part that would anchor a vote
outright.

A card never shows its score, in either deck. A percentage in front of a
thumb anchors the judgement and contaminates the label. Explore's tier chip
is the deliberate exception: coarse ("probably" / "possibly"), and it is the
reason the card is on screen at all.

## Explore is a second judging deck, not a second feed

It writes the same votes through the same `POST /api/vote`. What it changes
is *what gets asked about*. The trainer optimises for information (uncertain
titles, which on HN is mostly the 1-comment tail); Explore optimises for the
reader (only stories the crowd stopped on). Keep the numbers in `EXPLORE` —
they are the whole contract, and `/api/explore` ships them to the client as
`bar` so the empty state can quote them without keeping its own copy.
Explore is **not** round-shaped and triggers no retrain: a round is a sample
from one model revision, dealt so its before-and-after numbers mean
something, while Explore refills as you judge. A vote cast here is trained
on when the next round finishes — the same rule Feed and Votes follow.

Unlike the feed, Explore does show unscored stories — before the first model
every card is `possibly` and the deck is pure crowd order. "The crowd is on
it" is a claim about points and comments, and needs no model to be true.

The feed never shows unscored stories (`sc.score IS NOT NULL`) — before the
first model it is empty by design. Unscored is transient otherwise: `sync()`
scores what it fetched before it returns.

## A skip is not a training example

`labelledStories` excludes `value = 0`, so a skip teaches nothing: it
consumes its slot in the round, leaves the story judged, and contributes no
example. A round of nothing but skips therefore retrains nothing and says
so. (Before rounds, every swipe including a skip triggered a retrain — a
full corpus rescore producing a model identical to the last, announcing
"Learned · 64% accurate" about a story you had declined to judge.)

## The reveal comes after the swipe

The trainer reveals the model's guess **after** the swipe, never before.
`vote_predictions` freezes what the model said at the instant of judging —
the vote did not exist yet, so it is a genuine out-of-sample call, unlike the
`scores` row, which the next retrain memorises. That capture is what makes
"Called it" honest, and it is why `judge()` captures before it records.
Undoing a vote drops its prediction with it. Beside the guess, the reveal
says what the vote *gives* the model — the features of that title it had
never seen (`newSignals()`), which is what the next retrain learns from it.
That number is the feedback, not a rolling hit rate: the queue's `boundary`
stratum deliberately serves the cards the model is least sure about, so its
hit rate on them is pinned near chance by construction and can never read as
progress. Signals learned only ever climbs, and every vote moves it.

Placement is deliberate: the verdict lands **below** the vote buttons with
the judged title beside it (card and buttons are one cluster — nothing goes
between them), while a retrain reports itself in the **header line**, because
it is news about the model rather than about the swipe and must not overwrite
what you just judged. Every reveal names both parties and keeps the halves
symmetric ("Brain guessed no (fairly sure, 81%) — you said yes."): never
"you agreed", which casts the model as the reference and the vote as the
thing falling in line — the vote is the truth, the guess is a guess. The
glyph is `=` / `≠` for the same reason: the line compares two verdicts, where
a tick and a cross would grade the vote against the guess. ("Got that one
wrong" had the same fault in reverse: it never said whose mistake it was.)
The percentage is the confidence in the call the model actually made, not
P(yes) — beside "guessed no" the raw score reads as its own opposite.

## Certainty in words

How sure it was is named in words *and* coloured by that name, on the
`CERTAINTY` bands (`public/certainty.js`): ≥0.9 "very sure", ≥0.75 "fairly
sure", ≥0.6 "leaning", below that "a coin flip". The word carries what the
number never could on its own — "51% certain" is a coin flip described as a
conviction, and it was drawn in the same full red as a call made at 96%. The
bands are on the *strength* of the call (0.5–1), so the hue still comes from
hit/miss (`--verdict-hue`) and the band decides how much of it is spent:
`.sure-mid`/`.sure-low` mix towards `--muted`, and `.sure-none` is plain grey,
because agreeing with a coin flip is not a hit and disagreeing with one is not
a miss. Adding a band means adding its `.verdict.sure-<name>` colour —
`tests/styles.test.mjs` holds the two files to that.

## The honest score is the held-out one

A voted story's stored score says nothing. The trained model separates its
own training set perfectly (every yes ~0.99, every no ~0.00), so on the Votes
view that number only restates the verdict badge. The honest one is the
**held-out** score in `oof_scores`: what the model said while trained on a
fold that excluded that vote. The Votes view shows it only when it
contradicts the verdict by more than `CONFLICT_MARGIN` (`public/votes.js`) —
about one vote in ten, the titles your other votes argue against. The margin
matters: without it, 39% of votes "conflict", most of them predictions
sitting near 0.5 with no opinion to disagree with. Don't wire that flag back
to `scores`; it can never fire there. The held-out score is stale between
trains by construction.

`heldOut` stays out of `models.payload` and out of `/api/stats`: it is one
row per vote, and a snapshot per rev would carry the whole vote history each
time.
