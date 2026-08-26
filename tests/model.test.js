import test from 'node:test';
import assert from 'node:assert/strict';
import { featurize } from '../src/features.js';
import { fit, toRuntime, scoreStory, crossValidate, insights, auc } from '../src/model.js';

const LIKED = [
  'Rust borrow checker internals', 'Writing a compiler in Rust', 'Rust memory safety proofs',
  'A tiny compiler for a toy language', 'Compiler optimisation tricks', 'Zig and Rust interop',
];
const DISLIKED = [
  'Apple announces the new iPhone', 'iPhone 19 review roundup', 'Apple Vision Pro sales slump',
  'Why Apple keeps winning', 'The new iPhone camera explained', 'Apple stock hits a record',
];

const examples = [
  ...LIKED.map((title) => ({ features: featurize({ title }), label: 1 })),
  ...DISLIKED.map((title) => ({ features: featurize({ title }), label: 0 })),
];

test('separates two clearly different tastes', () => {
  const rt = toRuntime(fit(examples));
  const liked = scoreStory(rt, { title: 'Rust compiler plugins explained' });
  const disliked = scoreStory(rt, { title: 'Apple iPhone event recap' });
  assert.ok(liked.raw > 0.8, `expected a high score, got ${liked.raw}`);
  assert.ok(disliked.raw < 0.2, `expected a low score, got ${disliked.raw}`);
  assert.ok(liked.score > disliked.score);
});

test('shown scores are pulled towards 50% while evidence is thin', () => {
  const thin = toRuntime(fit(examples));
  const thick = toRuntime(fit(Array.from({ length: 6 }, (_, i) =>
    examples.map((e) => ({ ...e, i }))).flat()));
  const title = { title: 'Rust compiler plugins explained' };
  const a = scoreStory(thin, title);
  const b = scoreStory(thick, title);
  assert.ok(a.score < a.raw, 'a 12-vote model should not claim certainty');
  assert.ok(b.score > a.score, 'more votes, less shrinkage');
  assert.ok(b.score < b.raw + 1e-9);
});

test('unknown titles land near the middle', () => {
  const rt = toRuntime(fit(examples));
  const { score, coverage } = scoreStory(rt, { title: 'Beekeeping in Provence' });
  assert.ok(score > 0.35 && score < 0.65, `expected an unsure score, got ${score}`);
  assert.equal(coverage, 0, 'no known features means no coverage');
});

test('confidence grows with evidence', () => {
  const small = toRuntime(fit(examples.slice(0, 4).concat(examples.slice(6, 10))));
  const big = toRuntime(fit([...examples, ...examples]));
  const title = { title: 'Rust compiler internals' };
  assert.ok(scoreStory(big, title).confidence > scoreStory(small, title).confidence);
});

test('training is deterministic', () => {
  assert.deepEqual(fit(examples).weights, fit(examples).weights);
});

test('cross-validation beats the majority baseline on separable data', () => {
  const m = crossValidate(examples);
  assert.ok(m.accuracy > 0.8, `accuracy was ${m.accuracy}`);
  assert.ok(m.auc > 0.9, `auc was ${m.auc}`);
  assert.equal(m.baseline, 0.5);
});

test('the noise band is the sample spread, not the population one', () => {
  // Deliberately noisy labels, so the folds genuinely disagree: on separable
  // data every fold scores 1, the spread is 0 and there is nothing to measure.
  const words = ['rust', 'apple', 'compiler', 'iphone', 'sqlite', 'crypto', 'kernel', 'startup'];
  const noisy = Array.from({ length: 40 }, (_, i) => {
    const fromWords = /rust|compiler|sqlite|kernel/.test(words[i % 8]) ? 1 : 0;
    return {
      features: featurize({ title: `${words[i % 8]} ${words[(i * 3) % 8]} thing number ${i}` }),
      label: i % 7 === 0 ? 1 - fromWords : fromWords, // every seventh label contradicts its words
    };
  });

  const m = crossValidate(noisy);
  const mean = m.foldAccuracy.reduce((a, b) => a + b, 0) / m.foldAccuracy.length;
  const ss = m.foldAccuracy.reduce((a, v) => a + (v - mean) ** 2, 0);
  const population = Math.sqrt(ss / m.foldAccuracy.length);
  const sample = Math.sqrt(ss / (m.foldAccuracy.length - 1));

  assert.ok(sample > population, 'the fixture must disagree across folds or this proves nothing');
  // Five draws is a small sample and the population form is biased low, always
  // in the direction of calling a wobble significant.
  assert.ok(m.noise > population, `noise ${m.noise} fell back to the population spread`);
  assert.ok(Math.abs(m.noise - sample) < 1e-12, `noise ${m.noise} vs sample sd ${sample}`);
});

test('cross-validation returns null when a class is too small', () => {
  assert.equal(crossValidate(examples.slice(0, 7)), null);
});

test('auc handles ties and degenerate label sets', () => {
  assert.equal(auc([1, 0], [0.9, 0.1]), 1);
  assert.equal(auc([1, 0], [0.5, 0.5]), 0.5);
  assert.equal(auc([1, 1], [0.9, 0.1]), null);
});

test('insights name the words that drove the split', () => {
  const model = fit(examples);
  const { likes, dislikes } = insights(model, { limit: 5 });
  assert.ok(likes.some((r) => r.label.startsWith('rust') || r.label.startsWith('compil')), JSON.stringify(likes));
  assert.ok(dislikes.some((r) => r.label.includes('apple') || r.label.includes('iphone')), JSON.stringify(dislikes));
  assert.ok(likes.every((r) => r.support >= 2));
});

test('class weighting keeps a lopsided history usable', () => {
  const lopsided = [
    ...LIKED.slice(0, 2).map((title) => ({ features: featurize({ title }), label: 1 })),
    ...DISLIKED.map((title) => ({ features: featurize({ title }), label: 0 })),
    ...DISLIKED.map((title) => ({ features: featurize({ title: `${title} again` }), label: 0 })),
  ];
  const rt = toRuntime(fit(lopsided));
  assert.ok(scoreStory(rt, { title: 'Rust compiler internals' }).raw > 0.5);
});
