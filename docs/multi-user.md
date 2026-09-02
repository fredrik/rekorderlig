# Multi-user: the plan

Written against `main` at `1f85e01`, the first schema change after the
Postgres port. The shape of the change is small to say and wide to make: the
corpus stays shared, everything downstream of a vote becomes one user's, and a
user is a row who signs in with a link.

## What a user is

**A user is a row; a credential is a session.** The row is `users`: a
display name the user picks for themselves, an email the operator may know
them by, and nothing that lets anyone in. What lets someone in is a
**login link** — short-lived, counted-use, spent at `GET /login?t=…` — which
hands the browser a **session**: a year-long `rk_token` cookie, one per
device, revocable one at a time or all at once. The operator creates a user
(`rekorderlig user invite --email …`) and pastes the printed link into
whatever chat they share; the invitee opens it once per device and, on the
first visit, is asked what to call them.

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
scrubs them. All of that is one later phase, and `LINK_TTL_SECS` is the
constant it shortens from a week to minutes. Slack pairs its link with a
six-digit code because the link opens in the mail app's webview rather than
where you started; installed from the manifest, this app has the same
exposure, which is one more reason operator-pasted links stay primary.

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
`scripts/fly-db-setup.sh` has been run against production — it is a
*default privilege* for objects the `rekorderlig` role creates, and the
migration runs under `DATABASE_URL`, which is that role. Two ways to lose
that: run the migration as anyone else (the superuser over `fly proxy`, say),
or not have run the block at all — which is the state this plan's own preview
found production in, dying on `models_rev_seq`. `scripts/fly-db-secrets.sh`'s
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
`GET /login?t=…` is the one path that needs no session: it spends the link,
inserts a session, sets the cookie and answers 303 to `/`, so the token is
out of the address bar before the app renders. Unknown, expired and spent
links are one 401 on purpose. Routes say what they accept:

| Route | Accepts |
|---|---|
| `GET /login` | anyone — it is how a session begins |
| `POST /api/sync`, `GET /api/sync` | user or operator — a fresher corpus is not a per-user act, and Brain's button keeps working |
| `GET /api/users`, `POST /api/users` (`{email?, displayName?, uses?}` → 201 with the row and a link), `POST /api/users/{id}/link` (`{uses?}`) | operator only; a user gets 403 |
| `POST /api/me` (`{displayName}`), `POST /api/me/link` (a one-use link for the caller's own next device), `POST /api/logout` (this device only) | user |
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

- `user invite [--email E] [--name N] [--url BASE]` prints the login link
  once; `user link ID|EMAIL [--uses N]` mints a fresh one (a new phone, a
  lost cookie); `user list` (with how many devices are signed in), `user
  rename ID|EMAIL NAME`, `user email ID|EMAIL ADDRESS|-`, `user revoke
  ID|EMAIL` (every device signed out, unspent links voided), `user remove
  ID|EMAIL --yes` (cascades the votes — the only destructive one, and it says
  so). The link is a path unless `--url` or `REKORDERLIG_URL` supplies the
  host: the server does not know its own hostname. On the live machine these
  run as `fly ssh console -C "/app/rekorderlig user invite --email …"`, which
  has `DATABASE_URL` and needs nothing else.
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
whose tagline was empty) and renders a welcome prompt above every view while
`displayName` is null — a fresh invitee lands on whichever tab the link
opened, so the question goes where they are. `saveDisplayName()` is the one
way a name changes; Brain's "You" panel (rename, sign out) goes through it
too, so the two cannot disagree. Sign out is `POST /api/logout` and this
device only. "Add a device" is the self-service half of `user link`: a
signed-in user mints a one-use link for their own account and the panel shows
it once with a copy button —
"I have a second phone" should not need the operator, and a session being a
device is what makes it safe: the new device is one more session, not a copy
of this one. `app.js` no longer strips `?token=`: nothing secret is in the
URL, and a 401 on the first request stops the boot and says so in the
tagline. `judgedIds` is per browser and stays so.

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
  revoking ends every device and voids the unopened invite; dev mode is the
  owner unless a session says otherwise.
- `tests/welcome.test.mjs` — the invitee with no name: the prompt shows, one
  `POST /api/me` saves it, and the tagline, the panel and the prompt redraw.
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
production migrated still restores. The comment's caveat about visibility
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
5. `rekorderlig user invite --email <friend>`, paste the link into a chat.

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
link (the schema is ready for it — see "Email is a transport"); an admin UI
(the CLI and the operator endpoints are the administration); per-user sync
windows or corpora; pruning `models` (per user now, same rule as before, still
nothing does it).

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
