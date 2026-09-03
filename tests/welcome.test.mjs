//! The first five minutes, for the user an invite just minted: a row with no
//! name yet. Its own file, because which view the boot opens is decided once
//! and there is one mount per process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './helpers/dom.mjs';

const stats = {
  votes: { up: 0, down: 0, skip: 0 }, stories: 12, model: null, distribution: null,
  user: { id: 2, displayName: null, email: null, createdAt: 0 },
  version: { app: null, commit: null, builtAt: null },
};

// Mounted somewhere other than the flow: an invite link can land on any
// section, and the row is what decides, not the address bar.
const app = await mount({
  path: '/feed',
  routes: {
    'GET /api/stats': stats,
    'POST /api/me': { user: { ...stats.user, displayName: 'Alice' } },
    'GET /api/round': { round: null },
    'POST /api/round': { round: { seq: 1, size: 12, judged: 0, skipped: 0, cards: [
      { id: 1, title: 'Rust borrow checker internals', domain: 'rustblog.dev' },
    ] } },
  },
});

test('a nameless user opens on the welcome view, whatever the link said', () => {
  assert.equal(app.bootError, null);
  assert.equal(app.node('#view-onboard').hidden, false, 'the flow must be up');
  assert.equal(app.node('#view-feed').hidden, true, 'and the link it came in on must not');
  assert.equal(location.pathname, '/onboard', 'the address bar says where they are');
  assert.equal(app.node('#onboard-step-name').hidden, false, 'starting on the name');
  assert.equal(app.node('#onboard-step-how').hidden, true);
  // The tabs are the way out of every other screen, so a flow has to take
  // them away — otherwise this is a prompt you can click past.
  assert.equal(app.node('nav.tabs').hidden, true, 'the tabs are gone while it runs');
  // A header counting down a round nobody has been told about yet.
  assert.equal(app.text('#tagline'), '', 'the header keeps only the brand');
});

test('the name is one POST, and it advances rather than ending the flow', async () => {
  app.node('#onboard-name').value = 'Alice';
  await app.fire('#onboard-form', 'submit', { preventDefault() {} });
  // Let the awaited save settle (setImmediate, not setTimeout: the stub unrefs timers).
  await new Promise((r) => setImmediate(r));
  assert.equal(app.requests.filter((r) => r.method === 'POST' && r.url === '/api/me').length, 1);
  assert.equal(app.node('#view-onboard').hidden, false, 'still in the flow');
  assert.equal(app.node('#onboard-step-name').hidden, true);
  assert.equal(app.node('#onboard-step-how').hidden, false, 'on to what it does');
});

test('the last button hands over to a real round', async () => {
  await app.fire('#onboard-start', 'click', {});
  await new Promise((r) => setImmediate(r));
  assert.equal(app.node('#view-onboard').hidden, true, 'the flow is done');
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

test('the name it saved is the name Brain shows', async () => {
  // `saveDisplayName` is the one way a name changes, so the welcome screen and
  // Brain's rename cannot disagree about what it is.
  const { showView } = await app.load('router.js');
  showView('brain');
  assert.equal(app.node('#me-name').value, 'Alice', 'the rename field shows the saved name');
  assert.match(app.text('#me-note'), /Alice/);
  assert.equal(app.text('#tagline'), 'Alice');
});

test('nobody who has been through it can walk back in by the path', async () => {
  // The flow is a view with a path, but the row is what decides — in both
  // directions. Alice has a name now, so `/onboard` is the app, not the flow.
  const { onboardingRoute } = await app.load('onboard.js');
  assert.equal(onboardingRoute('onboard'), 'train', 'a stale /onboard lands in the app');
  assert.equal(onboardingRoute('feed'), 'feed', 'and every other path is left alone');
});
