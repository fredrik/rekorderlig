/* Status goes into the layout, never over it — a note line that belongs to
   the page, for whichever view is open. */

import { $ } from './dom.js';
import { state } from './state.js';

let statusTimer;

// How long a verdict stays before it fades. Long enough to finish reading the
// title it names and glance at the tally, without still being there when the
// next swipe lands on top of it. The fade itself is slow (see .train-status)
// so it reads as leaving rather than blinking out.
const REVEAL_HOLD_MS = 5500;

/**
 * Status goes into the layout, never over it. The old floating toast was
 * unreadable mid-swipe and gone by the time you looked up — and it announced
 * "Learned · 64% accurate" after a skip, which trained nothing.
 *
 * `nodes` may be a string or elements. An error stays until something replaces
 * it; anything else clears itself after a few seconds.
 */
export function setTrainStatus(nodes, { error = false, hold = false } = {}) {
  // Both decks judge, so both report; the line belongs to whichever is open.
  const t = $(state.view === 'explore' ? '#explore-status' : '#train-status');
  clearTimeout(statusTimer);
  t.classList.remove('fading');
  t.classList.toggle('err', error);
  t.replaceChildren(...(Array.isArray(nodes) ? nodes : [nodes ?? '']));
  if (!hold && !error && nodes) {
    statusTimer = setTimeout(() => t.classList.add('fading'), REVEAL_HOLD_MS);
  }
}

/** The same idea for the other views: a note line that belongs to the page. */
function setNote(sel, message, { error = false } = {}) {
  const n = $(sel);
  if (!n) return;
  n.textContent = message ?? '';
  n.classList.toggle('err', Boolean(error));
}

export const setVotesNote = (m, o) => setNote('#votes-note', m, o);

/** The same list rows appear in Feed and Votes; report into whichever is open. */
export const setListNote = (m, o) => setNote(state.view === 'feed' ? '#feed-note' : '#votes-note', m, o);

export const setDataNote = (m, o) => setNote('#data-note', m, o);
