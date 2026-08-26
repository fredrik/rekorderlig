import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

/**
 * Tripwires, not proofs: there is no browser in this test run (and no room for
 * one — zero npm dependencies), so these only assert that the declarations
 * holding the layout inside the viewport are still there. Each one was a bug.
 */

test('the deck grids have a zero floor, so no card is sized by its content', () => {
  // `#view-train`'s track was `auto`, which takes its minimum from the item's
  // min-content — and the judged title under the buttons is `nowrap`. One long
  // title therefore sized the whole view to that title: 527px of card, vote row
  // and status inside a 380px phone, scrolling sideways. Explore is the same
  // cluster over a different queue, so the floor has to cover it too.
  // Anchored at line start: "#view-train" also appears inside a comment.
  const rule = css.match(/^#view-train[^{]*\{[^}]*\}/ms);
  assert.ok(rule, '#view-train rule missing');
  assert.match(rule[0], /grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(rule[0], /#view-explore/, 'Explore is missing the zero floor');
  assert.match(css, /\.train-main \{[^}]*min-width:\s*0/s);
  assert.match(css, /\.explore-main \{[^}]*min-width:\s*0/s);
});

test('titles break inside an unbreakable token rather than out of the page', () => {
  // A raw URL or a scoped package name in an HN title is wider than a phone at
  // the trainer card's 32px, and a domain has no spaces at all: a real one,
  // `observationalepidemiology.blogspot.com`, overflowed the card at 320px.
  for (const selector of ['.trainer-title', '.trainer-meta', '.story-title', '.term-chip']) {
    const rule = css.match(new RegExp(`\\${selector} \\{[^}]*\\}`, 's'));
    assert.ok(rule, `${selector} rule missing`);
    assert.match(rule[0], /overflow-wrap:\s*anywhere/, `${selector} may overflow`);
  }
});
