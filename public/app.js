/* rekorderlig front end — no framework, just the DOM.

   This file is the composition root: it pulls in every view so each one
   registers itself, wires the chrome that spans them, and boots. */

// Every view is imported for its registration (see registry.js), which is
// what lets the router start them without importing them back. The named
// imports below are the two the keyboard needs, and the one the boot does.
import './brain.js';
import './feed.js';
import './onboard.js';
import './votes.js';

import { refreshStats } from './chrome.js';
import { $ } from './dom.js';
import { hook } from './registry.js';
import { voteExplore } from './explore.js';
import { onboardingRoute } from './onboard.js';
import { showView, urlFor, viewFromPath } from './router.js';
import { state } from './state.js';
import { vote } from './train.js';

for (const tab of document.querySelectorAll('nav.tabs button')) {
  tab.addEventListener('click', () => showView(tab.dataset.view));
}

// The wordmark is a way home: the feed is what the app is for. It routes in
// place like a tab — so the filters you left the feed under come back with it
// — but a modified click is left to the browser, which is the whole reason the
// anchor carries a real href.
$('.brand').addEventListener('click', (e) => {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;
  e.preventDefault();
  showView('feed');
});

// Arrows only, one binding per action, mirroring the glyphs on the buttons.
document.addEventListener('keydown', (e) => {
  const judge = state.view === 'train' ? vote : state.view === 'explore' ? voteExplore : null;
  if (!judge || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select')) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); judge(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); judge(-1); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); judge(0); }
});

// Back and forward restore the filters as well as the section: the feed's GET
// parameters are the whole of what a feed entry is, so re-reading them here is
// what makes the back button out of a histogram drill-down land on the chart
// with the previous filters intact.
window.addEventListener('popstate', () => {
  const view = viewFromPath();
  hook(view, 'adopt')?.(location.search);
  showView(view, { push: false });
});

// A 401 here means the session is gone — the cookie expired, or was revoked
// — and nothing below can work. Say so where the eye already is, then stop.
// (index.html itself is served only to a live session, so this is the case
// where the session died between the page load and its first request.)
try {
  await refreshStats();
} catch (err) {
  $('#tagline').textContent = 'Signed out — open your login link';
  throw err;
}

// Normalize the address bar (e.g. bare /) to the section path without adding
// a history entry. The feed's filters are read out of the GET parameters
// here, so a bookmarked or shared /feed?d=30&c=50 opens filtered. What goes
// back is `urlFor()`'s canonical form, which drops defaults and anything that
// failed to parse — so a hand-edited or stale link normalizes on arrival
// instead of leaving the address bar describing a filter that isn't applied.
//
// Nothing secret is in the URL any more: a login link is redeemed at /login,
// which sets the cookie and redirects here, so it never reaches this code.
// The address bar decides which section opens — except for the welcome flow.
// It is a view like any other, but it is entered from the row rather than from
// a URL: an invite mints a user with no name, and that fact outranks whichever
// link they arrived on. It answers in both directions, so `/onboard` in the
// hands of anyone who has been through it lands in the app instead (onboard.js).
const view = onboardingRoute(viewFromPath());
hook(view, 'adopt')?.(location.search);

history.replaceState(null, '', urlFor(view));

showView(view, { push: false });
