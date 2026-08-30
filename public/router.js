/* Which section is on screen, and what its URL is.

   Views register themselves (see registry.js); this file imports none of them,
   which is what keeps the module graph acyclic — every view imports the
   router, and app.js imports the views so their registration runs. */


import { $ } from './dom.js';
import { renderTagline } from './chrome.js';
import { hook } from './registry.js';
import { state } from './state.js';

const VIEWS = ['train', 'explore', 'feed', 'votes', 'brain'];

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
