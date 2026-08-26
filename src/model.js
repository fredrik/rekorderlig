/**
 * A small L2-regularised logistic regression over the sparse title features,
 * trained with AdaGrad SGD. Everything is deterministic: the same votes always
 * produce the same model, which keeps the "why did it score this?" panel honest.
 */
import { featurize, describeFeature } from './features.js';

const DEFAULTS = {
  epochs: 60,
  lr: 0.35,
  l2: 2e-4,
  minCount: 1,      // features seen in fewer training titles than this are dropped
  seed: 20260824,
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/**
 * @param {Array<{features: Map<string, number>, label: 0|1}>} examples
 */
export function fit(examples, options = {}) {
  const opt = { ...DEFAULTS, ...options };

  const support = new Map();
  for (const ex of examples) {
    for (const name of ex.features.keys()) support.set(name, (support.get(name) ?? 0) + 1);
  }

  const index = new Map();
  const names = [];
  const counts = [];
  for (const [name, count] of support) {
    if (name !== '__bias__' && count < opt.minCount) continue;
    index.set(name, names.length);
    names.push(name);
    counts.push(count);
  }
  if (!index.has('__bias__')) {
    index.set('__bias__', names.length);
    names.push('__bias__');
    counts.push(examples.length);
  }

  const d = names.length;
  const w = new Float64Array(d);
  const g2 = new Float64Array(d).fill(1e-8);

  // Encode once: parallel arrays of indices/values per example.
  const rows = examples.map((ex) => {
    const idx = [];
    const val = [];
    for (const [name, v] of ex.features) {
      const i = index.get(name);
      if (i !== undefined) { idx.push(i); val.push(v); }
    }
    return { idx, val, y: ex.label };
  });

  const nPos = rows.reduce((a, r) => a + r.y, 0);
  const nNeg = rows.length - nPos;
  // Balance the classes so a lopsided vote history doesn't collapse to "predict no".
  const wPos = nPos ? rows.length / (2 * nPos) : 1;
  const wNeg = nNeg ? rows.length / (2 * nNeg) : 1;

  // Regularise harder when there is little data: 20 votes should not produce
  // the same swagger as 2000.
  const l2 = opt.l2 * Math.max(1, 200 / Math.max(1, rows.length));

  const rand = mulberry32(opt.seed);
  const order = rows.map((_, i) => i);

  for (let epoch = 0; epoch < opt.epochs; epoch++) {
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const r of order.map((i) => rows[i])) {
      let z = 0;
      for (let k = 0; k < r.idx.length; k++) z += w[r.idx[k]] * r.val[k];
      const err = sigmoid(z) - r.y;
      const cw = r.y === 1 ? wPos : wNeg;
      for (let k = 0; k < r.idx.length; k++) {
        const i = r.idx[k];
        const grad = cw * err * r.val[k] + l2 * w[i];
        g2[i] += grad * grad;
        w[i] -= (opt.lr / Math.sqrt(g2[i])) * grad;
      }
    }
  }

  return {
    version: 1,
    names,
    counts,
    weights: Array.from(w, (x) => Math.round(x * 1e6) / 1e6),
    nExamples: rows.length,
    nPos,
    nNeg,
    options: opt,
  };
}

export function toRuntime(model) {
  const index = new Map();
  for (let i = 0; i < model.names.length; i++) index.set(model.names[i], i);
  return { ...model, index, weightArray: Float64Array.from(model.weights) };
}

/**
 * Score a feature map.
 * @returns {{score:number, confidence:number, coverage:number, contributions:Array}}
 */
export function scoreFeatures(runtime, features, { explain = false } = {}) {
  const { index, weightArray } = runtime;
  let z = 0;
  let knownMass = 0;
  let totalMass = 0;
  const contributions = [];

  for (const [name, v] of features) {
    if (name === '__bias__') {
      const i = index.get(name);
      if (i !== undefined) z += weightArray[i] * v;
      continue;
    }
    // Coverage measures recognised *content* (words, sites, authors). Style
    // features like "is a question" match every title and would inflate it.
    const isContent = !name.startsWith('t:');
    if (isContent) totalMass += Math.abs(v);
    const i = index.get(name);
    if (i === undefined) continue;
    if (isContent) knownMass += Math.abs(v);
    const c = weightArray[i] * v;
    z += c;
    if (explain && c !== 0) {
      contributions.push({ name, ...describeFeature(name), effect: c, support: runtime.counts[i] });
    }
  }

  const coverage = totalMass > 0 ? knownMass / totalMass : 0;
  // Confidence blends "how much of this title the model has seen before" with
  // "how many votes exist at all" — a 5-vote model should never sound certain.
  const volume = Math.min(1, runtime.nExamples / 40);
  const balance = Math.min(1, Math.min(runtime.nPos, runtime.nNeg) / 8);
  const confidence = Math.max(0, Math.min(1, volume * balance * (0.3 + 0.7 * coverage)));

  if (explain) contributions.sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));

  // Logistic regression is happily overconfident on a handful of votes, so the
  // number the app shows is pulled back towards "no idea" by how much evidence
  // actually backs it. Ranking is preserved; the bragging is not.
  const raw = sigmoid(z);
  const score = 0.5 + (raw - 0.5) * (0.3 + 0.7 * confidence);

  return { score, raw, logit: z, confidence, coverage, contributions };
}

export function scoreStory(runtime, story, options) {
  return scoreFeatures(runtime, featurize(story), options);
}

/* ------------------------------------------------------------------ metrics */

export function auc(labels, scores) {
  const pairs = labels.map((y, i) => ({ y, s: scores[i] })).sort((a, b) => a.s - b.s);
  let rankSum = 0;
  let i = 0;
  while (i < pairs.length) {
    let j = i;
    while (j + 1 < pairs.length && pairs[j + 1].s === pairs[i].s) j++;
    const avgRank = (i + j) / 2 + 1; // average rank for ties
    for (let k = i; k <= j; k++) if (pairs[k].y === 1) rankSum += avgRank;
    i = j + 1;
  }
  const nPos = labels.reduce((a, y) => a + y, 0);
  const nNeg = labels.length - nPos;
  if (!nPos || !nNeg) return null;
  return (rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/** Stratified k-fold cross-validation, so the UI can report honest accuracy. */
export function crossValidate(examples, options = {}, k = 5) {
  const pos = examples.filter((e) => e.label === 1);
  const neg = examples.filter((e) => e.label === 0);
  const folds = Math.min(k, pos.length, neg.length);
  if (folds < 2) return null;

  const assign = (arr) => arr.map((e, i) => ({ ...e, fold: i % folds }));
  const all = [...assign(pos), ...assign(neg)];

  const labels = [];
  const scores = [];
  // Accuracy per fold, kept rather than averaged away: the spread across folds
  // is the only honest measure of how much this number wobbles on its own, and
  // a round of a dozen votes moves it by about that much.
  const foldAccuracy = [];
  // The held-out score per example, keyed by whatever id the caller attached.
  // The aggregate metrics below are a summary of these; the Votes view wants
  // them one at a time, so they are returned instead of being thrown away.
  const heldOut = [];
  let logLoss = 0;
  for (let f = 0; f < folds; f++) {
    const train = all.filter((e) => e.fold !== f);
    const test = all.filter((e) => e.fold === f);
    if (!train.some((e) => e.label === 1) || !train.some((e) => e.label === 0)) return null;
    const rt = toRuntime(fit(train, options));
    let foldCorrect = 0;
    for (const e of test) {
      const { score } = scoreFeatures(rt, e.features);
      labels.push(e.label);
      scores.push(score);
      if (e.id != null) heldOut.push({ id: e.id, score });
      if ((score >= 0.5 ? 1 : 0) === e.label) foldCorrect++;
      const p = Math.min(1 - 1e-9, Math.max(1e-9, score));
      logLoss += -(e.label * Math.log(p) + (1 - e.label) * Math.log(1 - p));
    }
    if (test.length) foldAccuracy.push(foldCorrect / test.length);
  }

  const correct = labels.filter((y, i) => (scores[i] >= 0.5 ? 1 : 0) === y).length;
  const majority = Math.max(pos.length, neg.length) / examples.length;
  const accuracy = correct / labels.length;
  return {
    folds,
    n: labels.length,
    accuracy,
    baseline: majority,
    auc: auc(labels, scores),
    logLoss: logLoss / labels.length,
    foldAccuracy,
    // How far a single accuracy figure can be expected to move without
    // anything having been learned, so the app can tell a real change from a
    // wobble. Two estimates, larger wins: what the folds actually disagree
    // about, and the standard error on this many examples.
    //
    // The error term is Agresti-Coull (two successes and two failures added)
    // rather than the textbook binomial. The plain form collapses to exactly
    // zero when a small model scores 100% — eight votes separated perfectly is
    // not certainty, and a zero band would make every later move look
    // significant.
    noise: Math.max(spread(foldAccuracy), standardError(correct, labels.length)),
    heldOut,
  };
}

/** Agresti-Coull standard error: never zero, however clean the split. */
function standardError(correct, n) {
  const adjusted = (correct + 2) / (n + 4);
  return Math.sqrt((adjusted * (1 - adjusted)) / (n + 4));
}

/** Population standard deviation, for the fold spread. */
function spread(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length);
}

/** Strongest learned signals, for the "what it thinks you like" panel. */
export function insights(model, { limit = 12, minSupport = 2 } = {}) {
  const rows = model.names
    .map((name, i) => ({ name, weight: model.weights[i], support: model.counts[i], ...describeFeature(name) }))
    .filter((r) => r.name !== '__bias__' && r.support >= minSupport && Math.abs(r.weight) > 1e-4);
  const byWeight = [...rows].sort((a, b) => b.weight - a.weight);
  return {
    likes: byWeight.slice(0, limit).filter((r) => r.weight > 0),
    dislikes: byWeight.slice(-limit).reverse().filter((r) => r.weight < 0),
  };
}
