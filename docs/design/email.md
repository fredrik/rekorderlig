# Mailing a login link

Why email delivery is a transport and nothing more, what Fly.io gives it and
does not, and the plan for building it. Nothing in this file is built yet;
CLAUDE.md says so, and the line there changes when the first phase lands.
The multi-user plan (`docs/multi-user.md`, "Email is a transport, not a
mechanism") reserved the space — this is the design that fills it.

Written against `main` at the close of multi-user phase 5, 2026-09-03.

## The shape in one paragraph

A person who is signed out types their address into a form on the door page
and is told, whatever they typed, that a link is on its way if the address
belongs to a reader. Off the request thread, the app looks the address up,
mints a one-use login link that lives fifteen minutes, and POSTs one plain
text message to a transactional mail provider over HTTPS with the `ureq`
agent already in the tree. The operator gets the same transport as a flag:
`rekorderlig user link 7 --mail` sends instead of printing. No new table, no
new crate, no migration. The provider sees every mailed link, so a mailed
link is short and single-use; the token still reaches the database as a
hash, and previews still hold no address and no key.

## What Fly gives this, and what it does not

Fly has no mail primitive. Checked 2026-09-03: `fly extensions` provisions
Arcjet, Kubernetes, Sentry, Tigris storage, Upstash Vector and Wafris — no
mail service among them, and none announced. What Fly does give is four
smaller things, and the design leans on each.

- **Outbound SMTP is open but useless here.** Port 25 is not blocked per
  account (Fly staff, August 2026), and 587/465 work, but Fly offers no
  customer PTR records, so direct-to-MX delivery from a machine's IPv6 is
  refused or junked by every large receiver. Fly's own recommendation is to
  relay through a transactional service. Relaying over SMTP would mean a
  mail crate plus a TLS stack in a binary whose shape is one static musl
  file (see `docs/design/deploy.md` on why the Postgres connection has no
  TLS either). Every serious provider also speaks a one-call HTTPS JSON API,
  and the binary already has an HTTPS client. So: **HTTPS to a provider,
  never SMTP, and no new dependency.**
- **Secrets are per app, injected into every machine of that app.** The
  provider key is `fly secrets set MAIL_API_KEY=… --app rekorderlig`. The
  preview apps are other apps and never receive it, so the mailer is *off*
  in every preview by construction rather than by a scrub step — the same
  property `scripts/fly-sync-machine.sh` relies on for `AUTH_TOKEN`. The
  hourly `rekorderlig-sync` machine will also carry the key, harmlessly; it
  runs `sync-remote` and nothing that mails.
- **A machine knows its app.** Fly injects `FLY_APP_NAME`, so the base of a
  mailed link defaults to `https://$FLY_APP_NAME.fly.dev`, overridden by
  `REKORDERLIG_URL` (already the CLI's and the sync machine's convention)
  when a custom domain is in front. **Never from the request's `Host`
  header** — a link built from a header the sender controls is the textbook
  way a reset mail gets pointed at an attacker's host, and the door's form is
  exactly a request the sender controls.
- **`fly logs` is where failures show**, as they do for sync. A delivery
  failure is a log line and a `lastError` on the status object, not a
  notification; nobody is paged over a login mail.

What Fly does not give: DNS. The sending domain's records — DKIM, SPF,
DMARC — go at the registrar of a domain the operator controls. `fly.dev` is
Fly's domain and cannot be verified with any provider, so the `From` address
is `rekorderlig@<operator's domain>`, and the link inside still points at
`rekorderlig.fly.dev` unless the app is moved behind that domain too (a
`fly certs` step, optional — aligning the two removes one mild spam signal,
and is the only reason to do it).

## The provider

**Resend**, by default: `POST https://api.resend.com/emails` with a Bearer
key and a JSON body of `from`, `to`, `subject`, `text`; 3,000 messages a
month free, which is two orders of magnitude above what a dozen readers
minting the occasional link can spend. Postmark is the alternative Fly staff
name — a different header (`X-Postmark-Server-Token`) and field names
(`From`, `To`, `TextBody`), the same single POST. The implementation is one
function of about forty lines either way, which is why there is no
`MAIL_PROVIDER` switch: swapping is editing that function, and a switch
would be configuration for a choice made once.

Two settings on the provider's side are part of the design, not of the
setup notes. **Click and open tracking off**: tracking rewrites the link
through the provider's redirector, which puts the token in a second party's
redirect logs for no benefit. **Message retention at its minimum**: the
provider keeps a copy of every message it sends, and every message here is a
login. The link's fifteen-minute life and single use are what make that
copy worthless quickly; retention is what makes it worthless soon after.

## The shape in the code

One new module, `src/mail.rs`, in the shape of `syncer.rs` and
`trainer.rs`: a background thread with its own database connection, driven
through a channel, that the request path hands work to and never waits on.

```
pub trait Mail: Sync + Send {           // like Fetch: one method, faked in tests
    fn send(&self, msg: &Message) -> Result<(), MailError>;
}
pub struct Message { pub to: String, pub subject: String, pub text: String }

pub struct HttpMailer { agent: ureq::Agent, key: String, from: String }
impl Mail for HttpMailer { … }          // the one POST; 429/5xx/transport retried, 4xx not

pub enum Job {
    /// The door: an address typed by somebody signed out. Everything — the
    /// lookup, the rate limit, the mint, the send — happens on the thread.
    LoginRequest { address: String },
    /// The operator or the user themself asking for a link to a known user.
    Link { user: User },
    /// An invite mailed to an address the ledger does not record.
    Invite { address: String, path: String },
}

pub struct Mailer { tx: SyncSender<Job>, state: Mutex<MailState>, … }
impl Mailer {
    pub fn enabled(&self) -> bool;
    pub fn enqueue(&self, job: Job);    // returns at once; a full queue is a log line
    pub fn status(&self) -> Value;      // { enabled, sent, failed, lastError }
}
```

`http_client.rs` grows `post_json(url, headers, body)` beside `get_json`,
with the same retry rule — 429 and 5xx and transport errors are the remote's
bad moment, a 4xx is our request being wrong and is not improved by asking
again. `HttpMailer` is what wraps it; the `Mail` trait is what `server.rs`
and the tests see, and a closure implements it the way one implements
`Fetch`.

Configuration is three environment variables and nothing in the database:

| Variable | Meaning | Unset |
|---|---|---|
| `MAIL_API_KEY` | the provider key (a Fly secret) | mail is off |
| `MAIL_FROM` | `rekorderlig <login@example.org>` | mail is off |
| `REKORDERLIG_URL` | the base of every link the app mails | `https://$FLY_APP_NAME.fly.dev`; off if that is unset too |

"Off" is a state the code knows, not an error: `Mailer::disabled()` refuses
every job with a log line, `enabled()` says so to the door and the CLI, and
the boot line beside `version::describe()` prints `mail: off` or
`mail: on, from login@example.org`. Dev mode and every preview run off. The
CLI flag `--mail` on a machine that is off prints the link as it does today,
with one line saying why.

### The work happens on the thread, all of it

`docs/multi-user.md` put the enumeration oracle first: a 300 ms send for a
known address against a 0 ms no-op for an unknown one tells the sender which
addresses exist, whatever the response says. Moving only the send off the
thread leaves a smaller oracle — a `login_links` INSERT for known addresses
and nothing for unknown ones is a millisecond, and a millisecond over a
network is noise, but the cleaner rule is cheaper than the argument: **the
request path does one thing for every address, which is to put it on the
channel.** The lookup, the rate check, the mint and the send all happen on
the mailer thread, and the response is composed before any of them start.

`SyncSender` with a small bound (say 64) rather than an unbounded channel:
a flood from the door should fill the queue and start dropping, with a log
line per drop, rather than grow the process until Fly kills a 512 MB
machine. The door still answers the same page to the flooder.

### Delivery fails, and that is fine

No outbox table and no retry beyond `post_json`'s three attempts. A mailed
link is a transport for a thing the app can mint again in a millisecond, and
the person who asked for it is standing at the door with the form in front
of them; the cost of a lost message is one more press. An outbox would be a
queue, a worker, a dashboard for stuck rows and a table every preview has to
scrub, in exchange for surviving a provider outage that the person will
notice and route around before the retry fires. The minted link stays in
`login_links` unspent and dies at its fifteen minutes; nothing needs to
delete it.

What survives is the count: `sent`, `failed` and `lastError` since boot on
`Mailer::status()`, reported as `mail` on `GET /api/stats` beside `version`,
and one line on Brain's Data panel — "mail: on · last failed 3 h ago" — for
the operator, who is also a user. Log lines carry the **user id**, never
the address and never the token: `mail: login link → user 7 sent`. The
address is in the provider's log already and does not need to be in Fly's
too, and the token is in nobody's log at all — that is the whole reason the
tables hold `sha256(token)`.

## Links that travel by mail

A mailed link is `max_uses = 1` and lives **fifteen minutes**
(`MAILED_LINK_TTL_SECS`), not the week of `LINK_TTL_SECS`. The multi-user
plan said the week "is the constant it shortens"; that was wrong in one
respect and this design corrects it: a pasted link stays a week, because a
friend opens a chat link days later and the operator should not have to
mint again, while a mailed one is opened from a notification within the
minute or not at all. Two constants, so the pasted flow does not get worse
to make the mailed one safer. `create_login_link` takes the TTL; the
operator's `uses` clamp stays where it is.

The provider is a second party holding the plaintext link, which nothing
else in this system is. Fifteen minutes and one use are what bound that:
the copy in the provider's log is a dead link by the time anyone could read
it there, and a link opened once cannot be opened again. `redeem_login_link`
already refuses an expired or exhausted token in one statement; nothing new
is needed for that.

The mail is **plain text**, one template, no HTML, no images, no footer
links:

```
Subject: Your rekorderlig login link

Here is your link to sign in to rekorderlig:

  https://rekorderlig.fly.dev/login?t=…

It works once and stops working in 15 minutes. Open it in the browser you
want to stay signed in with.

If you did not ask for this, nothing has happened — someone typed your
address into the sign-in form. You can ignore this message.
```

The second paragraph is the phone caveat the multi-user plan raised: a link
tapped in a mail app can open in that app's own web view, and the session
cookie then lives in the wrong browser. Slack answers this with a six-digit
code beside the link; this design answers it with one sentence, because the
code is a second form, a second table and a second rate limit for a problem
that only the Gmail app on iOS still has by default. If the sentence turns
out not to be enough, the code is the successor, and it hangs off the same
`Job::LoginRequest`.

## The door grows a form

`public/signed-out.html` stays a page that runs no JavaScript and needs
nothing but `styles.css`. Since #100 it names two ways in, side by side:
"Already signed up?" (a login link, minted from another device or by the
operator) and "Never signed up?" (an invite). The form belongs in the first
of those and nowhere else — one `<form method="post"
action="/login/request">` with one `<input type="email" name="address">` and
one button, replacing "otherwise ask Fredrik for a fresh one" with the thing
itself. The invite path does not change: the form is for people the app
already knows, and an address it does not know gets the same page and no
mail, so it is no way in for anyone else.

`POST /login/request` is the third route that needs no session, beside
`/login` and `/invite/…`, and it is the only one that accepts a body from
nobody. It reads the form field, puts `Job::LoginRequest` on the channel and
answers **200 with the same page under `data-reason="link-sent"`**: "If that
address belongs to a reader here, a link is on its way. It works once, for
fifteen minutes." Same status, same bytes, same time for a known address, an
unknown one, a rate-limited one and a full queue — the door has one voice.
A 200 rather than the door's usual 401 because the request succeeded; a
browser does nothing with either, and the tests read the reason attribute,
not the status.

Two more `data-` attributes on the root, following the pattern `data-reason`
set: `data-mail="on"` or `"off"`, rewritten by `signed_out()` from
`Mailer::enabled()`, so the stylesheet hides the form when there is nothing
to mail with. Every word stays in the HTML; the server edits attributes.
`tests/styles.test.mjs`, which today holds the page and the stylesheet to
the two reason names, grows to three names and the mail attribute — it is
still the one place that asserts on source text, for the same reason: no
runtime notices when a name drifts.

A form that any page on the internet can POST to (there is no session, so
there is no CSRF token to check) can do exactly one thing: cause a mail to
an address that is on file, at most as often as the rate limit allows, with
a body that says how to ignore it. That is the harm ceiling, and the rate
limit is what holds it there.

## Rate limits, and where they live

Two, both on the mailer thread, both answering the same page.

- **Per user: one a minute, five an hour.** A query on `login_links` for
  the user's rows by `created_at`, on the `idx_login_links_user` index that
  already exists — no counter, no new table, and the operator's own links
  count against it, which is right (the person has a link already). Five an
  hour is what keeps a stranger who knows a reader's address from filling
  that reader's inbox; one a minute is what keeps a double-tap from mailing
  twice.
- **Global: a small in-memory cap**, twenty a minute across all addresses.
  This protects the provider quota and nothing else; it is a counter in
  `MailState` that resets on the minute and on boot, and it is allowed to be
  that crude because a process with a dozen readers never approaches it
  honestly. No per-IP table: `Fly-Client-IP` is available and honest behind
  Fly's proxy, but a table of addresses is state to scrub and expire for a
  cap the global one already provides.

Both limits drop the job with a log line. Neither changes the response,
which has already been sent.

## The operator's and the user's flags

The transport is the same for all three surfaces that hand out a link
today; each grows one way to say "mail it".

| Surface | Today | With mail |
|---|---|---|
| `rekorderlig user link ID\|EMAIL` | prints the link once | `--mail` sends to `users.email`; refused with a line if the user has none, or mail is off |
| `POST /api/users/{id}/link` | 201 with the link | `{"mail": true}` → 202 with no token in the body |
| `POST /api/me/link` (Brain, "Add a device") | 201 with the link | `{"mail": true}` → 202; the panel offers "email it to me" when the user has an address |
| `rekorderlig invite create` | prints the invite once | `--mail-to ADDRESS` sends it there; the ledger records `note`, not the address |

The 202s carry no token because the token has gone by mail; a body that
also printed it would defeat the point of sending it somewhere the browser
in front of the operator cannot see. "Add a device" is the one user-facing
case worth having: you are at the laptop and want the phone signed in, and
mailing yourself the link beats reading a token off one screen into the
other.

The invite flag does not put an address on the invite. `invites` has no
`email` column and this does not add one — an invite still does not know
who will open it; the operator merely chose to send it somewhere rather than
paste it somewhere, and the address goes to the provider and nowhere in this
database. A mailed invite keeps the week: it is opened when the friend gets
round to it, and it cannot be re-minted by the friend, only by the operator.

**Setting one's own address is not in this design.** `users.email` stays
operator-set (`rekorderlig user email ID ADDRESS`), because the operator
knows the address of the person they invited, and because a self-set
address would need verifying — otherwise a reader sets somebody else's
address on their own account, that somebody asks the door for a link, and
receives one into the wrong account. Verification is a mailed link whose
redemption sets the address, which is a new job, a pending column and a
fourth reason on the door; it is the natural next step and it is not this
one.

## What does not change

- **The schema.** No table, no column, no migration. The rate limit is a
  query, the counters live in memory, the TTL is a value already written
  into `expires_at`. `SCHEMA_VERSION` stays 3.
- **Previews.** Nothing new to scrub: no key reaches a preview app, and
  the seed already nulls `users.email` and empties the credential tables. A
  preview's door shows no form (`data-mail="off"`), and the PR comment can
  say so in a clause.
- **Tokens.** Hashed in the database, plaintext once in the response — or
  now, once in a message to the provider, bounded as above.
- **Invites.** Still a row that does not know who will open it.
- **The 401 door for everything else.** `/api/` still answers the JSON 401;
  `PUBLIC_FILES` is still only files — the stylesheet, the icons, the preview
  card. The form posts to a route, not a file.

## Tests

`tests/mail.rs`, driving the server with a closure `Mail` that records
messages, in the shape of `tests/auth.rs`:

- a known address → one message, whose body contains a `/login?t=` path
  that `GET /login` redeems for a session; the link expires in fifteen
  minutes, not a week, and its second redemption is refused;
- an unknown address → no message, and a response byte-identical to the
  known case (compare the bodies, not just the status);
- a second request for the same user inside a minute → one message, not
  two; a sixth inside an hour → five;
- mail off → the door's root carries `data-mail="off"` and the POST answers
  the door, not a 500; `--mail` on the CLI prints the link with its line;
- the operator's `{"mail": true}` → 202 with no `token` key; a user without
  an address → 4xx saying so;
- a provider that answers 500 three times → `failed` counts one, `lastError`
  is set, and the request that caused it had already answered its page;
- the mailer's job runs to completion after the request's response, so the
  test waits on the recorded message rather than on the response — a test
  that passes because the send was synchronous is the regression.

`tests/styles.test.mjs` holds the door and the stylesheet to three reason
names and the mail attribute. `tests/boot-unauthorized.test.mjs` is
untouched: the app's own boot does not see the form.

## Rollout

Each step lands green and deployable on its own; the app keeps working with
mail off at every one of them.

1. **DNS and the provider, no code.** Create the Resend account, add the
   operator's domain, put its DKIM and SPF records and a DMARC record at the
   registrar, verify. Turn tracking off and retention down. Mint an API key
   scoped to sending only.
2. **`fly secrets set MAIL_API_KEY=… MAIL_FROM='rekorderlig <login@…>' --app rekorderlig`.**
   Nothing reads them yet. `REKORDERLIG_URL` is not needed while the app
   answers at `rekorderlig.fly.dev`; set it in `fly.toml`'s `[env]` the day
   a custom domain goes in front.
3. **Phase A — the transport, operator-facing.** `src/mail.rs`, `post_json`,
   the `Mailer` thread, the boot line, `mail` on `/api/stats` and the Data
   panel line, `--mail` on `user link`, `{"mail": true}` on the operator
   route. Rehearse over `fly ssh console -a rekorderlig -C '/app/rekorderlig
   user link 1 --mail'`: the message arrives, the link opens, the second
   open is refused, `fly logs` shows one line with a user id in it and no
   token. The operator stops pasting links for people with an address.
4. **Phase B — the door.** The form, `POST /login/request`,
   `Job::LoginRequest` with its lookup and limits, the third reason, the
   `data-mail` attribute, `tests/mail.rs` and the widened styles test. From
   here a reader with a lost cookie needs nobody awake.
5. **Phase C — the last two flags.** "Email it to me" on Add a device
   (`/api/me/link` with `{"mail": true}`), and `invite create --mail-to`.
6. **CLAUDE.md** loses "is not built yet — the operator pastes links into a
   chat" and gains the rules this file argues for, in a line or two each,
   in the same change as phase A; `docs/multi-user.md`'s "Email is a
   transport" paragraph points here.

## Out of scope, and what comes after

A self-set, verified email address (the successor, see above); a six-digit
code beside the link if the web-view caveat bites; a custom domain in front
of the app so `From` and the link agree; mail about anything but a link —
there is no notification in this product and no digest, and a transport
that carries one kind of message stays one; inbound mail; SMTP of any kind;
a second provider behind a switch; an outbox.

## Fails-silently list

Everything here returns a page, passes a test with one address, and is
wrong.

1. The link's base taken from the request's `Host` → the door mails links
   into any hostname the sender puts in the header.
2. The lookup or the INSERT on the request thread → the door's timing says
   which addresses exist, whatever the page says.
3. The known and unknown cases answering different bytes — a different
   reason, a different status, a "we sent it" versus "if it belongs" — the
   same oracle, in words.
4. The token in a log line, in the 202 body, or in a status field →
   `fly logs` and every reader of `/api/stats` hold a login.
5. The preview app given the key "to test the form" → a copy of production
   with real mail in it, on an app anyone reading the PR can reach.
6. Click tracking left on → every link passes through the provider's
   redirector, and the token sits in its logs for its retention period.
7. The mailed TTL applied to pasted links, or the week applied to mailed
   ones → either a chat link dies before the friend opens it, or a link in
   a mail provider's log stays live for a week.
8. The form shown when mail is off → a preview or a dev box promises a mail
   that never comes, with no line saying why.
9. The rate limit answering a different page → a limit that tells the sender
   the address exists.
10. The address, not the user id, in the log → an address list in
    `fly logs` beside the one the seed scrubs out of previews.
