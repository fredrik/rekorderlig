//! "Invite a friend": a signed-in user mints an invite for somebody who is not
//! a user yet, the panel shows the link once, and the list says what became of
//! the ones they have sent. Its own file, like "Add a device": the You panel's
//! state is per mount, and there is one mount per process.

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

// One row per state the list can be in, oldest at the bottom the way the
// server orders them: newest first.
const sent = {
  id: 7, note: null, createdAt: now - 3600, expiresAt: now + 7 * DAY,
  redeemedAt: null, revokedAt: null, user: null,
  invitedBy: { id: 2, displayName: 'Alice', email: null, createdAt: 0 },
};
const taken = {
  ...sent, id: 6, createdAt: now - 5 * DAY, expiresAt: now + 2 * DAY,
  redeemedAt: now - 4 * DAY,
  user: { id: 9, displayName: 'Bob', email: null, createdAt: now - 4 * DAY },
};

const app = await mount({
  path: '/brain',
  routes: {
    'GET /api/stats': stats,
    'GET /api/me/invites': { invites: [taken] },
    'POST /api/me/invites': { invite: { id: 7, path: '/invite/tok123', expiresAt: now + 7 * DAY }, invites: [sent, taken] },
    'POST /api/me/invites/7/revoke': { invites: [{ ...sent, revokedAt: now }, taken] },
  },
});

const settle = () => new Promise((r) => setImmediate(r));
const rows = () => app.node('#invite-list').children;

test('opening Brain reads your own list and mints nothing', async () => {
  await settle();
  assert.equal(app.bootError, null);
  assert.deepEqual(app.requests.filter((r) => r.url === '/api/me/invites').map((r) => r.method), ['GET']);
  // The list is the ledger's answer, in the ledger's words: who took it up,
  // and when.
  assert.equal(rows().length, 1);
  assert.match(rows()[0].textContent, /Bob joined 4d ago/);
  assert.equal(app.node('#invite-list').hidden, false);
  // Nothing minted means no link on screen to leak.
  assert.equal(app.node('#invite-link-url').value, '');
});

test('one click is one POST, and the invite URL lands in its own box', async () => {
  await app.fire('#btn-invite', 'click', { target: app.node('#btn-invite') });
  await settle();
  assert.equal(app.requests.filter((r) => r.method === 'POST' && r.url === '/api/me/invites').length, 1);
  assert.equal(app.node('#invite-link').hidden, false);
  // The server knows the path; the browser knows the host. The friend gets
  // the whole thing.
  assert.equal(app.node('#invite-link-url').value, 'https://rk.test/invite/tok123');
  assert.match(app.text('#invite-link-note'), /one person/);
  assert.equal(app.node('#btn-invite').disabled, false, 'the button is usable again');
  // The other box is a different link: inviting a friend does not ask for a
  // login link into this account.
  assert.equal(app.urls('/api/me/link').length, 0);
});

test('the list repaints from the mint, and an unopened invite can be voided', async () => {
  assert.equal(rows().length, 2);
  assert.match(rows()[0].textContent, /unopened · 7 days left/);
  // Only the unopened one gets a button: a taken-up invite is history.
  assert.equal(rows()[0].children.length, 2);
  assert.equal(rows()[1].children.length, 1);

  await rows()[0].children[1].fire('click');
  await settle();
  assert.equal(app.requests.filter((r) => r.url === '/api/me/invites/7/revoke').length, 1);
  assert.match(rows()[0].textContent, /voided/);
  assert.equal(rows()[0].children.length, 1, 'nothing left to void');
  // The box went with it: the URL it was showing is the dead one.
  assert.equal(app.node('#invite-link').hidden, true);
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
