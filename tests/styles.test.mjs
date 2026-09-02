//! The two files that have to agree, and nothing else does.
//!
//! These are the last text assertions over the front end, and they are text
//! because there is nothing to run: a stylesheet has no behaviour without a
//! browser to lay it out. Everything else that used to be checked this way now
//! runs — see tests/app.test.mjs, tests/reveal.test.mjs, tests/modules.test.mjs.
//!
//! Keep that boundary. A rule that can be exercised should be exercised; only
//! an invariant spanning JS and CSS, which nothing at runtime notices breaking,
//! belongs here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CERTAINTY } from '../public/certainty.js';

// Comments stripped first. styles.css explains itself at length, and a
// selector quoted in prose is not a rule — matching one is how a check ends up
// asserting about a sentence.
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');
// `[^{}]*` before the brace so a grouped selector still matches: the deck
// floor is written `#view-train, #view-explore { ... }`.
// `(?![\w-])` so a selector cannot match a longer name it is merely a prefix
// of — without it `.verdict.sure-low` is satisfied by `.verdict.sure-lowXX`,
// and the test passes on the rename it exists to catch.
const rule = (selector) =>
  new RegExp(`${selector.replace(/[.#]/g, '\\$&')}(?![\\w-])[^{}]*\\{[^}]*\\}`, 's').exec(css)?.[0];

test('every certainty band has a colour of its own', () => {
  // The band names are the contract between the reveal and the stylesheet:
  // `sure-${band.name}` is written as a class in reveal.js and coloured here.
  // Miss one and that band silently inherits the line's grey — which is exactly
  // the signal the bottom band uses to mean "no opinion", so a missing colour
  // does not look broken, it looks like a deliberate shrug.
  //
  // The names come from importing CERTAINTY, not from parsing it out of the
  // source, so this cannot drift from the table it describes.
  assert.ok(CERTAINTY.length >= 3, 'too few bands to say anything');
  for (const band of CERTAINTY) {
    const found = rule(`.verdict.sure-${band.name}`);
    assert.ok(found, `sure-${band.name} has no rule`);
    assert.match(found, /color:/, `sure-${band.name} is uncoloured`);
  }
});

test('the verdict hue comes from a variable, so a band can mix against it', () => {
  // `currentColor` in `color` resolves to the inherited value, so mixing
  // against it would use the line's grey rather than the hit/miss hue.
  assert.match(rule('.verdict.hit'), /--verdict-hue:\s*var\(--up\)/);
  assert.match(rule('.verdict.miss'), /--verdict-hue:\s*var\(--down\)/);
});

test('the highlighted curve dot is visible, and its hover target is hittable', () => {
  // The readout follows the pointer, so the chart must say *which* run it
  // describes. The visible dot is 2px — not a hit area — so the hover hangs on
  // an invisible twin. Lose either rule and hovering rewrites the numbers while
  // nothing on the chart moves.
  assert.match(rule('.curve-dot.hot'), /stroke/, 'the highlighted dot has no treatment');
  assert.match(rule('.curve-hit'), /pointer-events:\s*all/, 'the hover targets are not hittable');
});

test('a deck card is never sized by its content', () => {
  // A grid track is min-content by default, so one long title made the whole
  // card wider than the column and the layout jumped between stories.
  for (const selector of ['#view-train', '.train-main', '.explore-main']) {
    const found = rule(selector);
    assert.ok(found, `${selector} has no rule`);
    assert.match(found, /minmax\(0,\s*1fr\)|min-width:\s*0/, `${selector} has no zero floor`);
  }
  assert.match(rule('#view-train'), /#view-explore/, 'Explore is missing the zero floor');
});

test('titles break inside an unbreakable token rather than out of the page', () => {
  // A raw URL or a scoped package name is wider than a phone at the card's
  // 32px, and a domain has no spaces at all: `observationalepidemiology.
  // blogspot.com` overflowed the card at 320px.
  for (const selector of ['.trainer-title', '.trainer-meta', '.story-title', '.term-chip']) {
    const found = rule(selector);
    assert.ok(found, `${selector} has no rule`);
    assert.match(found, /overflow-wrap:\s*anywhere/, `${selector} may overflow`);
  }
});

test('the signed-out page and the stylesheet agree on the reason names', () => {
  // The door shows one of two halves of itself, picked by `data-reason` on the
  // root element — and picked in CSS, which nothing at runtime is around to
  // notice breaking: the page runs no JavaScript, and the server only rewrites
  // one attribute. Rename a reason on either side and both halves render at
  // once, which reads as the page contradicting itself.
  const html = readFileSync(new URL('../public/signed-out.html', import.meta.url), 'utf8');
  assert.match(html, /href="\/styles\.css"/, 'the page is not wearing the stylesheet');
  const reasons = [...html.matchAll(/data-when="([\w-]+)"/g)].map((m) => m[1]);
  const wanted = new Set(reasons);
  assert.ok(wanted.size >= 2, 'a page with one reason does not need the attribute');
  for (const reason of wanted) {
    assert.ok(
      css.includes(`:root[data-reason="${reason}"]`),
      `nothing hides the other half when data-reason is "${reason}"`,
    );
  }
  // The default in the file is the reason the server does not rewrite.
  const initial = /<html[^>]*\sdata-reason="([\w-]+)"/.exec(html)?.[1];
  assert.ok(wanted.has(initial), `the page opens on "${initial}", which no half claims`);
});
