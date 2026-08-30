//! The feed's GET parameters: what a link means.
//!
//! `feed-params.js` is DOM-free on purpose, so this imports it and calls it —
//! no source slicing, no assertions about the shape of the text. It earns the
//! seam: `Number(null)` is 0, which is a valid `d` and a valid `c`, so a
//! missing parameter once parsed as a real value and a bare /feed loaded
//! all-time with no traction floor. Nothing textual would have caught that.

import test from 'node:test';
import assert from 'node:assert/strict';
import { FEED_DEFAULTS, FEED_PARAM, readFeedParams, feedParams } from '../public/feed-params.js';

// The modes the chips declare; the parser is handed them rather than reading
// the DOM, which is what makes it importable here.
const MODES = ['foryou', 'hybrid', 'top', 'new'];
const read = (search) => readFeedParams(search, MODES);

const write = (feed) => feedParams({ ...FEED_DEFAULTS, ...feed });

test('all defaults is a bare /feed', () => assert.equal(write({}), ''));

test('the everyday filters are single letters', () => {
  assert.equal(write({ days: 30 }), '?d=30');
  assert.equal(write({ mode: 'top' }), '?m=top');
  assert.equal(write({ minComments: 50 }), '?c=50');
  assert.equal(write({ includeVoted: true }), '?v=1');
  assert.equal(write({ q: 'rust' }), '?q=rust');
  assert.equal(write({ mode: 'top', days: 30, minComments: 50, includeVoted: true, q: 'rust' }),
    '?m=top&d=30&c=50&v=1&q=rust');
});

test('a slider floor is one bound', () => assert.equal(write({ minScore: 70 }), '?s=70'));

test('a histogram bucket is one parameter and implies its context', () => {
  assert.equal(write({ days: 0, minComments: 0, minScore: 70, maxScore: 75 }), '?s=70-75');
  const back = read('?s=70-75');
  assert.equal(back.minScore, 70);
  assert.equal(back.maxScore, 75);
  assert.equal(back.days, 0, 'a bucket is all time');
  assert.equal(back.minComments, 0, 'a bucket has no traction floor');
});

test("an explicit d or c still beats the bucket's implied context", () => {
  const f = read('?s=70-75&d=30&c=50');
  assert.equal(f.days, 30);
  assert.equal(f.minComments, 50);
  assert.equal(feedParams(f), '?d=30&s=70-75&c=50', 'and survives the round trip');
});

test('every filter survives a round trip', () => {
  const wanted = { mode: 'top', days: 30, minScore: 45, maxScore: 60, day: null, minPoints: 25, minComments: 50, includeVoted: true, q: 'a b' };
  assert.deepEqual(read(write(wanted)), wanted);
});

test('junk falls back to the default rather than reaching the API', () => {
  const f = read('?d=abc&m=evil&c=-5&s=999');
  assert.deepEqual(f, FEED_DEFAULTS);
});

test('a broken or inverted bucket is rejected whole', () => {
  for (const bad of ['?s=75-70', '?s=70-70', '?s=70-', '?s=-', '?s=a-b', '?s=70-999']) {
    assert.deepEqual(read(bad), FEED_DEFAULTS, `${bad} should not apply`);
  }
});

test('unknown parameters are dropped, not carried', () => {
  assert.equal(feedParams(read('?d=30&utm_source=x&token=hunter2')), '?d=30');
});

// Was a tripwire in tests/frontend.rs, parsing both tables out of the source.
// It is a plain assertion now that the module can be imported.
test('every filter is declared and lettered', () => {
  assert.deepEqual(
    Object.keys(FEED_DEFAULTS).sort(),
    Object.keys(FEED_PARAM).sort(),
    'FEED_DEFAULTS and FEED_PARAM disagree about the filters',
  );
});

test('a letter is claimed by at most two filters', () => {
  // A collision means one filter overwrites the other in the address bar and
  // reads back as it on the way in — a bookmark that applies the wrong filter.
  // Two letters are deliberately shared, each by a pair that is two shapes of
  // one idea and never both in force: `s` is a floor or a bucket (`70`,
  // `70-75`), `d` is a window or a dated day (`30`, `2026-08-12`). A third
  // claimant on either would have no shape left to be distinguished by.
  const byLetter = new Map();
  for (const [key, letter] of Object.entries(FEED_PARAM)) {
    assert.equal(letter.length, 1, `\`${letter}\` is not a single letter`);
    byLetter.set(letter, [...(byLetter.get(letter) ?? []), key]);
  }
  for (const [letter, keys] of byLetter) {
    assert.ok(keys.length <= 2, `${keys.length} filters claim \`${letter}\`: ${keys}`);
  }
});

test('a shared letter never loses one of its filters', () => {
  // The real risk of sharing: state holding two answers at once and the URL
  // silently keeping one. A day and a window cannot both be in force, so
  // writing one must retire the other rather than drop it on the floor.
  const both = { ...FEED_DEFAULTS, day: '2026-08-12', days: 30, minComments: 0 };
  const out = feedParams(both);
  assert.equal(out, '?d=2026-08-12', 'the dated day wins the slot');
  assert.deepEqual(read(out), { ...FEED_DEFAULTS, day: '2026-08-12', minComments: 0 },
    'and what comes back holds only the day');
});

test('every set of GET parameters is stable under a round trip', () => {
  // Serialising what was parsed must give back the same URL. Anything else is
  // a filter that survives one navigation and quietly changes on the next.
  // In FEED_PARAM's own order — m, d, s, c, v, q — which is what `feedParams`
  // writes, so a canonical URL is the only one that can come back unchanged.
  for (const url of ['', '?d=30', '?d=0', '?d=2026-08-12', '?s=70', '?s=70-75',
                     '?p=50', '?p=10&c=0',
                     '?m=top&d=30&p=25&c=50&v=1&q=rust', '?m=new&d=2026-08-12']) {
    assert.equal(feedParams(read(url)), url, `${url} is not stable`);
  }
});

test('a day is one parameter and implies its own context', () => {
  const f = read('?d=2026-08-12');
  assert.equal(f.day, '2026-08-12');
  assert.equal(f.days, FEED_DEFAULTS.days, 'the window is not also in force');
  assert.equal(f.minComments, 0, 'the chart counts every story that day');
});

test('a window and a day are told apart by shape alone', () => {
  assert.equal(read('?d=30').day, null);
  assert.equal(read('?d=30').days, 30);
  assert.equal(read('?d=2026-08-12').days, FEED_DEFAULTS.days);
  // Neither a date nor a number: both readers reject it, so it applies nothing.
  for (const bad of ['?d=2026-8-12', '?d=2026-08', '?d=lastweek', '?d=12-08-2026']) {
    assert.deepEqual(read(bad), FEED_DEFAULTS, `${bad} should not apply`);
  }
});

test('points and comments are two floors, not one', () => {
  // They live on the same axis and are deliberately separate: points are the
  // crowd's verdict on the link, comments are how much it was argued about, and
  // a story is regularly one without the other. Sharing a letter, or having one
  // imply the other, would collapse that back into a single "traction" idea.
  const f = read('?p=50&c=0');
  assert.equal(f.minPoints, 50);
  assert.equal(f.minComments, 0, 'a points floor says nothing about comments');
  assert.equal(read('?c=100').minPoints, FEED_DEFAULTS.minPoints);
});

test("a dated day leaves the points floor alone", () => {
  // The day drops the *comment* floor because the chart it comes from counts
  // every story that day. It says nothing about points, whose default is
  // already "any" — an implication there would be one nobody asked for.
  const f = read('?d=2026-08-12&p=50');
  assert.equal(f.day, '2026-08-12');
  assert.equal(f.minPoints, 50);
  assert.equal(f.minComments, 0);
});
