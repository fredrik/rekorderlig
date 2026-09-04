/* Which section is on screen, and what its URL is (`urlFor()`, `navigate()`);
   hides and shows the six sections, and takes the tab bar away for the
   welcome flow.

   Views register themselves (see registry.js); this file imports none of them,
   which is what keeps the module graph acyclic — every view imports the
   router, and app.js imports the views so their registration runs. */


import { $ } from './dom.js';
import { renderTagline } from './chrome.js';
import { hook } from './registry.js';
import { state } from './state.js';

// Every section the router owns. The welcome flow is one of them — its own
// section, its own module, its own path — but nothing routes *to* it: who
// belongs in it is a fact about the user, not something a URL can claim, so
// `onboardingRoute()` gets the last word on the way in and the way out (see
// app.js, and onboard.js for the fact itself). It is listed here so a stale
// `/onboard` in the address bar resolves to a real view rather than silently
// to Train, and so this loop hides its section like any other.
const VIEWS = ['train', 'explore', 'feed', 'votes', 'brain', 'onboard'];

export const viewFromPath = () => {
  const name = location.pathname.replace(/^\//, '');
  return VIEWS.includes(name) ? name : 'train';
};

/**
 * Where a view lives. Its path, unless it registered a `url` hook — the feed
 * does, because its filters are GET parameters and belong in the address bar.
 */
export const urlFor = (view) => hook(view, 'url')?.() ?? `/${view}`;

export function showView(view, { push = true } = {}) {
  // Each section owns a path (/train, /feed, /brain) so a refresh or a
  // bookmark lands back on the same section; the server serves the app
  // shell for every one of them. Only the feed carries GET parameters, and
  // they are written from `state.feed` rather than copied off the current URL
  // — so leaving the feed and coming back by a tab restores the filters you
  // left it under, and the address bar keeps saying what the list is showing.
  const url = urlFor(view);
  if (push && location.pathname + location.search !== url) history.pushState(null, '', url);
  state.view = view;
  for (const name of VIEWS) $(`#view-${name}`).hidden = name !== view;
  for (const tab of document.querySelectorAll('nav.tabs button')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  }
  $('#filters-toggle').hidden = view !== 'feed';
  // The tabs are the way out of every screen in this app, so they are the one
  // thing the welcome flow has to take away: an onboarding you can click past
  // is a prompt, which is what it replaces. Here rather than in onboard.js for
  // the same reason the filters button is here — chrome that belongs to one
  // view is still the router's to paint, and one writer per flag.
  $('nav.tabs').hidden = view === 'onboard';
  renderTagline();
  hook(view, 'show')?.();
}

/**
 * Go to a URL that carries state of its own — the Brain histogram opening one
 * of its buckets in the feed. The view adopts the filters out of the URL
 * before it is shown, so the list and the panel agree from the first paint.
 */
export function navigate(url) {
  history.pushState(null, '', url);
  const view = viewFromPath();
  hook(view, 'adopt')?.(new URL(url, location.origin).search);
  showView(view, { push: false });
}
