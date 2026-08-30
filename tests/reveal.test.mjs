//! The line shown after a swipe.
//!
//! Replaced a tripwire that matched an exact template literal in the source —
//! which passed on a reworded sentence and failed on a harmless refactor. This
//! renders the line and reads it, so it holds the rule rather than the
//! spelling: name both parties, say how sure in words as well as a number, and
//! report the confidence in the call actually made.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mount } from './helpers/dom.mjs';

const app = await mount({ path: '/train' });
const { showReveal } = await app.load('reveal.js');

const story = { id: 1, title: 'A title', url: 'https://x.dev/a' };
const reveal = (score, agreed, value) => {
  showReveal({ score, agreed }, value, story);
  return app.text('#train-status');
};

test('the reveal names both parties, and the vote is not the one graded', () => {
  const line = reveal(0.19, false, 1);
  assert.match(line, /Brain guessed no/);
  assert.match(line, /you said yes/);
  // Never "you agreed": that casts the model as the reference and the vote as
  // the thing falling in line. The vote is the truth; the guess is a guess.
  assert.doesNotMatch(line, /you agreed|you disagreed/i);
});

test('the percentage is the confidence in the call it made, not P(yes)', () => {
  // Beside "guessed no", a raw score reads as its own opposite: a 0.19 is a
  // no held at 81%, and printing 19% there states the reverse.
  assert.match(reveal(0.19, false, 1), /guessed no \(fairly sure, 81%\)/);
  assert.match(reveal(0.81, true, 1), /guessed yes \(fairly sure, 81%\)/);
});

test('how sure it was is said in words, on the strength of the call', () => {
  assert.match(reveal(0.96, true, 1), /very sure/);
  assert.match(reveal(0.81, true, 1), /fairly sure/);
  assert.match(reveal(0.62, true, 1), /leaning/);
  // The one the scale exists for: "51% certain" is a coin flip described as a
  // conviction, and it used to be drawn in the same red as a call at 96%.
  assert.match(reveal(0.51, true, 1), /a coin flip/);
});

test('no reading of a percentage is ever called "certain"', () => {
  for (const score of [0.51, 0.62, 0.81, 0.96, 0.04]) {
    assert.doesNotMatch(reveal(score, true, 1), /certain/,
      `a call at ${score} is described as "certain"`);
  }
});

test('a skip says so instead of inventing a result', () => {
  // A skip is not a training example, so there is nothing to report about it —
  // and `judge()` sends `prediction: null` for one, which is what keeps the
  // guess branch (and its "you said no") off a card nobody judged.
  showReveal(null, 0, story);
  const line = app.text('#train-status');
  assert.match(line, /skipped/);
  assert.doesNotMatch(line, /Brain guessed/);
});

test('a story the model never scored says that, rather than guessing', () => {
  showReveal(null, 1, story);
  assert.match(app.text('#train-status'), /no guess on file/);
});
