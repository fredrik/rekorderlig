/* rekorderlig front end — no framework, just the DOM.

   This file is the composition root: it pulls in every view so each one
   registers itself, wires the chrome that spans them, and boots. */

// Every view is imported for its registration (see registry.js), which is
// what lets the router start them without importing them back. The named
// imports below are the two the keyboard needs.
import './brain.js';
import './feed.js';
import './votes.js';

import { refreshStats } from './chrome.js';
import { hook } from './registry.js';
import { voteExplore } from './explore.js';
import { showView, urlFor, viewFromPath } from './router.js';
import { state } from './state.js';
import { vote } from './train.js';

for (const tab of document.querySelectorAll('nav.tabs button')) {
  tab.addEventListener('click', () => showView(tab.dataset.view));
}

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

await refreshStats();

// Normalize the address bar (e.g. bare /) to the section path without
// adding a history entry, and drop ?token=… on the way past.
//
// The token in the URL is a bootstrap, not a session: the server answers the
// first tokened request with an `rk_token` cookie good for a year (see
// `authorize()` in src/server.rs), and every request after it authorizes on
// that. Carrying the param onwards only stamps the shared secret into every
// history entry and into anything copied out of the address bar.
//
// Placement is the safety check, not an accident. `refreshStats()` above
// fetches /api/stats with no token param and no Bearer header, so it can only
// have succeeded on the cookie — reaching this line is proof the cookie took.
// If it did not, `api()` throws on the 401 and this never runs, so the tokened
// URL survives for a reload. (The 401 body says to open the tokened link
// again, which is the same recovery.)
//
// The feed's filters are read out of the same GET parameters here, so a
// bookmarked or shared /feed?days=30&minComments=50 opens filtered. What goes
// back is `urlFor()`'s canonical form, which drops defaults and anything that
// failed to parse — so a hand-edited or stale link normalizes on arrival
// instead of leaving the address bar describing a filter that isn't applied.
const boot = new URL(location.href);
boot.searchParams.delete('token');

const view = viewFromPath();
hook(view, 'adopt')?.(boot.search);

history.replaceState(null, '', urlFor(view));

showView(view, { push: false });
