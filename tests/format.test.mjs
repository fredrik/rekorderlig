//! Numbers into words.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pct, plural, ago, scoreColor } from '../public/format.js';

test('a score is never printed as certainty', () => {
  // The model is a guess, not an oracle: 0% and 100% are claims it cannot make,
  // and it does reach them — a trained model separates its own training set
  // perfectly, so every voted story scores ~0.99 or ~0.00.
  assert.equal(pct(0), '1%');
  assert.equal(pct(1), '99%');
  assert.equal(pct(0.004), '1%');
  assert.equal(pct(0.9999), '99%');
  assert.equal(pct(0.5), '50%');
});

test('one of a thing is not plural', () => {
  assert.equal(plural(1, 'vote'), '1 vote');
  assert.equal(plural(0, 'vote'), '0 votes');
  assert.equal(plural(2, 'prediction'), '2 predictions');
});

test('age is coarse and never zero', () => {
  const now = Date.now() / 1000;
  // Rounding would otherwise print "0m ago" for a story fetched seconds ago.
  assert.equal(ago(now), '1m ago');
  assert.equal(ago(now - 1800), '30m ago');
  assert.equal(ago(now - 7200), '2h ago');
  assert.equal(ago(now - 3600 * 47), '47h ago');
  assert.equal(ago(now - 3600 * 72), '3d ago');
});

test('an unscored story gets no colour', () => {
  // The feed hides unscored stories, but Explore shows them: before the first
  // model every card is unscored, and a hue there would be a claim.
  assert.equal(scoreColor(null), 'var(--faint)');
  assert.equal(scoreColor(undefined), 'var(--faint)');
  assert.match(scoreColor(0.9), /--up/);
  assert.match(scoreColor(0.1), /--down/);
});

test('a score at the midpoint is drawn as no opinion', () => {
  // 0.5 is where shrinkage parks a model with nothing to say, so both sides of
  // it must fade to the same neutral rather than step from green to red.
  assert.match(scoreColor(0.5), /var\(--up\) 0%/);
  assert.match(scoreColor(0.4999), /var\(--down\) 0%/);
});
