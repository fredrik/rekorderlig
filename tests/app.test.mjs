//! Front-end behaviour, run rather than read.
//!
//! These replaced text tripwires in tests/frontend.rs that asserted the shape
//! of the source. They boot the real module graph against the DOM stub and
//! check what it does. One mount per file — see tests/helpers/dom.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './helpers/dom.mjs';
import { FEED_DEFAULTS } from '../public/feed-params.js';

const app = await mount({ path: '/feed' });
const { navigate } = await app.load('router.js');
const sentTo = (url) => {
  navigate(url);
  return new URL(app.urls('/api/feed').at(-1), 'https://rk.test').searchParams;
};

test('boot asks for the feed it was opened on', () => {
  assert.equal(app.bootError, null);
  assert.ok(app.urls('/api/feed').length, 'the feed never asked for anything');
});

test('every declared filter reaches the feed request', () => {
  // A filter the request never sends is a URL that changes nothing at all: it
  // survives a chip click and does nothing on a reload. FEED_DEFAULTS is the
  // list, so a filter added there and nowhere else fails here.
  const sent = sentTo('/feed?m=top&d=30&s=45&c=50&v=1&q=rust');
  for (const key of Object.keys(FEED_DEFAULTS)) {
    if (key === 'maxScore' || key === 'day') continue; // sent only when in force
    assert.ok(sent.has(key), `${key} is declared but never sent`);
  }
  assert.equal(sent.get('mode'), 'top');
  assert.equal(sent.get('days'), '30');
  assert.equal(sent.get('minComments'), '50');
  assert.equal(sent.get('includeVoted'), '1');
  assert.equal(sent.get('q'), 'rust');
  assert.equal(sent.get('minScore'), '0.45', 'a percentage in the URL, a fraction on the wire');
});

test('a score bucket sends both bounds, as fractions', () => {
  const sent = sentTo('/feed?s=70-75');
  assert.equal(sent.get('minScore'), '0.7');
  assert.equal(sent.get('maxScore'), '0.75');
  assert.equal(sent.get('days'), '0', 'a bucket is all time');
  assert.equal(sent.get('minComments'), '0', 'and carries no traction floor');
});

test('the panel replaces history entries; only a drill-down pushes', () => {
  // Dragging the slider or typing a search must not stack entries — the back
  // button would walk out of a search one keystroke at a time. Arriving at a
  // bucket from Brain is a real navigation, and back should reach the chart.
  const before = app.history.length;
  app.fire('#mode-chips', 'click', { target: app.button({ mode: 'top' }) });
  const fromChip = app.history.slice(before);
  assert.ok(fromChip.length, 'a chip click never wrote the URL');
  assert.ok(fromChip.every((h) => h.type === 'replace'), `a chip pushed: ${JSON.stringify(fromChip)}`);

  navigate('/feed?s=70-75');
  assert.equal(app.history.at(-1).type, 'push', 'the drill-down must be a navigation');
  assert.equal(app.history.at(-1).url, '/feed?s=70-75');
});

test('leaving a bucket drops the bucket, and keeps the view it opened', () => {
  // Touching another filter leaves band-browsing, and what that restores is
  // the *score bounds* — not the all-time range and dropped traction floor the
  // bucket also set. That is deliberate and predates the GET parameters:
  // `clearScoreBand()` reset the two bounds and nothing else. You are still
  // looking at the whole archive, the chips say so, and the next thing you
  // click is usually another filter rather than a return to the last seven
  // days.
  navigate('/feed?s=70-75');
  app.fire('#mode-chips', 'click', { target: app.button({ mode: 'new' }) });
  const sent = new URL(app.urls('/api/feed').at(-1), 'https://rk.test').searchParams;
  assert.equal(sent.get('mode'), 'new');
  assert.ok(!sent.has('maxScore'), 'the bucket outlived the filter that replaced it');
  assert.equal(sent.get('minScore'), '0', 'and so did its floor');
  assert.equal(sent.get('days'), '0', 'the range it opened is kept, on purpose');
  assert.equal(sent.get('minComments'), '0');
});
