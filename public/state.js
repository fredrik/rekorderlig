/* The one state object. Every view owns a slice of it — `judgedIds` is the
   one shared by both decks — nothing else holds view state, and nothing
   derives from it that isn't recomputed on render. */

import { FEED_DEFAULTS } from './feed-params.js';

export const state = {
  view: 'train',
  stats: null,
  queue: [],
  judgedIds: new Set(),
  // What the last vote taught the model, for the reveal under the deck.
  taught: null,
  // The round in play: {seq, size, judged, skipped}. Null between rounds.
  round: null,
  // Explore's deck, whole: how far back its pool reaches (set by the range
  // chips), the cards drawn for it, the stale-response ticket and the traction
  // bar `/api/explore` ships beside them. One slice, like `feed` and `votes` —
  // the queue used to live in a module-level object of its own, which was
  // drift rather than a decision and left one view's state in two places to
  // keep in step.
  explore: { days: 7, queue: [], ticket: 0, bar: null },
  // The feed's filters are a projection of the GET parameters (FEED_DEFAULTS,
  // below); offset/items/loading are paging state and stay out of the URL.
  feed: { ...FEED_DEFAULTS, offset: 0, items: [], loading: false },
  votes: { value: 'all', offset: 0, items: [], loading: false },
  // Which of the welcome flow's two screens is up. Whether the flow is up at
  // all is `view === 'onboard'`, like any other view — see onboard.js.
  onboard: { step: 'name' },
};
