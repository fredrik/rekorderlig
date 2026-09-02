# Deploy

Why the deploy is shaped the way it is: two apps, one app machine, a
scheduled machine for freshness, dump-based backups and previews. The shape
itself is summarised in CLAUDE.md; this file is the reasoning.

## Build identity

Both deploys pass `--build-arg GIT_SHA` and `--build-arg BUILD_TIME` so the
binary knows which commit it is (see `src/version.rs`); the answer is the
last line of Brain's Data panel, the first line of the boot log in
`fly logs`, and `version` on `GET /api/stats`. "Built" is the image build
time, which is within a minute of the deploy in this pipeline — nothing at
runtime knows when `fly deploy` ran, and the machine's own start time
changes on every suspend and resume. The preview passes the PR **head**
sha, not `GITHUB_SHA`, which on a pull_request event is a merge commit that
exists nowhere you can link to. The Dockerfile declares the two args
*after* the dependency layer so they don't recompile the world.

## The tests are in front of the deploy, not beside it

`Deploy` and `CI` used to trigger on the same event — `push: branches:
[main]` — and run as two independent workflows. Nothing connected them, so a
merge to `main` started `flyctl deploy` and `cargo test` at the same moment
and shipped whatever the build produced, whatever the tests went on to say.
A red `main` was a notification, not a brake.

That was survivable only because of the check on the pull request, which
does gate the merge button. Two paths get past it, and both land straight on
production:

- a **direct push to `main`** — no PR, and no branch protection requiring
  one;
- a merge whose **base moved after the PR's last run**. The merge commit is a
  combination neither run tested; under the old shape it was tested in
  parallel with its own deploy, which is to say afterwards.

The fix is the smallest of the three options the issue weighed: `deploy`
`needs:` a `test` job in the same workflow, so the tests run on the pushed
commit and the deploy is a downstream job that never starts if they fail.
`workflow_run` was the alternative — trigger `Deploy` when `CI` succeeds —
and it keeps the workflows separate at the price of the usual awkwardness:
runs attributed to a commit view that is not the one under test, re-runs
that need the upstream run, and permissions that behave differently. Branch
protection is worth having as well, but it only closes the first hole; the
stale base survives it.

`ci.yml` then loses its `push: [main]` trigger. Keeping it would run the
suite twice on every merge, and the copy nothing gates is the one that reads
as reassurance while meaning nothing.

The two gates share **one definition** of the suite:
`.github/workflows/tests.yml`, a `workflow_call` workflow holding the
Postgres service and the two commands, called by `CI` on a pull request and
by `Deploy` on `main`. Duplicating those steps into `deploy.yml` would have
been fewer files and one more thing to keep identical — and the copy that
drifted would be the copy guarding production. The nesting shows up in check
names (`CI / test / test`), which is what a required-status-check rule must
name if one is added.

The deploy workflow's `concurrency: deploy` now covers its test job too, so
two merges in quick succession queue rather than race. That was already true
of the deploys themselves and is the behaviour worth having: the second
deploy should carry the second commit's verdict.

Previews stay ungated on purpose. `preview.yml` deploys a PR's app on the
same terms as before, because a broken preview costs a PR comment and is
destroyed when the PR closes.

## Two apps, and exactly one app machine

The deploy passes `--ha=false`, because a deploy that finds no machines
otherwise creates two, and `Syncer` refuses a concurrent run only within its
own process — a second machine makes "one sync at a time" unenforceable.
(The model cache revalidates against each user's `MAX(rev)` and the round
lives on `users`, so those are already safe across processes; the syncer is
the one that is not — and now the trainer's `MAX(rev) + 1` allocation, which
counts on being the only writer.) This went unnoticed for as long as the app had one machine
created before the workflow existed: deploys updated it in place and the
create-two default never fired.

`rekorderlig` (`Dockerfile`, `fly.toml`) is the app machine and holds
nothing — no volume, no data — so it can be destroyed and redeployed without
losing a vote. `rekorderlig-db` (`fly.db.toml`) is stock
`postgres:17-alpine` on a volume, publishing **no services**: the only way
in is 6PN, the organisation's private WireGuard mesh, where it answers as
`rekorderlig-db.internal:5432`. Anything outside that mesh — a laptop, a CI
runner — reaches it through `fly proxy`, which is why
`scripts/fly-pg-proxy.sh` exists. `DATABASE_URL` is a secret on the app,
since it carries a password. Not Fly Postgres and not a managed provider:
this is a single-user app whose whole database is tens of megabytes, and the
operational surface of anything larger would dwarf it.

No TLS on that connection, deliberately. 6PN is already encrypted end to
end, and the alternative pulls rustls and a certificate story into a binary
whose whole shape is one static musl file. `connect()` in `src/db.rs` is the
one place that changes if this ever has to cross a public network.

## Backups

Backups are a nightly `pg_dump -Fc` kept as a workflow artifact
(`.github/workflows/backup.yml`). SQLite needed no counterpart — Fly
snapshots the volume daily and the database was one file on it — but a
volume snapshot of a running Postgres is a crash-consistent copy that needs
recovery, not a backup you can read. Ninety days, tied to this repository: a
deliberate floor rather than a plan. Rehearse a restore quarterly; the
workflow header says how. A backup nobody has restored is not a backup.

## Keeping the corpus fresh

Machines **suspend** to RAM when idle (`fly.toml`), so the process is frozen
between visits. Nothing in-process fetches on a timer (there is no
`REFRESH_HOURS` any more — a timer that only ticks while awake was never a
freshness guarantee). Keeping the corpus fresh is external, and the outside
is now a **Fly scheduled machine** rather than a GitHub cron: a second
machine in the same app, `--schedule hourly`, running
`rekorderlig sync-remote`, which POSTs `/api/sync` for today (the request
wakes the app machine) and waits. `scripts/fly-sync-machine.sh` owns its
shape; `.github/workflows/deploy.yml` runs it after every deploy.

Three properties of that trigger decide how it is maintained, and all three
are why it is a reconciler script and not a one-off command:

- The schedule is an **interval anchored at machine creation**, not a cron
  expression. Recreating the machine moves the run, so the script rebuilds
  it only when the image, schedule, restart policy, command or environment
  actually differ.
- `fly deploy` does not manage it. A schedule cannot be expressed in
  `fly.toml`, and giving it a process group there would have deploy start a
  machine whose whole job is to exit — so it lives outside the deploy, which
  is free to leave it alone, wipe its schedule, or destroy it. The reconcile
  step after each deploy makes all three outcomes the same.
- It is in the **same app** (Fly injects `AUTH_TOKEN` into every machine the
  app owns, so there is no second copy of the secret) and it is a **separate
  machine**. It could reach the database directly now that the database is
  not a file on one volume — it deliberately does not. `sync-remote` is an
  HTTP poke, so the trigger holds no credential and no schema, and the app
  it wakes stays the only writer.

The failure signal moved with it: no red Actions run, but a non-zero exit in
`fly logs`, `lastError` on `GET /api/sync`, and a stale "last fetched" line
in the Brain tab.

## Previews

The PR preview workflow seeds each preview with **production's data**: on
first deploy it creates `preview_pr_<n>` on the same database machine and
restores a fresh `pg_dump` of production into it, then `ANALYZE`s (without
statistics the training queue seq-scans the whole corpus per card — correct,
and slow enough to look like a bug). Every deploy still kicks one plain-curl
sync to top up today's stories; a preview is thrown away and does not want
an hourly machine of its own. The close job drops that database *and sweeps
any left behind by earlier PRs* — the job can be skipped entirely (a fork
PR, a failed run, Fly down), and an orphaned preview database is invisible
until the volume fills.

Seeding happens **on first deploy only**, so a redeploy keeps whatever the
preview holds — including votes cast while trying the change out, which is
the point. There is deliberately no script for refreshing one in place: that
would be a second copy of the seed, pointed at a live database, run from a
laptop holding a production dump. To start a preview over, drop its
`preview_pr_<n>` (`scripts/fly-pg-proxy.sh`, then `DROP DATABASE ... WITH
(FORCE)` as `preview_admin`) and re-run the deploy — the seed step finds no
database and takes a fresh snapshot.

A preview is a copy of production, so two things are taken out of the copy
before it serves anyone: `users.email` (the one personal column) and the
credential tables (`sessions`, `login_links` — hashes of production's
logins, but a preview has no business honouring them). The deploy then mints
its own way in: a login link for user 1 with a hundred uses, through
`POST /api/users/1/link` with the preview's operator token, and that is the
link in the PR comment. Opening it signs the reader in as the owner's copy
and shows the real votes and model, exactly as before; spending or rotating
it touches nothing in production, since they are different databases.

Two credentials do the preview work and neither is production's:
`preview_reader` can only read `rekorderlig`, `preview_admin` can only
CREATEDB and owns nothing else. `scripts/fly-db-setup.sh` creates them.
"Read" means tables **and sequences**: `pg_dump` reads `last_value` off every
sequence to restore it, and the identity column on `users` owns one
(`users_id_seq`; `models_rev_seq` went with multi-user, since `rev` is
allocated per user now), so a reader granted tables alone connects fine and
the seed dies on the sequence. It has bitten twice for that reason — the
grant was fixed for `models_rev_seq`, then multi-user added `users_id_seq`
and the seed broke again — so the rule is every sequence, never a named one.
`scripts/fly-db-secrets.sh` checks, as the owner, that the reader can SELECT
every table and sequence before it sets any secret.
