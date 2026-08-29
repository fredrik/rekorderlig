//! The confidence bands the reveal names a call with.
//!
//! Was a tripwire in tests/frontend.rs, which parsed the table out of app.js
//! with a regex and checked its ordering. The table is importable now, so this
//! checks the thing that actually matters: what `certainty()` returns.
//!
//! What stays a tripwire over there is the half no test can run — each band's
//! `name` needs a matching `.verdict.sure-<name>` colour in styles.css, and
//! nothing at runtime notices when one is missing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CERTAINTY, certainty } from '../public/certainty.js';

test('the bands run high to low and bottom out at a floor', () => {
  // `certainty()` takes the first band the strength clears, so an out-of-order
  // table would label a 96% call by whichever loose band happened to sit first,
  // and a floor above 0 would return undefined for the calls that most need a
  // name — the ones near 0.5.
  for (let i = 1; i < CERTAINTY.length; i++) {
    assert.ok(CERTAINTY[i].at < CERTAINTY[i - 1].at,
      `${CERTAINTY[i].name} is not below ${CERTAINTY[i - 1].name}`);
  }
  assert.equal(CERTAINTY.at(-1).at, 0, 'the last band must be the floor');
  assert.ok(CERTAINTY.length >= 3, 'too few bands to say anything');
});

test('every band has a name and words to say it in', () => {
  for (const band of CERTAINTY) {
    assert.match(band.name, /^\w+$/, 'the name becomes a CSS class');
    assert.ok(band.label.length > 0, `${band.name} has no words`);
  }
});

test('a call is named at every strength it can have', () => {
  // A call is at least 0.5 sure by construction — it is the strength of the
  // verdict the model actually reached, not P(yes) — but the floor is 0, so
  // nothing below it can fall through either.
  for (let s = 0; s <= 1.0001; s += 0.01) {
    assert.ok(certainty(s), `no band for ${s.toFixed(2)}`);
  }
});

test('the bands name the calls they were written for', () => {
  assert.equal(certainty(0.96).label, 'very sure');
  assert.equal(certainty(0.81).label, 'fairly sure');
  assert.equal(certainty(0.62).label, 'leaning');
  // The one the whole scale exists for: 51% certain is a coin flip described
  // as a conviction, and it used to be drawn in the same red as a call at 96%.
  assert.equal(certainty(0.51).label, 'a coin flip');
});

test('a band boundary belongs to the higher band', () => {
  for (const band of CERTAINTY) assert.equal(certainty(band.at).name, band.name);
});
