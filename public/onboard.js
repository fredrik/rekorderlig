/* The first five minutes: a name, what this thing is, and a round to judge.

   Not a view. It has no tab and no path — it is a layer over the whole app,
   opened by a fact about the user (`displayName` is null, which is what an
   invite mints) rather than by navigation. Giving it a URL would put that fact
   in two places, and the server's answer is the one that decides.

   It imports `chrome.js` for `saveDisplayName()` — the one way a name changes,
   so the welcome screen and Brain's rename cannot disagree — and `router.js`
   to hand off at the end. Nothing imports this back: chrome reaches it through
   the registry, which is what that indirection is for. */

import { register } from './registry.js';
import { saveDisplayName } from './chrome.js';
import { $ } from './dom.js';
import { showView } from './router.js';
import { state } from './state.js';

/** Draw the layer for whatever `state.onboard.step` currently is. */
function paint() {
  const step = state.onboard.step;
  const running = step != null;
  $('#onboard').hidden = !running;
  // The tabs are the way out of any screen in this app, so they are the one
  // thing a flow has to take away: an onboarding you can click past is a
  // prompt, which is what this replaces.
  $('nav.tabs').hidden = running;
  // And the views themselves go, in CSS rather than by `hidden`: which
  // section is open belongs to the router, and a second writer of that flag
  // would fight it on the next `showView`. A class on the container states
  // "this app is behind a flow" once, and the stylesheet acts on it — the
  // header's tagline with it, which mid-onboarding is counting down a round
  // the reader has not been told about yet.
  $('.app').classList.toggle('onboarding', running);
  $('#onboard-step-name').hidden = step !== 'name';
  $('#onboard-step-how').hidden = step !== 'how';
}

/**
 * Enter the flow if this user has never been through it. Called on every
 * `/api/stats`, so it must only ever *start* the flow: once inside, the step
 * is the flow's own business, and a refresh landing mid-way would otherwise
 * throw the reader back to the first screen.
 */
export function renderOnboard() {
  const user = state.stats?.user;
  if (user && user.displayName == null && state.onboard.step == null) {
    state.onboard.step = 'name';
  }
  paint();
}

register('onboard', { stats: renderOnboard });

$('#onboard-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const note = $('#onboard-note');
  try {
    await saveDisplayName($('#onboard-name').value);
    note.textContent = '';
    // Past the server's validation, so the name is really theirs now. This is
    // the one place the step advances on its own: `saveDisplayName` refreshes
    // the chrome, which calls `renderOnboard` back — and by then `displayName`
    // is set, so nothing re-enters.
    state.onboard.step = 'how';
    paint();
  } catch (err) {
    note.textContent = err.message;
  }
});

$('#onboard-start').addEventListener('click', () => {
  state.onboard.step = null;
  paint();
  // Train's `show` hook deals or resumes a round, so the first thing behind
  // the layer is the deck this was all describing. It is the ordinary round —
  // there is no tutorial round, because a round that did not count would have
  // to be explained too.
  showView('train');
});
