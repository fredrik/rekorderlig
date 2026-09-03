# Reads

What it means to have opened a story, why the feed stops offering one, and
why a read is not a vote. The code is `reads` in `src/db.rs` (`mark_read`,
`mark_unread`), `ReadFilter` and `READ_JOIN` in `src/service.rs`,
`POST /api/read` / `POST /api/unread` in `src/server.rs`, and
`public/read.js`, which every title link in the front end goes through.
Asked for in issue #65: a story clicked through should not be recommended
again, the reader should be able to see what they clicked, the article and
the comments should be told apart, and visited rows should look visited.

## A read is a row, and it is not a vote

`reads` holds one row per user per story: `link_at` and `thread_at`, each the
first time that door was opened, at least one of them set. It sits beside
`votes` and is exactly as personal — everything in it is one reader's — but
it is **not downstream of a vote**: it feeds no model, triggers no retrain,
changes no score. The app learns your taste from what you *judged*; what you
*opened* only decides what the feed still owes you. Keep the two apart. A
read that voted for you would turn every curious click into a "yes", and the
feed's own top rows are the ones you click most.

Two columns, not a `kind` row per door. The question the feed asks is "has
this user opened it", and one row answers that by existing (`r.story_id IS
NULL` hides, `IS NOT NULL` lists); a row per door would put an `EXISTS` or a
`GROUP BY` under every feed query for a set of two that will not grow. The
`CHECK` keeps a row from meaning nothing. Its primary key is the feed's join,
so there is no other index.

**The first opening wins.** `mark_read` `COALESCE`s the stored stamp over the
new one. "Read on" is when you read it, not when you last happened to click
it, and a row that climbed back up a recency sort every time it was re-opened
would be a list that never settles. What is recorded is the *click* — a page
cannot see reading — and `readLine()` says "Read", the word the issue and the
filter use, rather than the more honest "Opened", because the row is about
the reader's intent and a click on a title is that intent.

## Two doors

A story on HN has two things to open: the link, and the thread about it.
Having read the argument is not having read the article, and the issue asked
for them told apart, so the client says which door it opened — `kind` is
`link` or `thread` — and the mark on a row says so: "Read", "Thread read",
"Read, and the thread". An Ask HN has no link, so its title *is* its thread
and is marked as one (`titleKind()`); the mark says what was opened, not
which anchor was hit.

Every title link in the app goes through `bindRead()`: both decks' cards, the
reveal's judged title, the feed and the Votes rows. `click` covers a plain
and a modified click; `auxclick` the middle button, which opens a tab without
ever firing `click`. A right-click's "open in new tab" is invisible to a page
and stays unmarked — the same click again is the fix, and it costs nothing.
The mark is fire-and-forget: the tab is already open, and a failed `POST`
is swallowed rather than shouted into a page the reader has just left.

## The feed hides what you opened

`Read` is a row of three chips in the filter panel — `Hide` / `Show` /
`Only` — and `Hide` is the default: a story you opened is one the feed need
not offer again, which is the first thing the issue asked for. `Show` keeps
the opened rows in place and marks them (the title dims to the muted ink, the
sub-line says which door and when — a visited link, without the purple).
`Only` is the reading history: what you clicked through, in the feed's own
order and under its other filters, which no other view lists.

That third state is why this row is not a boolean like `Voted`. Voted's
"only" already exists — it is the Votes tab — so two chips are all it needs.
Nothing lists what was read except this row, and a history you can only
reach by turning a filter off is not a history. In the URL the row is `r`
and a word (`r=show`, `r=only`), like `m`, because the server switches on it;
an unknown word falls back to hiding rather than showing a list nobody asked
for (`docs/design/feed-url.md`).

The filter intersects with the rest like any other: a voted story you also
opened is in the history once `Voted: Show` lets it through, and a read
story from two years ago is in it once the window does. The list is ranked
by the sort row, not by when you read — a read-time sort would be a fifth
mode, and the mode row is the sort. If the history ever wants its own order,
that is where it goes, not into the filter.

## The decks still offer what you read

Neither deck filters on `reads`, on purpose. The trainer asks for a
judgement on a title, and having read the story is the best reason there is
to be able to give one; Explore is a reading list you can vote on, and a
story you already opened is one you can now vote on with conviction. The
join is its own constant (`READ_JOIN`), not part of `STORY_JOINS`, so the
queue and the round never touch the table. Skips remain the way to make a
card go away.

## Undo

`POST /api/unread` deletes the row — both doors at once, since the feed
hides on either. It exists because the default hides: without a way back, a
slip of the thumb on a phone would lose a story for good, the same reason
the Votes list has its ✕. The row's `Unread` button is the only caller.

## What travels

A read is the reader's, and `user remove` takes it with the row (`ON DELETE
CASCADE`, like a vote). Previews are seeded from a production dump with
emails and credentials scrubbed and votes kept; reads are kept with the
votes — the same sensitivity, the same reasoning (`preview.yml`).
