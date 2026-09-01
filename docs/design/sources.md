# The two story sources

Why routine fetching has exactly one path, why repair is a second source
rather than a second sync, and how a vote import stays honest. The code is
`src/hn.rs` (Algolia), `src/firebase.rs` (HN's official item API) and
`sync()` / `backfill()` in `src/service.rs`.

## One routine path

Routine fetching has exactly one path: today and a year of history are the
same `syncDays()` walk over a different list of days — the only difference
is the list. Every day in that list is fetched; nothing is skipped for
looking covered already, so recent days stay honest at the cost of requests.
Don't split it back into a rolling job and an archive job — that split is
what this replaced. (A `sync_days` ledger of completed days would make a
backfill resumable again; that is the intended successor, not a second code
path.)

## Repair is the one exception

It is a second *source*, not a second sync: `src/firebase.rs` reads HN's
official item API, because Algolia's index can silently lose stories and
never backfills them. Verified: 2026-08-23 15:00 UTC → 2026-08-24 19:00 UTC,
Algolia indexed 54–58% of the ids HN minted (a stable 87–90% on every other
day), losing 216 of 701 live stories on the 23rd and 546 of 1130 on the
24th, while HN itself minted ids at a normal rate throughout. A refetch
through `sync()` cannot recover any of it — Algolia returns the same partial
day forever.

The two sources stay far apart on purpose. Algolia answers "the top stories
of a day" in ten requests and is the only way stories routinely arrive;
Firebase can only answer per id, so a day costs ~11k requests and about two
minutes. That makes it a command (`rekorderlig backfill`) and never a timer,
an endpoint or part of `sync()`. It is deliberately **not** wired into
`fetchStory()` either, so `POST /api/import/vote` still fails on a story
Algolia lost until a backfill has put it in the corpus.

`--dry-run` makes the same command the audit: live stories on HN versus what
the corpus holds, writing nothing. That is how a suspected gap gets
confirmed before it gets repaired.

## Importing a vote

`POST /api/import/vote` restores one historical vote (`story_id`, `value`,
`created_at`) and is the only import path — there is no bulk import. A story
id the corpus never fetched is looked up on HN (`fetchStory`) and inserted;
it is never stubbed from the request, so the title the model trains on is
always HN's. The response echoes the stored story back so each vote can be
verified as it lands, and no retrain is triggered per vote — call
`POST /api/train` once the import is done.
