//! The first five minutes, for the user an invite just minted: a row with no
//! name yet. Its own file, because the flow's state is decided at boot and
//! there is one mount per process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './helpers/dom.mjs';

const stats = {
  votes: { up: 0, down: 0, skip: 0 }, stories: 12, model: null, distribution: null,
  user: { id: 2, displayName: null, email: null, createdAt: 0 },
  version: { app: null, commit: null, builtAt: null },
};

const app = await mount({
  path: '/brain',
  routes: {
    'GET /api/stats': stats,
    'POST /api/me': { user: { ...stats.user, displayName: 'Alice' } },
    'GET /api/round': { round: null },
    'POST /api/round': { round: { seq: 1, size: 12, judged: 0, skipped: 0, cards: [
      { id: 1, title: 'Rust borrow checker internals', domain: 'rustblog.dev' },
    ] } },
  },
});

test('a nameless user gets the flow, not the app', () => {
  assert.equal(app.bootError, null);
  assert.equal(app.node('#onboard').hidden, false, 'the flow must be up');
  assert.equal(app.node('#onboard-step-name').hidden, false, 'starting on the name');
  assert.equal(app.node('#onboard-step-how').hidden, true);
  // The tabs are the way out of every other screen, so a flow has to take
  // them away — otherwise this is a prompt you can click past.
  assert.equal(app.node('nav.tabs').hidden, true, 'the tabs are gone while it runs');
  assert.equal(app.text('#tagline'), '', 'Brain has no name to show yet');
});

test('the name is one POST, and it advances rather than ending the flow', async () => {
  app.node('#onboard-name').value = 'Alice';
  await app.fire('#onboard-form', 'submit', { preventDefault() {} });
  // Let the awaited save settle (setImmediate, not setTimeout: the stub unrefs timers).
  await new Promise((r) => setImmediate(r));
  assert.equal(app.requests.filter((r) => r.method === 'POST' && r.url === '/api/me').length, 1);
  assert.equal(app.node('#onboard').hidden, false, 'still in the flow');
  assert.equal(app.node('#onboard-step-name').hidden, true);
  assert.equal(app.node('#onboard-step-how').hidden, false, 'on to what it does');
  // Everything that shows a name has already caught up, mid-flow.
  assert.equal(app.text('#tagline'), 'Alice', 'the Brain tagline names her');
  assert.match(app.text('#me-note'), /Alice/);
  assert.equal(app.node('#me-name').value, 'Alice', 'the rename field shows the saved name');
});

test('the last button hands over to a real round', async () => {
  await app.fire('#onboard-start', 'click', {});
  await new Promise((r) => setImmediate(r));
  assert.equal(app.node('#onboard').hidden, true, 'the flow is done');
  assert.equal(app.node('nav.tabs').hidden, false, 'and the app is reachable');
  assert.equal(app.node('#view-train').hidden, false, 'landing on the deck');
  assert.equal(location.pathname, '/train');
  // The ordinary round, dealt the ordinary way — there is no tutorial round,
  // which would itself need explaining.
  assert.ok(
    app.requests.some((r) => r.method === 'POST' && r.url === '/api/round'),
    'no round was dealt',
  );
});

test('a refresh mid-flow does not throw the reader back a step', async () => {
  // `renderOnboard` runs on every /api/stats, so it may only ever *enter* the
  // flow. Re-entering would reset a reader on step two to step one, and the
  // stats poll would do it on its own schedule.
  const { renderOnboard } = await import('../public/onboard.js');
  renderOnboard();
  assert.equal(app.node('#onboard').hidden, true, 'a named user is never re-asked');
});
