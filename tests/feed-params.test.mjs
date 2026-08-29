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
  const wanted = { mode: 'top', days: 30, minScore: 45, maxScore: 60, minComments: 50, includeVoted: true, q: 'a b' };
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

test('no two filters claim the same letter', () => {
  // A collision means the second filter overwrites the first in the address bar
  // and reads back as it on the way in — a bookmark that applies the wrong one.
  // The score bounds are the one deliberate pair: `s` carries both.
  const letters = Object.values(FEED_PARAM);
  for (const l of letters) assert.equal(l.length, 1, `\`${l}\` is not a single letter`);
  assert.equal(letters.filter((l) => l === 's').length, 2, '`s` is the score pair, and only that');
  const rest = letters.filter((l) => l !== 's');
  assert.equal(new Set(rest).size, rest.length, `two filters share a letter: ${rest}`);
});
