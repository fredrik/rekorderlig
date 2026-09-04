//! "Invite a friend": the sender's half of the doorstep. Pressing the button
//! opens a card to address — nothing is minted until it is submitted — and the
//! panel then shows the link once, the five pips, and what became of the ones
//! already sent. Its own file, like "Add a device": the You panel's state is
//! per mount, and there is one mount per process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './helpers/dom.mjs';

const now = Math.floor(Date.now() / 1000);
const DAY = 86400;

const stats = {
  votes: { up: 3, down: 2, skip: 0 }, stories: 12, model: null, distribution: null,
  user: { id: 2, displayName: 'Alice', email: null, createdAt: 0 },
  version: { app: null, commit: null, builtAt: null },
};

// The name the sender wrote down, and — on the one that was taken up — the
// name the invitee chose instead. The list is the only place both are known.
const sent = {
  id: 7, note: 'Anna, from work', createdAt: now - 3600, expiresAt: now + 7 * DAY,
  redeemedAt: null, revokedAt: null, user: null,
  invitedBy: { id: 2, displayName: 'Alice', email: null, createdAt: 0 },
};
const taken = {
  ...sent, id: 6, note: 'Bob, from the gym',
  createdAt: now - 5 * DAY, expiresAt: now + 2 * DAY, redeemedAt: now - 4 * DAY,
  user: { id: 9, displayName: 'bob', email: null, createdAt: now - 4 * DAY },
};

const app = await mount({
  path: '/brain',
  routes: {
    'GET /api/stats': stats,
    // A taken-up invite is a person, not an outstanding link: five left.
    'GET /api/me/invites': { invites: [taken], cap: { max: 5, left: 5 } },
    'POST /api/me/invites': {
      invite: { id: 7, note: 'Anna, from work', path: '/invite/tok123', expiresAt: now + 7 * DAY },
      invites: [sent, taken],
      cap: { max: 5, left: 4 },
    },
    'POST /api/me/invites/7/revoke': {
      invites: [{ ...sent, revokedAt: now }, taken],
      cap: { max: 5, left: 5 },
    },
  },
});

const settle = () => new Promise((r) => setImmediate(r));
const rows = () => app.node('#invite-list').children;
const pips = () => app.node('#invite-pips').children.map((p) => (p.classList.has('spent') ? '·' : '●')).join('');

test('opening Brain reads your own list and mints nothing', async () => {
  await settle();
  assert.equal(app.bootError, null);
  assert.deepEqual(app.requests.filter((r) => r.url === '/api/me/invites').map((r) => r.method), ['GET']);
  assert.equal(pips(), '●●●●●', 'five to give');
  assert.match(app.text('#invite-tally-note'), /5 invites left to give/);
  // The ledger's answer, in the ledger's words: what you called him, and the
  // name he chose for himself.
  assert.equal(rows().length, 1);
  assert.match(rows()[0].textContent, /Bob, from the gym · joined 4d ago as bob/);
  // Nothing minted means no link on screen to leak.
  assert.equal(app.node('#invite-link-url').value, '');
});

test('the button opens a card, and an unaddressed card makes nothing', async () => {
  await app.fire('#btn-invite', 'click', { target: app.node('#btn-invite') });
  await settle();
  assert.equal(app.node('#invite-compose').hidden, false, 'the card is open');
  assert.equal(app.node('#invite-start').hidden, true, 'and the button has stepped aside');
  // The press that would have minted an invite before now mints nothing.
  assert.deepEqual(app.requests.filter((r) => r.url === '/api/me/invites').map((r) => r.method), ['GET']);
  assert.equal(app.node('#btn-invite-make').disabled, true, 'nobody to invite yet');

  // Whitespace is not somebody.
  app.node('#invite-for').value = '   ';
  await app.fire('#invite-for', 'input', { target: app.node('#invite-for') });
  assert.equal(app.node('#btn-invite-make').disabled, true);

  // Submitting an empty card is refused by the card itself, not the server.
  await app.fire('#invite-compose', 'submit', {});
  await settle();
  assert.equal(app.requests.filter((r) => r.method === 'POST' && r.url === '/api/me/invites').length, 0);
});

test('cancelling leaves no trace', async () => {
  await app.fire('#btn-invite-cancel', 'click', { target: app.node('#btn-invite-cancel') });
  assert.equal(app.node('#invite-compose').hidden, true);
  assert.equal(app.node('#invite-start').hidden, false);
  assert.equal(app.requests.filter((r) => r.method === 'POST' && r.url === '/api/me/invites').length, 0);
});

test('a name makes the link, and the name goes with it', async () => {
  await app.fire('#btn-invite', 'click', { target: app.node('#btn-invite') });
  assert.equal(app.node('#invite-link').hidden, true, 'no stale link beside a fresh card');
  app.node('#invite-for').value = 'Anna, from work';
  await app.fire('#invite-for', 'input', { target: app.node('#invite-for') });
  assert.equal(app.node('#btn-invite-make').disabled, false, 'now there is somebody');

  await app.fire('#invite-compose', 'submit', {});
  await settle();
  const posts = app.requests.filter((r) => r.method === 'POST' && r.url === '/api/me/invites');
  assert.equal(posts.length, 1, 'one card, one row');
  assert.deepEqual(posts[0].body, { note: 'Anna, from work' }, 'the name is what it carries');

  // The card closes and the link takes its place, addressed.
  assert.equal(app.node('#invite-compose').hidden, true);
  assert.equal(app.node('#invite-link').hidden, false);
  assert.equal(app.text('#invite-link-for'), 'For Anna, from work');
  // The server knows the path; the browser knows the host. The friend gets
  // the whole thing.
  assert.equal(app.node('#invite-link-url').value, 'https://rk.test/invite/tok123');
  assert.match(app.text('#invite-link-note'), /one person/);
  // One of the five is spent, and the pips say so without being refused.
  assert.equal(pips(), '●●●●·');
  assert.match(app.text('#invite-tally-note'), /4 invites left/);
  // Inviting a friend never asks for a login link into this account.
  assert.equal(app.urls('/api/me/link').length, 0);
});

test('an unopened invite can be voided, and the link box goes with it', async () => {
  assert.equal(rows().length, 2);
  assert.match(rows()[0].textContent, /Anna, from work · unopened · 7 days left/);
  // Only the unopened one gets a button: a taken-up invite is history.
  assert.equal(rows()[0].children.length, 2);
  assert.equal(rows()[1].children.length, 1);

  await rows()[0].children[1].fire('click');
  await settle();
  assert.equal(app.requests.filter((r) => r.url === '/api/me/invites/7/revoke').length, 1);
  assert.match(rows()[0].textContent, /voided/);
  assert.equal(rows()[0].children.length, 1, 'nothing left to void');
  // The URL the box was showing is the dead one.
  assert.equal(app.node('#invite-link').hidden, true);
  assert.equal(pips(), '●●●●●', 'the invite is back in your hand');
});

test('copy puts the invite on the clipboard and says so', async () => {
  const written = [];
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (t) => { written.push(t); } } },
    configurable: true,
  });
  await app.fire('#btn-copy-invite', 'click', { target: app.node('#btn-copy-invite') });
  await settle();
  assert.deepEqual(written, ['https://rk.test/invite/tok123']);
  assert.equal(app.text('#btn-copy-invite'), 'Copied');
});
