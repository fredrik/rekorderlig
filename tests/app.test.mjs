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

test('a points floor is its own filter, and reaches the request', () => {
  // Points and comments are the same axis and different questions. Before this
  // the feed could only ask the second one.
  const sent = sentTo('/feed?p=50&c=0');
  assert.equal(sent.get('minPoints'), '50');
  assert.equal(sent.get('minComments'), '0');
  assert.deepEqual(app.lit('#points-chips', 'minPoints'), ['50']);
  assert.deepEqual(app.lit('#talk-chips', 'minComments'), ['0']);
});

test('a dated day leaves the window row dark', () => {
  // The bug this row had: `day` and `days` are two shapes of one filter, and
  // parsing a day leaves `days` at its default — so the panel lit "7 days"
  // beside a list showing one day in July. A day is the row's value while it
  // is in force, and the picker is the member that shows it.
  navigate('/feed?d=2026-08-12');
  assert.deepEqual(app.lit('#range-chips', 'days'), [], 'a window chip lit beside a day');
  assert.equal(app.node('#day-picker').value, '2026-08-12');
  assert.ok(app.node('#day-picker').classList.contains('active'));

  navigate('/feed?d=30');
  assert.deepEqual(app.lit('#range-chips', 'days'), ['30'], 'the window row went dark on a window');
  assert.equal(app.node('#day-picker').value, '', 'the picker still names a day the feed dropped');
});

test('the picker is the other shape of the window row', () => {
  navigate('/feed?d=30&c=50');
  app.node('#day-picker').value = '2026-07-13';
  app.fire('#day-picker', 'change');
  const sent = new URL(app.urls('/api/feed').at(-1), 'https://rk.test').searchParams;
  assert.equal(sent.get('day'), '2026-07-13');
  assert.ok(!sent.has('days'), 'a window and a day both asked about time');
  // A day named in the panel keeps the panel's other filters: you are standing
  // in front of them and can see what they say. Only a day arriving as a *link*
  // from the Brain chart drops the floors, because there a bar promised a count.
  assert.equal(sent.get('minComments'), '50', 'a floor set by hand was thrown away');
  assert.equal(app.history.at(-1).url, '/feed?d=2026-07-13&c=50');
});

test('leaving a day restores the day and nothing else', () => {
  // Same rule as the score bucket: a band restores what identifies it and
  // leaves the view it opened standing. The day used to snap the comment floor
  // back to 10 as well, which threw away a floor the panel had been set to.
  navigate('/feed?d=2026-07-13&c=50');
  app.fire('#mode-chips', 'click', { target: app.button({ mode: 'new' }) });
  const sent = new URL(app.urls('/api/feed').at(-1), 'https://rk.test').searchParams;
  assert.ok(!sent.has('day'), 'the day outlived the filter that replaced it');
  assert.equal(sent.get('minComments'), '50', 'and took a floor it never set with it');
  assert.equal(sent.get('days'), String(FEED_DEFAULTS.days));
});

test('voted is a free variable with two states', () => {
  // It was a lone toggle riding in the window row, where it read as a button
  // that does something rather than as the filter it is. Nothing implies it and
  // it implies nothing, which is exactly what its own row says.
  navigate('/feed');
  assert.deepEqual(app.lit('#voted-chips', 'includeVoted'), ['0']);
  app.fire('#voted-chips', 'click', { target: app.button({ includeVoted: '1' }) });
  const sent = new URL(app.urls('/api/feed').at(-1), 'https://rk.test').searchParams;
  assert.equal(sent.get('includeVoted'), '1');
  assert.deepEqual(app.lit('#voted-chips', 'includeVoted'), ['1']);
});

test('Brain says which build it is looking at', () => {
  // The stats stub carries a version object (see helpers/dom.mjs). Brain must
  // print the app version, the short commit and when it was built, so a
  // preview and prod can be told apart by looking.
  navigate('/brain');
  const line = app.text('#version-note');
  assert.match(line, /1\.0\.0/, 'app version');
  assert.match(line, /abc1234/, 'short commit');
  assert.doesNotMatch(line, /abc1234def/, 'the full sha is a link target, not prose');
  assert.match(line, /built/, 'the build time is labelled as such');
});

test('the wordmark is a way back to the feed', async () => {
  // It carries a real href so the browser can open it in a tab, which means a
  // plain click has to be taken over — otherwise every click on the header is
  // a full page load. Routed in place, the filters the feed was left under
  // come back with it, exactly as they do from the tab bar.
  navigate('/feed?m=top&d=30');
  navigate('/brain');
  app.fire('.brand', 'click');
  const { state } = await app.load('state.js');
  assert.equal(state.view, 'feed');
  assert.equal(app.history.at(-1).url, '/feed?m=top&d=30');
});

test('a modified click on the wordmark is the browser’s', () => {
  navigate('/brain');
  const before = app.history.length;
  app.fire('.brand', 'click', { metaKey: true });
  assert.equal(app.history.length, before, 'cmd-click was swallowed by the router');
});
