# Testing

What each test file actually checks. Why the front end is tested by
running it rather than by reading its source is `docs/design/frontend.md`'s
job, not this file's.

The Rust tests need a Postgres server: `docker compose up -d`, or point
`REKORDERLIG_TEST_PG` at one (host and port only). `TempDb` creates and drops
a database per test; there is deliberately no skip-if-no-server path.
`tests/reconnect.rs` kills the connection on purpose — the Fly-suspend case;
the retry rule it found is commented at `is_disconnect` in `src/db.rs`.
`tests/migration.rs` builds a version-0 database from the frozen pre-users
schema, opens it (every migration runs in turn), and asserts its catalogs are
identical to a fresh one — the test that lets `SCHEMA` and `MIGRATIONS` be
two paths; it compares column *order*, since a dropped column leaves a gap
in `attnum`. `tests/users.rs` is the second user in the room: every
isolation bug passes with one. `tests/auth.rs` is the HTTP surface of that:
links spent once, a GET at either door spending nothing (the link previewer's
request), invites minting the user who accepts them, the ledger reading back
the name they chose and who sent it, a user's own invites being theirs alone
to see and void, the cap, sessions per device, the operator's 403s,
revocation, dev mode.

The front end is tested by running it — see `docs/design/frontend.md`'s
"Tested by running it" section for the DOM stub and how a test mounts a
view. One `mount()` per file; boot scenarios and the one-shot links get
their own files (`boot-unauthorized`, `welcome` — the invitee with no name
yet, mounted on another path and walked through the whole flow —
`add-device`, `invite-friend` — where the assertion that matters is that
opening and cancelling the card send nothing). `requests` carries each
call's parsed body, so a panel can be held to *what* it sent.
`styles.test.mjs` holds the only text assertions, for cross-file invariants
nothing at runtime notices breaking: the certainty bands' colours, the
door's and the doorstep's `data-reason` names, and the three pages naming
the same icons and preview card — files that exist, and a card at the one
size every unfurler agrees on.
