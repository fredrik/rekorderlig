//! The feed's GET parameters, exercised for real.
//!
//! `tests/frontend.rs` reads app.js as text, because the file touches `document`
//! at load and there is nothing to import in a run with no browser in it. That
//! is fine for tripwires over things two files must agree on, but it cannot run
//! a parser, and this layer is a parser: it decides what a link means.
//!
//! So the GET-parameter block is lifted out of the committed source and run
//! against a stub — the real text, not a copy of it. Node's own test runner, no
//! dependencies, in the spirit of the rest of the project. `node --test`, and
//! CI runs it beside `cargo test`.
//!
//! It earns the seam: `Number(null)` is 0, which is a valid `d` and a valid `c`,
//! so a missing parameter once parsed as a real value and a bare /feed loaded
//! all-time with no traction floor. Nothing textual would have caught that.
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

// Relative to this file, so it runs from anywhere.
const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const code = src.slice(src.indexOf('const FEED_DEFAULTS = {'), src.indexOf('const state = {'));
const MODES = ['foryou', 'hybrid', 'top', 'new'];
const $ = () => ({ children: MODES.map((m) => ({ dataset: { mode: m } })) });
const state = { feed: {} };
const { FEED_DEFAULTS, readFeedParams, feedParams } =
  new Function('$', 'state', `${code}; return { FEED_DEFAULTS, readFeedParams, feedParams };`)($, state);

const write = (feed) => { state.feed = { ...FEED_DEFAULTS, ...feed }; return feedParams(); };

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
  const back = readFeedParams('?s=70-75');
  assert.equal(back.minScore, 70);
  assert.equal(back.maxScore, 75);
  assert.equal(back.days, 0, 'a bucket is all time');
  assert.equal(back.minComments, 0, 'a bucket has no traction floor');
});

test("an explicit d or c still beats the bucket's implied context", () => {
  const f = readFeedParams('?s=70-75&d=30&c=50');
  assert.equal(f.days, 30);
  assert.equal(f.minComments, 50);
  state.feed = f;
  assert.equal(feedParams(), '?d=30&s=70-75&c=50', 'and survives the round trip');
});

test('every filter survives a round trip', () => {
  const wanted = { mode: 'top', days: 30, minScore: 45, maxScore: 60, minComments: 50, includeVoted: true, q: 'a b' };
  assert.deepEqual(readFeedParams(write(wanted)), wanted);
});

test('junk falls back to the default rather than reaching the API', () => {
  const f = readFeedParams('?d=abc&m=evil&c=-5&s=999');
  assert.deepEqual(f, FEED_DEFAULTS);
});

test('a broken or inverted bucket is rejected whole', () => {
  for (const bad of ['?s=75-70', '?s=70-70', '?s=70-', '?s=-', '?s=a-b', '?s=70-999']) {
    assert.deepEqual(readFeedParams(bad), FEED_DEFAULTS, `${bad} should not apply`);
  }
});

test('unknown parameters are dropped, not carried', () => {
  state.feed = readFeedParams('?d=30&utm_source=x&token=hunter2');
  assert.equal(feedParams(), '?d=30');
});
