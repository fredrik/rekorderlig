/* The confidence bands the reveal names a call with. No DOM and no state.
   Each band's `name` must have a matching `.verdict.sure-<name>` colour in
   styles.css — the one thing here that no test can check by running it, so
   `tests/frontend.rs` holds the two files to each other. */

// How sure the model was, in words. A bare percentage next to the word
// "certain" lies at the bottom of its own range: "51% certain" is a coin flip
// described as a conviction, and it read as one — same red, same weight, as a
// call the model made at 96%. The bands are on the *strength* of the call
// (0.5–1, the confidence in the verdict it actually reached), never on P(yes),
// which beside "guessed no" reads as its own opposite.
//
// The cuts: below 0.6 the shrunk score is a rounding of 0.5 and there is no
// opinion to report, so the line says so and goes grey — agreeing with a coin
// flip is not a hit and disagreeing with one is not a miss, and colouring it
// either way claims something the model never said. 0.75 separates a lean from
// a commitment, and 0.9 is where it is putting its whole weight behind a call
// — the band where a miss is worth noticing, because that is the model being
// confidently wrong about you. Ordered high to low; `certainty()` takes the
// first match, so the last entry is the floor and must stay at 0.
export const CERTAINTY = [
  { at: 0.9, name: 'high', label: 'very sure' },
  { at: 0.75, name: 'mid', label: 'fairly sure' },
  { at: 0.6, name: 'low', label: 'leaning' },
  { at: 0, name: 'none', label: 'a coin flip' },
];

/** The band a call's strength (0.5–1) falls in. Never null: the floor is 0. */
export function certainty(strength) {
  return CERTAINTY.find((band) => strength >= band.at);
}
