/* The feed's filters (`FEED_DEFAULTS`, `FEED_PARAM`), as they are spelled in
   the URL and read back out of it. A parser: it decides what a link means.
   No DOM and no state, so tests/feed-params.mjs imports it and runs it. */

// The feed's filters live in the GET parameters, so a filtered feed is a place:
// bookmarkable, linkable between the phone and the laptop, and reachable with
// the back button. `state.feed` is the parsed form of them and never the other
// way round — every change goes through `setFeed()`, which writes the URL and
// repaints from it.
//
// Only values that differ from these defaults are written, so the common case
// is a bare `/feed` and the address bar stays short.
//
// minComments defaults to 10: the corpus holds ~300 stories/day but the tail is
// 1-comment noise nobody reads; "any" is one tap away for gem-hunting.
export const FEED_DEFAULTS = {
  mode: 'foryou',
  days: 7,
  // Both score bounds are integer percentages here and in the URL, and are
  // divided by 100 once, in `loadFeed()`, for the API. That unit is the
  // slider's (step=5), the band chip's ("match 70–75%") and the histogram's
  // (20 equal bins over [0,1] — every edge is a whole 5%), so nothing is lost
  // by it and `s=70` reads as what it means.
  minScore: 0,
  maxScore: null,
  // One specific day (`2026-08-12`), clicked out of the stories-per-day chart.
  // `days` and `day` are two shapes of one filter and only one is ever in
  // force: a window back from now, or a single dated day.
  day: null,
  // Two floors on the same axis, kept apart because they mean different
  // things: points are the crowd's verdict on the link, comments are how much
  // it was argued about. A story can be one without the other.
  minPoints: 0,
  minComments: 10,
  includeVoted: false,
  // What you have already opened: `hide` (a story you read is one you need
  // not be shown again), `show` (everything, the opened rows marked), or
  // `only` (nothing but what you opened — the reading history, which no
  // other view lists; that third state is why this is not a boolean like
  // `includeVoted`, whose "only" is the Votes tab).
  read: 'hide',
  q: '',
};

// The URL spells each filter as a single letter — `/feed?m=top&d=30&c=50`.
// State keys stay written out; only the address bar is terse. Both score bounds
// share `s`, which is the one letter carrying two values (see `readScore`).
//
// This table exists to be checked: `tests/frontend.rs` holds it to the same key
// set as FEED_DEFAULTS and to distinct letters, because a filter with no letter
// silently stops round-tripping and two filters sharing one silently overwrite.
export const FEED_PARAM = {
  mode: 'm',
  days: 'd',
  day: 'd',
  minScore: 's',
  maxScore: 's',
  minPoints: 'p',
  minComments: 'c',
  includeVoted: 'v',
  read: 'r',
  q: 'q',
};

// A hand-typed or stale parameter must never reach the API as NaN or as a mode
// the server doesn't switch on, so every value is parsed and validated and
// anything that fails is left at its default. `undefined` is how a read
// rejects a value.
const asInt = (v, lo, hi) => {
  // A missing parameter must not read as a number: `Number(null)` and
  // `Number('')` are both 0, which is a valid `d` and a valid `c`, so without
  // this a bare /feed parsed as all-time with no traction floor — the default
  // path, quietly wrong.
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : undefined;
};
/** A stored day key, as the corpus writes them. */
const isDayKey = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * `s` is one bound or two: `s=70` is a floor set by the slider, `s=70-75` is a
 * bucket clicked out of the Brain histogram. Returns the pair, or undefined if
 * it parses as neither.
 */
export function readScore(raw) {
  const [lo, hi] = raw.split('-');
  const minScore = asInt(lo, 0, 100);
  if (minScore === undefined) return undefined;
  if (hi === undefined) return { minScore, maxScore: null };
  const maxScore = asInt(hi, 0, 100);
  // An inverted or empty bucket would return nothing for every story in it,
  // which reads as a broken page rather than as a bad link.
  if (maxScore === undefined || maxScore <= minScore) return undefined;
  return { minScore, maxScore };
}

/**
 * The GET parameters of a URL, as a full set of feed filters.
 *
 * `modes` is the list of modes the server switches on, and `reads` the three
 * states of the Read row. Both are passed in rather than read here: the chips
 * in index.html are the only place either is declared, and this file has no
 * business touching the DOM — that is what lets tests import it and call it.
 */
export function readFeedParams(search, modes, reads) {
  const params = new URLSearchParams(search);
  const filters = { ...FEED_DEFAULTS };

  // A bucket carries its own context. The histogram counts the whole unvoted
  // corpus, so a bucket out of it is all-time and has no traction floor — the
  // band chip says as much ("match 70–75% · all time"). Implying that here is
  // what keeps `?s=70-75` from having to spell out `d=0&c=0` beside it. These
  // are defaults, not overrides: an explicit `d`/`c` below still wins.
  const score = params.has('s') ? readScore(params.get('s')) : undefined;
  if (score) {
    Object.assign(filters, score);
    if (score.maxScore != null) Object.assign(filters, { days: 0, minComments: 0 });
  }

  // `d` is a window or a day: `d=30` is the last thirty days, `d=2026-08-12`
  // is that one. A dated day carries its own context the way a score bucket
  // does — the chart it comes from counts every story the corpus holds for
  // that day, so a traction floor left on would show a handful where the bar
  // showed hundreds. The window it replaces goes back to its default, so the
  // two never both mean something at once.
  const d = params.get('d');
  if (d != null && isDayKey(d)) {
    filters.day = d;
    filters.minComments = 0;
  }

  const mode = params.get('m');
  if (modes.includes(mode)) filters.mode = mode;
  const days = asInt(params.get('d'), 0, 36500);
  if (days !== undefined) filters.days = days;
  const minPoints = asInt(params.get('p'), 0, 100000);
  if (minPoints !== undefined) filters.minPoints = minPoints;
  const minComments = asInt(params.get('c'), 0, 100000);
  if (minComments !== undefined) filters.minComments = minComments;
  if (params.has('v')) filters.includeVoted = params.get('v') === '1';
  // A word, like `m`: the server switches on it, and a stale spelling falls
  // back to hiding rather than showing a reading history nobody asked for.
  const read = params.get('r');
  if (reads.includes(read)) filters.read = read;
  if (params.has('q')) filters.q = params.get('q');
  return filters;
}

/** One set of filters as GET parameters, defaults omitted. '' when all default. */
export function feedParams(f) {
  const params = new URLSearchParams();
  // The mirror of the rule above: inside a bucket, all-time and no traction
  // floor are what `s=lo-hi` already says, so writing them again would put the
  // noise back that the single letters were meant to take out.
  const band = f.maxScore != null;
  const def = {
    ...FEED_DEFAULTS,
    ...(band ? { days: 0, minComments: 0 } : {}),
    ...(f.day ? { minComments: 0 } : {}),
  };
  const put = (key, value) => {
    if (f[key] !== def[key]) params.set(FEED_PARAM[key], value);
  };

  put('mode', f.mode);
  // A dated day takes the `d` slot; the window it stands in for is not written
  // beside it, because only one of them is ever in force.
  if (f.day) params.set(FEED_PARAM.day, f.day);
  else put('days', String(f.days));
  if (band) params.set(FEED_PARAM.minScore, `${f.minScore}-${f.maxScore}`);
  else put('minScore', String(f.minScore));
  put('minPoints', String(f.minPoints));
  put('minComments', String(f.minComments));
  put('includeVoted', '1');
  put('read', f.read);
  put('q', f.q);

  const query = params.toString();
  return query ? `?${query}` : '';
}
