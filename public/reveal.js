/* The verdict shown after a swipe. Shared by both judging decks — Train and
   Explore ask about different stories but reveal the answer the same way. */

import { certainty } from './certainty.js';
import { el, icon } from './dom.js';
import { pct, plural } from './format.js';
import { state } from './state.js';
import { setTrainStatus } from './status.js';

/**
 * What the model had guessed, revealed only now that the vote is cast. The
 * prediction was frozen server-side before the vote existed, so this is an
 * honest out-of-sample call, not the memorised score.
 *
 * The glyph is an equals sign, struck through when the two differ: this line
 * compares two verdicts, it does not mark one of them correct. A tick and a
 * cross would grade the vote against the guess.
 *
 * Both parties are named on every line, and the two halves stay symmetric:
 * what the model guessed, then what you said — never "you agreed", which casts
 * the model as the reference and your vote as the thing falling in line. Your
 * vote is the truth here; the guess is only ever a guess. ("Got that one
 * wrong" had the same problem in reverse: it never said whose mistake it was.)
 *
 * How sure it was is said in words as well as a number, on the CERTAINTY
 * scale — "51% certain" is a sentence that contradicts itself.
 */
export function showReveal(prediction, value, story) {
  const title = story
    ? el('a', {
        className: 'judged-title',
        href: story.url ?? `https://news.ycombinator.com/item?id=${story.id}`,
        target: '_blank', rel: 'noreferrer',
        title: story.title,
      }, story.title)
    : null;

  // What the vote gives the model that it did not have. Directly caused by the
  // swipe, and it only goes up — unlike a hit rate, which the queue pins near
  // chance by design, since the boundary stratum picks the cards the model is
  // least sure about.
  const taught = state.taught?.count
    ? el('span', { className: 'tally' }, [
        `Taught it ${plural(state.taught.count, 'new signal')}`,
        state.taught.labels.length ? `: ${state.taught.labels.join(', ')}` : '',
      ].join(''))
    : null;

  const line = (...nodes) => el('div', { className: 'judged-line' }, nodes.filter(Boolean));

  if (!prediction) {
    // A skip, or a story the model had never scored. Say what actually
    // happened rather than inventing a result.
    const said = value === 0
      ? el('span', {}, 'You skipped it — nothing to learn from a skip.')
      : el('span', {}, 'Brain had no guess on file for that one.');
    setTrainStatus([line(said), ...(taught ? [line(taught)] : []), ...(title ? [title] : [])]);
    return;
  }

  const guessedYes = prediction.score >= 0.5;
  // How sure it was of the call it actually made. Beside "guessed no", the
  // probability of yes reads as the opposite of what it means.
  const strength = guessedYes ? prediction.score : 1 - prediction.score;
  const sure = certainty(strength);

  setTrainStatus([
    line(
      el('span', { className: `verdict ${prediction.agreed ? 'hit' : 'miss'} sure-${sure.name}` }, [
        icon(prediction.agreed ? 'equals' : 'not-equals'),
        `Brain guessed ${guessedYes ? 'yes' : 'no'} (${sure.label}, ${pct(strength)})`,
      ]),
      el('span', {}, `— you said ${value > 0 ? 'yes' : 'no'}.`),
    ),
    // Its own line: what the model guessed and what it gained from the vote
    // are two different statements, and running them together made a sentence
    // long enough to lose.
    ...(taught ? [line(taught)] : []),
    ...(title ? [title] : []),
  ]);
}

/** Human message when one class is still short of the minimum, else null. */
export function needMore(votes) {
  const min = state.stats?.minVotesToTrain ? Math.ceil(state.stats.minVotesToTrain / 2) : 3;
  const up = Math.max(0, min - votes.up);
  const down = Math.max(0, min - votes.down);
  if (!up && !down) return null;
  const part = (n, word) => `${n} more ${word} vote${n === 1 ? '' : 's'}`;
  return `Need ${up ? part(up, 'yes') : ''}${up && down ? ' and ' : ''}${down ? part(down, 'no') : ''}`;
}
