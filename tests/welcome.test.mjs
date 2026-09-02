//! A fresh invitee: a row with no name yet. Its own file, because the welcome
//! prompt's state is decided at boot and there is one mount per process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './helpers/dom.mjs';

const stats = {
  votes: { up: 0, down: 0, skip: 0 }, stories: 12, model: null, distribution: null,
  user: { id: 2, displayName: null, email: 'alice@example.com', createdAt: 0 },
  version: { app: null, commit: null, builtAt: null },
};

const app = await mount({
  path: '/brain',
  routes: {
    'GET /api/stats': stats,
    'POST /api/me': { user: { ...stats.user, displayName: 'Alice' } },
  },
});

test('a user with no name is asked for one, on whichever view the link opened', () => {
  assert.equal(app.bootError, null);
  assert.equal(app.node('#welcome').hidden, false, 'the prompt must show');
  assert.equal(app.text('#tagline'), '', 'Brain has no name to show yet');
  assert.match(app.text('#me-note'), /no name yet/);
});

test('saving the name is one POST, and everything that shows a name redraws', async () => {
  app.node('#welcome-name').value = 'Alice';
  await app.fire('#welcome-form', 'submit', { preventDefault() {} });
  // Let the awaited save settle (setImmediate, not setTimeout: the stub unrefs timers).
  await new Promise((r) => setImmediate(r));
  assert.equal(app.requests.filter((r) => r.method === 'POST' && r.url === '/api/me').length, 1);
  assert.equal(app.node('#welcome').hidden, true, 'the prompt is done');
  assert.equal(app.text('#tagline'), 'Alice', 'the Brain tagline names her');
  assert.match(app.text('#me-note'), /Alice/);
  assert.equal(app.node('#me-name').value, 'Alice', 'the rename field shows the saved name');
});
