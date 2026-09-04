# Multi-user: the plan

Written against `main` at `1f85e01`, the first schema change after the
Postgres port. The shape of the change is small to say and wide to make: the
corpus stays shared, everything downstream of a vote becomes one user's, and a
user is a row who signs in with a link.

## What a user is

**A user is a row; a credential is a session.** The row is `users`: a
display name the user picks for themselves, an email the operator may know
them by, and nothing that lets anyone in. What lets someone in is a
**login link** — short-lived, counted-use, spent at `POST /login?t=…` — which
hands the browser a **session**: a year-long `rk_token` cookie, one per
device, revocable one at a time or all at once. Somebody mints an **invite**
— the operator with `rekorderlig invite create --note …`, or any user with
the "Invite a friend" button in Brain — and pastes the printed link into
whatever chat they share; whoever accepts it becomes the user, and on that
first visit is asked what to call them. A login link is the same two tiers
for somebody the app already knows — a second device, a lost cookie.

The first draft of this plan said "a user is a token": one long-lived
`?token=` link per user, kept in `users.token_hash`. It was dropped before it
shipped, for the weakness it shared with the `AUTH_TOKEN` link it grew out
of: the link *was* the credential, sitting in chat history and browser
history forever, shared by every device, and rotating it signed out all of
them. Two tiers — a link that is spent and a session that is a device — is
the whole fix, and the redeem endpoint redirects so the token never reaches
the address bar the app renders under.

### Why not passwords

Every password system contains a magic-link system: the reset flow. So
passwords would be the login link *plus* a hashing primitive (a new crate, or
`pgcrypto` with plaintext passwords crossing to Postgres as parameters), a
form, and online brute-force defence on a synchronous server with one
connection behind a mutex. A 122-bit link cannot be guessed online. What
passwords would buy is signing in without email delivery and without the
operator awake — for a dozen friends whose protected asset is a list of HN
upvotes, not worth becoming a custodian of reused passwords. README's "no
accounts" becomes "no passwords".

### Email is a transport, not a mechanism

`users.email` exists and is unique case-insensitively, so the operator can
address a user by it and so a mailed link has somewhere to go. Mailing one
is not built: it needs a sending domain with SPF and DKIM, a provider and a
secret, an outbound call made off the request thread (a 300 ms send against
a 0 ms no-op is an email-enumeration oracle), a same-answer-for-unknown
`POST /api/login`, and a rate limit — one link a minute per user, which is a
query on `login_links`, no new state. It also puts addresses into every
backup artifact for ninety days and into every preview seed; the seed
scrubs them. All of that is one later phase, designed in
`docs/design/email.md` — which keeps `LINK_TTL_SECS` at a week for pasted
links and gives a mailed link fifteen minutes of its own, rather than
shortening the one constant as this paragraph first proposed. Slack pairs its link with a
six-digit code because the link opens in the mail app's webview rather than
where you started; a link mailed to a phone lands the same way here, which
is one more reason operator-pasted links stay primary.

The one credential that is *not* a user is the existing `AUTH_TOKEN`. Two
callers send it as a Bearer today — the hourly Fly machine running
`sync-remote`, and the preview workflow — and neither of them has a taste to
train. `AUTH_TOKEN` is the **operator** token: it may trigger and watch a
sync and administer users (`/api/users`), and it may not vote, be dealt a
round or read a feed, because there is no user for it to be. Neither the sync
machine nor the workflow's sync call changes a line.

Dev mode (`AUTH_TOKEN` unset, the localhost case) keeps today's behaviour:
an unauthenticated request acts as user 1 — unless a live session cookie
says otherwise, so the invite flow can be tried locally. That is the reason
user 1 exists on a fresh database rather than only on a migrated one.

### Invites

An invite is a row of its own, and the point of it is that **it does not know
who will open it**. Someone mints one, pastes it into a chat, and the person
who accepts it at `POST /invite/<token>` is minted as a user right there —
display name NULL, which is exactly the state the welcome prompt already asks
about.

"Someone" is the operator or **any user**: inviting a friend is a panel in
Brain, not an errand to run through Fredrik. That is the whole reason the row
knows who sent it (`invited_by`) — a ledger of invites nobody signed answers
"who is this person" with a shrug once the second user starts inviting.

And it is **composed, not pressed out**. The first cut of this was a button
that minted on click: one press, one row, a link on screen. It worked and it
was wrong — the act it stands for is making another person an account, and a
click is what you spend on a filter chip. So the button opens a card to
address, `note` is who it is *for*, and the POST that mints the row is the
card's submit; opening it and cancelling it touch nothing. That is the sending
half of the doorstep's rule at the other end, arrived at from the other
direction: an invite is a deliberate press at both ends of its life.

Two things fall out of the card, and they are the reason it is a name rather
than a confirmation dialog:

- **The list becomes people.** Five rows reading "unopened · 7 days left" tell
  you nothing; "Anna, from work" tells you what you meant to do. The name is
  the sender's alone — the invitee never sees it, and cannot, since the row
  exists before they do.
- **The ledger holds both names.** Once it is taken up, the row knows what you
  called them *and* what they call themselves, and the list says so when the
  two differ: "Anna, from work · joined 4d ago as anna". That is the whole
  argument of this section — the name *they* chose is the one worth reading
  back — with the name you wrote down standing beside it rather than in place
  of it.

The cap is shown rather than only enforced: five pips, one worded line, and a
button that is disabled when there is nothing left to give, because a person
should not learn a limit by being refused. All three of a user's invite routes
answer `{invites, cap: {max, left}}`, so the pips and the rows are painted from
one response and cannot disagree.

The first shape of this was `rekorderlig user invite --email …`: create the
user, mint them a login link, hope it reaches them. It works, but the ledger
it leaves answers nothing. You already knew who you meant; what you wanted to
know was whether they ever showed up. Deferring the user row to redemption is
what turns "who" into information — and it is the name *they* chose that the
list reads back, not the one you wrote down.

```sql
CREATE TABLE IF NOT EXISTS invites (
  id          BIGINT PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY,
  token_hash  BYTEA  NOT NULL UNIQUE,    -- sha256(token); the token is never stored
  note        TEXT,                      -- who the operator meant it for
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,           -- a week (LINK_TTL_SECS), like a login link
  redeemed_at BIGINT,                    -- NULL until someone opens it
  revoked_at  BIGINT,                    -- NULL unless it was voided
  user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,  -- who it became
  invited_by  BIGINT REFERENCES users(id) ON DELETE SET NULL   -- who sent it
);
CREATE INDEX IF NOT EXISTS idx_invites_created ON invites(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invites_invited_by
  ON invites(invited_by, created_at DESC);
```

Decisions in that shape:

- **A third token table, not `tokens(kind)`.** The same argument that keeps
  `sessions` and `login_links` apart: three verbs, three access paths.
  `authorize()` reads `sessions`, `/login` reads `login_links`, `/invite`
  reads this — and a `kind` column would put a `WHERE kind =` on every query
  that one of them could forget. The verb here is the distinct one: a login
  link *authenticates a user who exists*, an invite *mints one*.
- **`id` is the key, `token_hash` merely unique.** The operator has to be
  able to name a row — `invite revoke 4` — with something other than a secret
  they no longer hold. The plaintext exists once, in the response that minted
  it, exactly as for the other two tables.
- **Events, not an mtime.** `created_at`, `redeemed_at`, `revoked_at`,
  `expires_at`. An `updated_at` on an append-mostly row is always equal to one
  of the first two, so it answers no question anyone would ask of it.
- **Single use by construction**: `redeemed_at` is a timestamp, not a
  counter. A multi-use invite makes "who took it up" one-to-many and needs an
  audit table to say it honestly; the link that has to serve a crowd is the PR
  preview's, and that is a `login_links` row for user 1, not an invite.
- **No `email`.** An invite cannot know the address of someone it has not met,
  and `users.email` is already the one place an address lives. `note` is the
  operator's own bookkeeping — "Anna, from work" — and reaches nobody else.
  Had the invite carried an address, `users.email` being unique means it could
  collide by the time the link was opened, and the redemption would fail for a
  reason the invitee could do nothing about.
- **Two references to `users`, answering different questions.** `invited_by`
  is who **sent** it and is known when the row is written; `user_id` is who it
  **became** and is NULL until someone opens it. `invited_by` is NULL when the
  *operator* minted it, and that is the honest answer rather than a gap: the
  operator is not a user (`Auth::Operator`) and has no row to point at, which
  is the same reason every user route answers it 403. Migration 5 adds the
  column without a backfill for exactly that reason — every invite that
  existed when it ran was the operator's, and stamping them user 1 would
  invent a fact, since user 1 is the owner and not the operator.
- **A ceiling, not a promise.** Any user may invite, so any user may mint
  users; `INVITES_OUTSTANDING_MAX` (5) caps how many *live* — unopened,
  unvoided, unexpired — invites one user may have out at a time. Taken-up
  invites do not count, because those are people rather than outstanding
  links, and the sixth request answers 409 saying to void one or wait. The
  operator is uncapped: the operator is who would raise the number. This is
  the cheapest honest answer to "what if"; anything cleverer (per-day rates,
  trust levels) would be machinery for a problem a handful of friends does not
  have.
- **A row with a user behind it is never deleted.** Voiding is `revoked_at`,
  so the decision is on record, and a redeemed invite cannot be voided at
  all: it is history, and the door it opened is a session, which
  `revoke_access` shuts. `ON DELETE SET NULL` rather than CASCADE for the
  same reason — `user remove` should not erase the fact that an invite was
  taken up, only who is left of it. `invite remove` is the one delete, and it
  takes only a row nobody is left of: `user_id IS NULL`, which is unopened
  (wanted or not, voided or not) or taken up by a user since removed. The
  case that made it: a Slack unfurl spent two invites and minted two users;
  once those users were removed, the rows recorded nothing about anyone.
  Removing a live person's invite is refused — `user remove` comes first,
  so removing an invite alone can never remove a user.
- **`/invite/<token>`, not another `?t=` on `/login`.** They are different
  events, and the onboarding flow — when there is one — hangs off this one.
  It still ends in the same 303 that `/login` does: the token is out of the
  address bar before anything renders, plus `Referrer-Policy: no-referrer`,
  because here the token *is* the URL. The redemption is one claiming UPDATE
  (so two browsers racing on one chat message cannot both mint a user) and
  then the user row and its back-reference, all in one transaction.
- **A door opens on a POST, never a GET.** The first shape of both doors
  redeemed on the GET: follow the link, get the cookie. Then on 2026-09-04
  two invites were pasted into Slack, and Slack — which fetches every URL
  posted in a channel to build a preview — took both up and minted two
  nameless users before the invitee had seen the message. A login link
  under the same fetch is worse: the previewer walks off with a year-long
  session. So a GET at either door now only *peeks* (`peek_login_link`,
  `peek_invite`: the same `WHERE` as the redemption, as a read) and answers
  with the doorstep, `public/doorstep.html` — the door's look, one button,
  `data-reason` `invite` or `login` — or with the shut door if the link is
  dead. The button's POST is what spends the token; previewers do not
  submit forms, and a person has to mean it, which is also why "accept the
  invite" is a better first moment than a redirect. The form has no
  `action` and no fields: a form without an action submits to the URL of
  the page it is on, GET parameters included, so `t` reaches `/login` and
  the token reaches `/invite/…` without ever being written into the page.
  Not a `User-Agent` blocklist: the list is never complete, and a person's
  browser prefetching a link on hover would be on the wrong side of it.
- Unknown, expired, revoked and already-taken are **one answer**: the
  `link-spent` door under a 401. The remedy is the same for all four, and
  telling them apart tells a guesser something.

## Shared and per-user

Everything divides cleanly along one line:

| Shared (the corpus) | Per user (a taste) |
|---|---|
| `stories` | `votes` |
| `sync()`, `backfill()`, the Syncer, the hourly machine | `models` — and so `scores`, since scores are model output |
| `meta.last_sync_at` | `oof_scores`, `oof_previous`, `vote_predictions` |
| `GET /api/days`, `stories_per_day()` | the round in flight (`current_round`, `round_seq`), `last_train_at` |

The right-hand column is "everything downstream of a vote". The only surprise
in it is `scores`: it reads like a property of the story and is a property of
the model, so it multiplies by users — the one place multi-user has a real
cost, discussed at the end.

Nothing crosses between users. Each brain is private; there is no shared
model, no "people like you", and the operator can read everything only in the
sense that the operator can read the database.

## Schema

Postgres 17 supplies both primitives the users table needs — `sha256()` and
`gen_random_uuid()` are core functions — so minting and checking a token is two
SQL statements and no new crate, which is the constraint the dependency list
puts on this.

```sql
CREATE TABLE IF NOT EXISTS users (
  id            BIGINT PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY (START WITH 2),
  display_name  TEXT,                    -- NULL until the invitee picks one
  created_at    BIGINT NOT NULL,
  round_seq     BIGINT NOT NULL DEFAULT 0,
  current_round TEXT,
  last_train_at BIGINT,
  email         TEXT                     -- NULL for the owner, dev mode, link-only friends
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email));
INSERT INTO users (id, display_name, created_at)
  VALUES (1, 'owner', extract(epoch from now())::bigint)
  ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS login_links (
  token_hash BYTEA  PRIMARY KEY,         -- sha256(token); the token is never stored
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,            -- a week (LINK_TTL_SECS)
  uses       BIGINT NOT NULL DEFAULT 0,
  max_uses   BIGINT NOT NULL DEFAULT 1   -- 1 for a person; the preview asks for 100
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   BYTEA  PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,          -- a year, fixed: no sliding window
  last_seen_at BIGINT NOT NULL,          -- bumped at most daily
  label        TEXT                      -- User-Agent at creation
);
```

Decisions in that shape, each argued once:

- `display_name` is nullable and not unique. The user does not exist as a
  name when the operator creates them, and people pick colliding names and
  rename themselves — so the name is never the handle the CLI addresses a
  user by; `id` or `email` is. NULL is the "invited, not set up yet" state
  the UI asks about.
- `email` is nullable (the owner, dev mode, and a friend handed a link over
  chat have none) and unique on `lower(email)` through an expression index
  rather than `citext`, which is an extension with a privilege story. Stored
  as typed because it is what mail would go to.
- Two credential tables, not one `tokens(kind)`: different lifetimes,
  different columns, different access paths. `authorize()` only ever reads
  `sessions`; redemption only ever reads `login_links`.
- Fixed session expiry with `last_seen_at` bumped daily. A sliding expiry is
  a write per request, and a page load is twenty requests through one
  mutexed connection.
- `BIGINT` epoch seconds, like every other timestamp in the schema;
  `timestamptz` would be nicer and would be the only one.
- No `invited_by`, no `role`. The operator is `AUTH_TOKEN`; columns arrive
  when a query needs them.
- Migration 2 does the reshaping (`name` → `display_name`, constraints off,
  `token_hash` dropped, `email` added last, the two tables created). Dropping
  a column leaves a gap in `attnum`, so `tests/migration.rs` compares column
  order rather than `ordinal_position`.

Every per-user table gains `user_id BIGINT NOT NULL REFERENCES users(id) ON
DELETE CASCADE` and its primary key becomes `(user_id, story_id)`. `models`
becomes `(user_id, rev)` with `rev` a plain `BIGINT`, no longer an identity —
see the decision below. Each index that the queue seeks on or the feed sorts on
gets `user_id` as its **leading column**, because every query that used it now
starts with `user_id = $n`:

```sql
CREATE INDEX IF NOT EXISTS idx_votes_created   ON votes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scores_score    ON scores(user_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_scores_confidence ON scores(user_id, confidence);
CREATE INDEX IF NOT EXISTS idx_scores_raw_offset ON scores(user_id,
  ((score - 0.5::double precision)
   / (0.3::double precision + 0.7::double precision * confidence)));
```

`meta` keeps `last_sync_at` and loses the three round keys.

### Decision: `rev` is per user, and dense

Two options: keep `rev` a global identity (revisions from every user interleave
in one sequence, each user's numbers sparse), or make it per user, allocated as
`COALESCE(MAX(rev), 0) + 1 WHERE user_id = $1` in the `INSERT`. Per user, because
three things read `rev` as a count: the learning curve ("rev 50 is where rounds
began"), the round summary (`rev` and `rev + 1` are the two ends of a round), and
`reset_models`, whose whole contract is that numbering starts again at 1 —
impossible under a shared sequence, and `TRUNCATE ... RESTART IDENTITY` becomes
`DELETE ... WHERE user_id`. The allocation is safe because there is one trainer
per process and one process per app (`--ha=false`, for the syncer's sake, and
now for this one too); the composite primary key turns a race into a loud
error rather than a duplicate.

### Decision: a migration runner, at last

`CREATE ... IF NOT EXISTS` cannot add a column to a table that exists or change
its primary key, so this is the change that ends "no migration system". Keep it
as small as it can be and still be one:

- `meta.schema_version`. Absent on today's databases, which are version 0.
- `MIGRATIONS: &[&str]` in `db.rs`, one SQL batch per version, applied in a
  transaction under the same advisory lock `open_db` already takes, then the
  version stamped. Every process that connects runs this; only the first does
  anything.
- **`SCHEMA` stays the documented, final shape**, and a fresh database gets it
  directly plus `schema_version = N`. The alternative — a fresh database
  replaying every migration from the original `CREATE`s — makes the two paths
  one by construction, at the price of turning `db.rs` into history nobody can
  read the current shape out of. Two paths are acceptable **only** with the
  test below holding them together.
- `tests/migration.rs`: build a version-0 database from a fixture (the
  pre-multi-user `SCHEMA`, frozen as a test string), fill it, `open_db` it, and
  assert three things: `schema_version` is current, every pre-existing row
  belongs to user 1, and `information_schema.columns` + `pg_indexes` +
  `pg_constraint` describe it **identically** to a `TempDb` created fresh. That
  last assertion is the one that matters; without it the paths drift and
  nothing notices until a query that works in tests fails in production.

Migration 1, in one transaction, in this order:

1. `CREATE TABLE users`; insert user 1.
2. For `votes`, `scores`, `oof_scores`, `oof_previous`, `vote_predictions`:
   `ADD COLUMN user_id BIGINT NOT NULL DEFAULT 1` (metadata-only in Postgres 11+,
   no rewrite), `ALTER COLUMN user_id DROP DEFAULT`, add the foreign key, drop
   the old primary key, add `(user_id, story_id)`. Drop and recreate the four
   indexes above with the new leading column.
3. `models`: the same, plus `ALTER COLUMN rev DROP IDENTITY`, and the primary
   key becomes `(user_id, rev)`.
4. `UPDATE users SET round_seq = (SELECT value::bigint FROM meta WHERE key =
   'round_seq'), last_train_at = ... WHERE id = 1`; `DELETE FROM meta WHERE key
   IN ('current_round', 'round_seq', 'last_train_at')`. The round in flight is
   dropped, not carried: its votes are saved and train at the next boundary,
   which is exactly what a stale round does today.

On the real 52k-story database this is about a second, most of it the
`scores` primary key. It runs at boot, under the lock, so the first machine to
start after the deploy does it and the trainer and syncer wait on the lock and
find it done.

**Rollback** is a restore. The previous binary's `INSERT INTO votes (story_id,
…)` fails on the `NOT NULL user_id`, so "redeploy the old image" is not a
rollback here. Take a `pg_dump -Fc` immediately before the deploy (the nightly
one is up to a day old), and restoring it is the whole procedure.

Every PR preview rehearses this migration for free: the preview is restored from
a fresh production dump — version 0 — and the preview app migrates it on its
first boot. The migration PR's own preview is the dress rehearsal.

One consequence for the preview seed after production has migrated: `users`
owns a sequence (`users_id_seq`) and `models` no longer does, and `pg_dump`
reads `last_value` off every sequence the reader can see. `preview_reader`
is covered once the `GRANT ... ON SEQUENCES` block #77 added to
`scripts/setup/fly-db.sh` has been run against production — it is a
*default privilege* for objects the `rekorderlig` role creates, and the
migration runs under `DATABASE_URL`, which is that role. Two ways to lose
that: run the migration as anyone else (the superuser over `fly proxy`, say),
or not have run the block at all — which is the state this plan's own preview
found production in, dying on `models_rev_seq`. `scripts/setup/fly-secrets.sh`'s
check is what says so before a seed does.

## Code

### `User`, a newtype

`pub struct User(pub i64)` with a hand-written `ToSql` delegating to `i64` (ten
lines; the derive is for composite types). The reason is the worst bug this
change can introduce: a parameter list `&[&story_id, &user]` written the other
way round compiles as two `i64`s, returns the wrong user's rows and fails no
test that has one user. With the newtype it does not compile.

### `db.rs`

- `record_vote`, `record_vote_at`, `import_vote`, `delete_vote`,
  `capture_prediction`, `labelled_stories`, `vote_counts` take a `User`.
  `labelled_stories` keeps its `created_at ASC, story_id DESC` order — the
  training set is per user now, and the tiebreaker's reason is unchanged.
- New: `create_user(email, display_name)` (either may be absent; a taken
  email is `UserError::EmailTaken`), `get_user`, `user_by_email`, `find_user`
  (id or email), `list_users`, `set_display_name`, `set_email`,
  `delete_user`. Credentials: `create_login_link(user, max_uses)` (the
  token is `replace(gen_random_uuid()::text, '-', '')` — 122 random bits,
  minted by Postgres so the crate needs no RNG — stored as
  `sha256(convert_to(token, 'UTF8'))` and returned once), `redeem_login_link`
  (one `UPDATE … SET uses = uses + 1 WHERE … AND uses < max_uses AND
  expires_at > now RETURNING user_id`, so two redemptions racing on the last
  use cannot both win), `create_session`, `session_user` (one indexed lookup;
  `last_seen_at` refreshed only when a day old), `delete_session`,
  `revoke_access` (every session and unspent link), `list_sessions`.
  Invites: `create_invite(note)`, `redeem_invite` (one claiming UPDATE, then
  the user row and its back-reference, in one transaction), `list_invites`,
  `revoke_invite(id)`, `delete_invite(id)`.
  `convert_to`, not `$1::bytea`: casting text to `bytea` parses it as bytea's
  escape format rather than taking its bytes, and a token containing a
  backslash would hash to something other than what was minted.
- `get_meta`/`set_meta` stay for `last_sync_at`; the round state reads and
  writes `users` columns.

### `service.rs`

Every per-user function gains a `User` parameter: `load_model`,
`train_and_score`, `store_held_out`, `rescore_all`, `score_missing`, `feed`,
`vote_log`, `training_queue` and its draws, `cold_queue`, the round functions,
`model_at`, `paired_flips`, `explore_queue`, `explain`, `score_distribution`,
`stats`, `judge`, `model_history`, `reset_models`. Mechanical, with three
places that are not:

- **`LEFT JOIN`s scope in the `ON` clause, never the `WHERE`.** `STORY_JOINS`
  and `UNSCORED_FROM` become `LEFT JOIN scores sc ON sc.story_id = s.id AND
  sc.user_id = $u` (and the same for `votes`). Put `sc.user_id = $u` in the
  `WHERE` and the left join is an inner join: unscored stories vanish from
  Explore, which shows them on purpose. Leave the user out altogether and with
  two users every story joins two score rows — the feed lists everything twice,
  half of it ranked by someone else's taste.
- **`UNJUDGED` is per user.** `NOT EXISTS (SELECT 1 FROM votes v WHERE
  v.user_id = $u AND v.story_id = s.id)`, served by the `(user_id, story_id)`
  primary key. Without the user, one person's skip hides a story from
  everyone's deck. It stays an anti-join for the reason in the comment above
  it; the planner lesson from the port applies to the new shape too, so the
  EXPLAIN test in `tests/service.rs` must be re-pointed at the composite
  `idx_scores_raw_offset` and confirm the probe still seeks — a
  `(user_id, expr)` index is only used when the query says `user_id = $u`
  *and* ranges on the expression, which is what the probes do and what a
  careless rewrite stops doing.
- **`sync()` and `backfill()` score for every user.** They are corpus
  operations, but "an unscored story is invisible to the feed" holds per user
  now, so the `score_missing()` they end with becomes a loop over every user
  with a model. Score only the caller's — there is no caller; the hourly
  machine is the operator — and every other user's feed stops receiving new
  stories, silently, with the sync reporting success.

`ModelCache` becomes `Mutex<HashMap<User, Arc<Cached>>>`; `load_model`
revalidates against `MAX(rev) WHERE user_id = $u`. The poison-recovery and
"never move the cache backwards" rules carry over per entry.

### `trainer.rs`

One run at a time still, but the queue is of users: `running: Option<User>`,
`pending: VecDeque<User>` (a user already queued is not queued twice — that is
the coalescing rule, now per user), `last: HashMap<User, Value>`.
`request(user)` and `status(user)`. The status **must** be the requesting
user's: `train.js` polls `GET /api/train` until nothing is running or pending
and then asks for its round summary. If `running` means anyone's run, Alice's
poll returns while Bob's retrain is the one in flight, her summary reads
`trained: false`, and the round is marked spent with the old model's numbers
in it.

The Syncer is untouched.

### `server.rs`

`authorize()` returns `Auth::User(User)`, `Auth::Operator` or `Auth::Denied`.
A Bearer that matches `AUTH_TOKEN` in constant time is the operator; any
other Bearer, or the `rk_token` cookie, is looked up with `session_user`.
Two paths need no session, because they are how a session begins:
`/login?t=…` spends a login link, and `/invite/<token>` takes up an invite
and mints the user it belongs to. A GET at either is a look (`at_the_door`):
the doorstep for a live link, the shut door for a dead one, nothing spent.
The POST from the doorstep's button is what opens, and both end in
`open_the_door()`: a session, the cookie, and 303 to `/`, so the token is
out of the address bar before the app renders — plus `Referrer-Policy:
no-referrer` on the doorstep and the redirect alike, because at `/invite`
the token *is* the URL. Unknown, expired, revoked and spent are one 401 on
purpose.

Nobody gets a page rather than a paragraph. `signed_out()` answers 401 with
`public/signed-out.html` — the app's header, the app's card, the app's
stylesheet — because being turned away is a normal thing to happen to a
person: an invite is opened on a phone weeks later, a cookie expires, someone
signs out. It names both ways in — a login link back to the account you have,
an invite if you have none — and `data-reason` on its root element picks
between "you're signed out" and "that link is used up"; the server rewrites
one attribute, so every word of the copy lives in the HTML.

The two are not interchangeable, and the page has to say so: an invite mints
an account, so a reader who already has one and takes up an invite ends with
two, their votes split between them and neither model any good. The copy
therefore sends anyone who has signed up to a login link — minted on a device
still signed in (Brain → You → Add a device), or by the operator — and offers
the invite only to somebody who never signed up. This is where mailing a link
lands when it is built: a signed-out reader with no other device currently has
to ask, which is the one thing on this page that still needs a person. The page loads no modules: it has to
render when every route it could call answers 401. Its stylesheet, the icons
and the preview card are the files an unauthenticated request may have
(`PUBLIC_FILES`); everything else under `public/` still needs a session.

Routes say what they accept:

| Route | Accepts |
|---|---|
| `GET /login`, `GET /invite/{token}` | anyone — the doorstep (or the shut door); spends nothing |
| `POST /login`, `POST /invite/{token}` | anyone — they are how a session begins |
| `GET /styles.css` | anyone — the 401 page wears it, and a door that arrives undressed is worse than no door |
| `GET /favicon.ico`, `/favicon.svg`, `/apple-touch-icon.png`, `/og.png` | anyone — a browser asks for the icon unprompted, and a chat's previewer fetches the card named by the doorstep's `og:image` with no session |
| `POST /api/sync`, `GET /api/sync` | user or operator — a fresher corpus is not a per-user act, and Brain's button keeps working |
| `GET /api/invites`, `POST /api/invites` (`{note?}` → 201 with the invite and its link), `POST /api/invites/{id}/revoke` | operator only; a user gets 403 — this is the whole ledger, whoever sent each row |
| `GET /api/users`, `POST /api/users` (`{email?, displayName?, uses?}` → 201 with the row and a link — a user made outright, not an invite), `POST /api/users/{id}/link` (`{uses?}`) | operator only; a user gets 403 |
| `POST /api/me` (`{displayName}`), `POST /api/me/link` (a one-use link for the caller's own next device), `POST /api/logout` (this device only) | user |
| `POST /api/me/invites` (`{note?}` — who it is for → 201 with the invite, the caller's own list and the cap; 409 at the cap, 400 past `NOTE_MAX`), `GET /api/me/invites`, `POST /api/me/invites/{id}/revoke` | user — their own invites and nobody else's; the operator gets 403, having no row to be the sender of |
| static files | user or operator — the operator loading the UI gets 403s from every `/api/*` route below, which is correct: it is not a login |
| everything else | user |

A user calling an operator route gets a 403, not a 401: the credential was
fine, the role was not, and a 401 would make the browser flow tell them to
open their link again.

The lookup costs one indexed query per request, static files included. A
first visit is about twenty requests, nineteen of them 304s after the ETag
work, so roughly twenty round trips over 6PN at a fraction of a millisecond
each. Not worth a cache; if it ever is, a positive cache keyed on the token
with a short TTL is the fix, and the TTL is what bounds how long a revoked
session keeps working from another process.

`POST /api/import/vote` restores into the caller's history, `GET /api/export`
exports it, `POST /api/vote`'s `votes` count is the caller's. `/api/stats`
carries `user: {id, displayName, email, createdAt}` so the UI can say who is
signed in — and ask for a name while `displayName` is null.

### `main.rs`

- `invite create [--note N] [--url BASE]` prints the link once;
  `invite list` is the ledger (one line each: the note, when it was sent, who
  sent it — a user by name, or the operator — and whether it is unopened,
  expired, voided, or taken up and by whom); `invite revoke ID` voids an
  unspent one, whoever sent it; `invite remove ID` deletes one nobody is left
  of (unopened, or its user since removed). `user invite` is kept only as a
  signpost to these — it is not how a user is made any more.
- `user link ID|EMAIL [--uses N]` mints a fresh login link (a new phone, a
  lost cookie); `user list` (with how many devices are signed in), `user
  rename ID|EMAIL NAME`, `user email ID|EMAIL ADDRESS|-`, `user revoke
  ID|EMAIL` (every device signed out, unspent links voided), `user remove
  ID|EMAIL --yes` (cascades the votes — the only destructive one, and it says
  so). A link is a path unless `--url` or `REKORDERLIG_URL` supplies the
  host: the server does not know its own hostname. On the live machine these
  run as `fly ssh console -C "/app/rekorderlig invite create --note …"`,
  which has `DATABASE_URL` and needs nothing else.
- `train`, `reset-models` and `stats` take `--user ID|EMAIL`; `train` and
  `stats` also take `--all`. `reset-models` has no `--all` deliberately: it
  exists for a vocabulary change, which affects everyone, but forgetting
  every user's model in one command with one `--yes` is a bigger accident
  than typing it once per user.
- `sync` and `backfill` are unchanged on the command line; their scoring loop
  changed underneath them.

### Front end

The cookie is the identity and every request already carries it. Two things
show: `chrome.js` puts the display name in Brain's tagline (the one view
whose tagline was empty), and `onboard.js` runs the welcome flow while
`displayName` is null — the state an invite mints. It is a view like the other
five, with its own section and its own path, but nothing navigates to it:
"has this person been through it" is a fact about the row, so `onboardingRoute()`
overrules the address bar at boot in both directions — the flow for a nameless
user whatever link they arrived on, the app for anyone else who lands on
`/onboard`. The tab bar goes while it runs, because an onboarding you can click
past is a prompt. Two screens, then the ordinary Train round; a tutorial round
would need explaining as well as the real one. `saveDisplayName()` is the one
way a name changes; Brain's "You" panel (rename, sign out) goes through it
too, so the two cannot disagree. Sign out is `POST /api/logout` and this
device only. "Add a device" is the self-service half of `user link`: a
signed-in user mints a one-use link for their own account and the panel shows
it once with a copy button —
"I have a second phone" should not need the operator, and a session being a
device is what makes it safe: the new device is one more session, not a copy
of this one. Inviting a friend is a panel of its own rather than one more
button in that row, because it is the one act in the app that makes another
person an account: "Write an invite" opens a card to address, the submit is
what mints the row, and only then is there a link to copy. Under it sits the
list of invites *you* have sent — what became of each, both names once they
differ, and a Void button on the ones nobody has opened — and above it the
five pips. That list is the reason `invited_by` is in the schema rather than
only in the operator's head, and the reason it is the caller's own list, never
the whole ledger. `app.js` no longer strips `?token=`: nothing secret is in the
URL, and a 401 on the first request stops the boot and says so in the
tagline — a reload from there meets the door, which is the page that can
explain. `judgedIds` is per browser and stays so.

## Tests

The existing suites keep passing with `User(1)`; the new coverage is about the
second user, because every bug specific to this change is invisible with one.

- `tests/migration.rs` — as described under the runner: version 0 in, current
  out, rows on user 1, fresh and migrated shapes identical.
- `tests/auth.rs` — nobody gets in without a session (and the old `?token=`
  is nothing); the operator may sync and administer and gets 403 from every
  user route, a user gets 403 from the operator's; a link is spent once,
  starts a year-long HttpOnly cookie (Secure over HTTPS), works as a Bearer,
  the email is unique case-insensitively, logout ends one device and not the
  other; a shared link serves its uses then stops, the cap holds, an expired
  link never starts; two users see only their own votes and exports;
  revoking ends every device and voids the unopened link; a GET at either
  door shows the doorstep and spends nothing — the ledger still says
  unopened and no user exists — and the POST is what opens; an invite mints
  the user who accepts it and the ledger reads back the name *they* chose,
  once only; an invite can be voided before it is opened and not after, and an
  expired one mints nobody; the ledger is the operator's and a user gets 403
  from it; a user invites a friend with a name written on it and the ledger
  says who sent it and holds both names, their own list is theirs alone (Bob's
  is empty where Alice's has a row), they may void their own invite and nobody
  else's, the cap counts down in `cap.left` and holds at the sixth, a taken-up
  or voided invite makes room again, an over-long name is refused and costs
  nothing, and the operator — having no row to be the sender of — gets 403
  from `/api/me/invites`;
  dev mode is the owner unless a session says otherwise. The door is in there too: `/` is
  HTML carrying the invite line, `/styles.css` is public and `/app.js` is
  not, and a dead link shows the spent half rather than both.
- `tests/styles.test.mjs` — the door's and the doorstep's `data-reason`
  names, which live in the HTML, the stylesheet and one Rust rewrite each:
  miss one and both halves of the page render at once. And the doorstep's
  form: `method="post"`, no `action`, no fields.
- `tests/welcome.test.mjs` — the invitee with no name, walked through: the
  flow opens over the link they arrived on and takes the tabs away, one
  `POST /api/me` saves the name and *advances* rather than ending it, the last
  button lands on a real dealt round, Brain shows the same name, and `/onboard`
  cannot be walked back into once it is done.
- `tests/service.rs` — a two-user isolation case per surface: `feed` (no
  duplicate rows, ranked by the caller's scores), `training_queue` (B's skip
  does not hide a story from A), `explore_queue`, `vote_log`, `stats`,
  `deal_round`/`round_summary` (two rounds in flight at once, one per user),
  `model_history`, `reset_models` (B's revisions survive A's reset, A's
  numbering restarts at 1), `sync()` scoring both users' new stories. The
  EXPLAIN test is re-pointed at the composite index.
- Trainer — two users requested while idle both run; the same user requested
  mid-run coalesces to one follow-up; `status(A)` is quiet while B trains.

## Phases

Each lands green and deployable on its own.

There is no Phase 0. The prerequisite would have been the Postgres plan's
Phase 7 — deleting the SQLite importer and the cutover scripts — because the
cutover's rollback path was "old image plus the retained volume", and that
path closes the moment a second user's votes exist, since the importer only
went one way. #76 did that deletion, which is what marks the rollback window
lapsed; multi-user can start.

**Phase 1 — the schema, with the app still single-user.** `users`, `user_id`
everywhere, the runner, migration 1, the `User` newtype threaded through
`db.rs` and `service.rs`, `ModelCache` and the trainer per user. `server.rs`
passes `User(1)` for every request and `authorize()` is untouched, so the
running app behaves identically and can be checked the way the port was: the
same `/api/*` responses field for field against `main`, and the same retrained
`models.payload` byte for byte. This is the deployable, verifiable half, and
it is the half that carries all the risk.

**Phase 2 — users.** `authorize()` resolves sessions, the operator role,
`GET /login`, the `user` subcommands, the operator's `/api/users` routes,
`--user` on the CLI, the welcome prompt and the name in the tagline.
Behaviour changes here, once: the old `AUTH_TOKEN` cookie stops authorizing
user routes. (Landed together with phase 3, below.)

**Phase 3 — previews and docs.** The preview workflow, after its deploy step,
calls `POST /api/users/1/link` with `{"uses": 100}` using the deploy's
operator token and puts *that* link in the PR comment — the preview reader is
then the owner's copy in the preview database and sees the real votes and
model, exactly as before. Spending or rotating it touches nothing in
production; they are different databases. The seed scrubs `users.email`,
`sessions` and `login_links` out of the copy, guarded so a dump from before
production migrated still restores. (Invites are scrubbed too, once they
exist: an unspent one would mint a real account on a throwaway app, and a
spent one names who took it up.) The comment's caveat about visibility
now covers every user's votes, and says so. CLAUDE.md, README and
`docs/design/deploy.md` describe the result.

**Phase 4 — cutover.**

1. `pg_dump -Fc` of production, kept beside the nightly one.
2. `fly deploy`. Watch the app log for the migration; `rekorderlig stats`
   over `fly ssh console` shows user 1 owning every vote.
3. `rekorderlig user link 1 --url https://…` (and `user rename 1 <name>`,
   `user email 1 <address>`). Open the printed link on each device once; the
   old cookie is dead and the 401 page already says what to do. One use per
   link, so one `user link` per device — or `--uses 3` once.
4. Confirm the hourly machine's next run succeeds — it sends the operator
   token and should not notice anything happened.
5. `rekorderlig invite create --note <friend>`, paste the link into a chat;
   `rekorderlig invite list` says when they took it up.

**Phase 5 — invites as an object.** The invite becomes a row of its own
(`invites`, migration 3) and stops being "a user the operator made in advance
plus a link". `/invite/<token>` mints the user; `invite create|list|revoke`
and `/api/invites` are the operator's ledger. `user invite` retires. Nothing
about an existing user changes: `login_links`, sessions and the door are
untouched, and the ledger starts empty — the people invited under the old
shape are already users. The onboarding flow, when it comes, hangs off
`/invite`: it lands the user at `/`, and a `/welcome` route with no token in
it is where more than one question would go.

**Phase 6 — friends invite friends.** `invites.invited_by` (migration 4), a
user's own `/api/me/invites` routes, and Brain's Invite panel: the composed
card, the five pips, and the list of the ones they have sent. The operator's
ledger gains a column and answers one more question; nothing else about an
invite changes — same table, same week, same one-use door, same 401 for
unknown, expired, revoked and spent. Existing rows keep `invited_by` NULL,
which is what "the operator sent it" is spelled as from here on.

## Cost, and where this stops scaling

`scores` is the only table that grows with users × corpus: 52k rows and about
8 MB with indexes per user, rewritten on that user's every retrain (0.8 s) and
appended to on every sync for every user with a model (new stories only,
milliseconds each). Ten users is 80 MB and nothing else changes shape; the
`ModelCache` holds one parsed model per active user at roughly a megabyte
each. The 1 GB database volume also holds one full restore of production per
open PR, so previews are what feel this first. The eventual fix, if a handful
becomes a crowd, is scoring on read rather than materialising every user's
score for every story — a different design, not a tuning of this one, and not
worth having before it is needed.

## Out of scope

Anything shared between brains (a group feed, "people like you", seeding a new
user from an existing one); passwords or third-party sign-in; mailing a login
link (the schema is ready for it — see "Email is a transport", and the design
in `docs/design/email.md`); an admin UI
(the CLI and the operator endpoints are the administration — the invite list
in Brain is the caller's own, which is a user looking at themselves rather
than at other people); per-user sync windows or corpora; pruning `models`
(per user now, same rule as before, still nothing does it).

## Fails-silently list

Everything here returns rows, passes single-user tests, and is wrong.

1. A `LEFT JOIN` on `scores` or `votes` without the user in its `ON` clause →
   duplicate feed rows ranked by another user's taste.
2. `UNJUDGED` without the user → one user's vote or skip hides the story from
   every deck.
3. The composite expression index not matched (a probe missing `user_id = $u`,
   or the casts drifting from `db.rs` again) → the queue seq-scans per card.
4. `score_missing` after a sync scoring one user → the others' feeds stop
   receiving new stories while the sync reports success.
5. Trainer status not per user → a round summary read off the wrong retrain
   and marked spent.
6. Tokens stored in plaintext → every PR preview is a list of every user's
   login. Emails not scrubbed from the seed → every preview is a list of
   everyone's address.
7. The fresh `SCHEMA` and migration 1 drifting apart → a query that passes
   every test against a fresh database fails against production.
8. A fresh database without user 1 → dev mode has nobody to be, and the fresh
   and migrated databases disagree about who owns the first vote.
9. `list_invites_by` or the scoped revoke without `invited_by` in its
   predicate → one friend's invite list is everybody's, and anyone can void
   anyone's link. The operator's whole-ledger route is the one that is
   supposed to see all of them.
