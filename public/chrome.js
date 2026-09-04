/* The frame around the views: the tagline, the stats refresh, the name a user
   goes by and the theme toggle. Reaches the open view only through the
   registry, never by importing it. */

import { hook } from './registry.js';
import { $, api, icon } from './dom.js';
import { pct } from './format.js';
import { state } from './state.js';

// The tagline is view-specific: Train gets the full picture, Feed only the
// model quality (vote count lives in Train where voting happens), Votes the
// verdict tally, Brain nothing — its panels already show every number.
export function renderTagline() {
  const s = state.stats;
  const t = $('#tagline');
  // Mid-welcome the header keeps only the brand: a tagline counting "0 / 12"
  // would be answering a question the reader has not been asked yet.
  if (state.view === 'onboard') { t.textContent = ''; return; }
  // Brain's panels already show every number; the one thing they do not say
  // is whose brain it is.
  if (!s || state.view === 'brain') { t.textContent = s?.user?.displayName ?? ''; return; }
  if (state.view === 'votes') {
    t.textContent = `${s.votes.up} yes · ${s.votes.down} no · ${s.votes.skip} skipped`;
    return;
  }
  const accuracy = s.model?.metrics?.accuracy != null ? `${pct(s.model.metrics.accuracy)} accurate` : 'learning';
  // Mid-round the header is the progress meter — the point of a round is that
  // you can see the end of it. Between rounds it goes back to describing the
  // model: signals only ever climbs, accuracy is the companion that can fall.
  if (state.view === 'train' && state.round) {
    const done = state.round.judged + state.round.skipped;
    t.textContent = `${done} / ${state.round.size}`;
    return;
  }
  // Explore has no round to count down, so it says what is left in each tier.
  if (state.view === 'explore' && state.explore.queue.length) {
    const probably = state.explore.queue.filter((story) => story.tier === 'probably').length;
    t.textContent = `${probably} probably · ${state.explore.queue.length - probably} possibly`;
    return;
  }
  const signals = s.model?.features ? `${s.model.features.toLocaleString()} signals` : null;
  t.textContent = signals ? `${signals} · ${accuracy}` : accuracy;
}

export async function refreshStats() {
  state.stats = await api('/api/stats');
  renderTagline();
  // Whichever view is open gets to redraw itself; only Brain asks for it.
  hook(state.view, 'stats')?.();
}

/**
 * The one way a name changes: POST it, take the row the server hands back,
 * and let everything that shows a name redraw. Both the welcome flow and
 * Brain's panel come through here, so they cannot disagree.
 */
export async function saveDisplayName(name) {
  const { user } = await api('/api/me', { method: 'POST', body: { displayName: name } });
  state.stats.user = user;
  renderTagline();
  hook(state.view, 'stats')?.();
  return user;
}

const themeBtn = $('#theme-toggle');

const currentTheme = () =>
  document.documentElement.dataset.theme
  || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

function paintThemeButton() {
  const dark = currentTheme() === 'dark';
  themeBtn.replaceChildren(icon(dark ? 'sun' : 'moon'));
  themeBtn.ariaLabel = dark ? 'Switch to light mode' : 'Switch to dark mode';
}

themeBtn.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
  paintThemeButton();
});

paintThemeButton();

// Static icon slots in the HTML; app.js is the single source for icon markup.
for (const slot of document.querySelectorAll('[data-icon]')) {
  slot.replaceChildren(icon(slot.dataset.icon));
}
