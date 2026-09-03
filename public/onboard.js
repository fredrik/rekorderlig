/* The first five minutes: a name, what this thing is, and a round to judge.

   A view like the other five — its own section in the HTML, its own path, the
   router hiding and showing it — with one thing that sets it apart: nothing
   navigates here. "Has this person been through it" is a fact about their row
   (`displayName` is null, which is what an invite mints), and the server's
   answer is the one that decides, so `onboardingRoute()` overrules the address
   bar in both directions: a fresh invitee lands here whatever link they came
   in on, and nobody else can walk in by typing the path.

   Two screens, `state.onboard.step`. Once the flow is up the step is its own
   business — nothing outside it moves — and it ends by handing off to Train's
   ordinary round.

   It imports `chrome.js` for `saveDisplayName()`, the one way a name changes,
   so the welcome screen and Brain's rename cannot disagree. */

import { register } from './registry.js';
import { saveDisplayName } from './chrome.js';
import { $ } from './dom.js';
import { showView } from './router.js';
import { state } from './state.js';

/** A row an invite minted and nobody has named yet. The whole condition. */
const nameless = () => {
  const user = state.stats?.user;
  return !!user && user.displayName == null;
};

/**
 * The view the app should open, given the one the address bar asked for.
 *
 * Called once, at boot, by app.js — the composition root is where "which
 * section opens" already lives. Both directions are the same rule: the row
 * decides, not the URL. A nameless user gets the flow whatever link brought
 * them; anyone else who lands on `/onboard` (a stale bookmark, a refresh half
 * way through) gets the app, because there is nothing left to walk them into.
 */
export const onboardingRoute = (view) =>
  nameless() ? 'onboard' : view === 'onboard' ? 'train' : view;

/** Draw whichever step is up. The router calls this when the view opens. */
function paint() {
  $('#onboard-step-name').hidden = state.onboard.step !== 'name';
  $('#onboard-step-how').hidden = state.onboard.step !== 'how';
}

// No `stats` hook that re-routes: entering is decided once, at boot. A poll
// arriving mid-flow would otherwise throw a reader on the second screen back
// to the first — on its own schedule, having been handed a name in between.
register('onboard', { show: paint });

$('#onboard-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const note = $('#onboard-note');
  try {
    await saveDisplayName($('#onboard-name').value);
    note.textContent = '';
    // Past the server's validation, so the name is really theirs now. The
    // flow does not end here — it advances; `saveDisplayName` has already
    // redrawn everything that shows a name, this view included.
    state.onboard.step = 'how';
    paint();
  } catch (err) {
    note.textContent = err.message;
  }
});

$('#onboard-start').addEventListener('click', () => {
  // Train's `show` hook deals or resumes a round, so the first thing after
  // this button is the deck it was all describing. It is the ordinary round —
  // there is no tutorial round, because a round that did not count would have
  // to be explained too.
  showView('train');
});
