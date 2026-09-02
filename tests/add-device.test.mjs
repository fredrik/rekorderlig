//! "Add a device": a signed-in user mints a one-use link for their own next
//! device and the panel shows it once, ready to copy. Its own file: the You
//! panel's state is per mount, and there is one mount per process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './helpers/dom.mjs';

const stats = {
  votes: { up: 3, down: 2, skip: 0 }, stories: 12, model: null, distribution: null,
  user: { id: 2, displayName: 'Alice', email: null, createdAt: 0 },
  version: { app: null, commit: null, builtAt: null },
};

const app = await mount({
  path: '/brain',
  routes: {
    'GET /api/stats': stats,
    'POST /api/me/link': { link: { path: '/login?t=abc123', expiresAt: 1, maxUses: 1 } },
  },
});

const settle = () => new Promise((r) => setImmediate(r));

test('nothing is minted by merely opening Brain', () => {
  // (The box starts `hidden` in index.html; the stub has no HTML attributes,
  // so that part is the markup's to keep, not this test's to check.)
  assert.equal(app.bootError, null);
  assert.equal(app.urls('/api/me/link').length, 0);
});

test('one click is one POST, and the full URL lands in the box', async () => {
  await app.fire('#btn-add-device', 'click', { target: app.node('#btn-add-device') });
  await settle();
  assert.equal(app.requests.filter((r) => r.method === 'POST' && r.url === '/api/me/link').length, 1);
  assert.equal(app.node('#device-link').hidden, false);
  // The server knows the path; the browser knows the host. The user gets the
  // whole thing, because the other device cannot fill in the rest.
  assert.equal(app.node('#device-link-url').value, 'https://rk.test/login?t=abc123');
  assert.match(app.text('#device-link-note'), /works once/);
  assert.equal(app.node('#btn-add-device').disabled, false, 'the button is usable again');
});

test('copy puts the link on the clipboard and says so', async () => {
  const written = [];
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (t) => { written.push(t); } } },
    configurable: true,
  });
  await app.fire('#btn-copy-link', 'click', { target: app.node('#btn-copy-link') });
  await settle();
  assert.deepEqual(written, ['https://rk.test/login?t=abc123']);
  assert.equal(app.text('#btn-copy-link'), 'Copied');
});

test('without a clipboard the link is still there to copy by hand', async () => {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
  await app.fire('#btn-copy-link', 'click', { target: app.node('#btn-copy-link') });
  await settle();
  assert.match(app.text('#device-link-note'), /by hand/);
  assert.equal(app.node('#device-link-url').value, 'https://rk.test/login?t=abc123', 'the link is not lost');
});
