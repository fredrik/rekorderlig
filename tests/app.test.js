import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

/**
 * Tripwires over the front end's source, in the spirit of styles.test.js:
 * `app.js` touches `document` at load, so there is nothing to import in a test
 * run with no browser in it (and no room for one — zero npm dependencies).
 * These read the file as text and check the parts two files have to agree on.
 */

/** The CERTAINTY table, parsed out of the source. */
function bands() {
  const table = js.match(/const CERTAINTY = \[(.*?)\];/s);
  assert.ok(table, 'CERTAINTY table missing');
  return [...table[1].matchAll(/at: ([\d.]+), name: '(\w+)', label: '([^']+)'/g)]
    .map(([, at, name, label]) => ({ at: Number(at), name, label }));
}

test('the certainty bands run high to low and bottom out at a floor', () => {
  // `certainty()` takes the first band the strength clears, so an out-of-order
  // table would label a 96% call by whichever loose band happened to sit first,
  // and a floor above 0 would return undefined for the calls that most need a
  // name — the ones near 0.5.
  const table = bands();
  assert.ok(table.length >= 3, 'too few bands to say anything');
  for (const [i, band] of table.entries()) {
    if (i) assert.ok(band.at < table[i - 1].at, `${band.name} is not below ${table[i - 1].name}`);
  }
  assert.equal(table.at(-1).at, 0, 'the last band must be the floor');
  // A call is at least 0.5 sure by construction (it is the strength of the
  // verdict it reached), so a band above 0.5 would never be the floor.
  assert.ok(table.at(-2).at > 0.5, 'the band above the floor must sit above a coin flip');
});

test('every certainty band has a colour of its own', () => {
  // The band names are the contract between the reveal and the stylesheet:
  // `sure-${band.name}` is written as a class in app.js and coloured here.
  // Miss one and that band silently inherits the line's grey, which is exactly
  // the signal the bottom band uses to mean "no opinion".
  for (const band of bands()) {
    assert.match(css, new RegExp(`\\.verdict\\.sure-${band.name} \\{[^}]*color:`), `sure-${band.name} is uncoloured`);
  }
  // The hue comes from hit/miss and is mixed by the band; setting it through a
  // variable is what makes that possible (`currentColor` in `color` resolves to
  // the inherited value, so mixing against it would use the line's grey).
  assert.match(css, /\.verdict\.hit \{[^}]*--verdict-hue:\s*var\(--up\)/);
  assert.match(css, /\.verdict\.miss \{[^}]*--verdict-hue:\s*var\(--down\)/);
});

test('the reveal names its certainty in words, not just a percentage', () => {
  // "51% certain" was the bug: the one word the line had for confidence was
  // true at 96% and a lie at 51%.
  assert.doesNotMatch(js, /certain\)/, 'the reveal still calls a percentage "certain"');
  assert.match(js, /Brain guessed \$\{guessedYes \? 'yes' : 'no'\} \(\$\{sure\.label\}, \$\{pct\(strength\)\}\)/);
});
