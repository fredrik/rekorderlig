# The feed's URL contract

Why the feed's filters live in the GET parameters and the rules that keep the
panel, the URL and the list telling one story. The code is
`public/feed-params.js` (the parser), `public/feed.js` (`setFeed()`,
`paintFilters()`) and `FeedOptions` in `src/service.rs`.

## Filters live in the GET parameters

A filtered feed is a place: bookmarkable, linkable from the phone to the
laptop, and reachable with the back button. `state.feed` is the parsed form
of `?mode=&days=&minScore=…` and is never the source — `setFeed()` folds a
patch in, writes the URL, repaints the panel from it and reloads, so the
chips and the list cannot disagree.

## Rules that keep it honest

- **The panel is one labelled row per filter, and one active member per row.**
  The label column is the point: five unlabelled rows of identical pills read
  as one wall, and the top row is not even a filter — it is the sort order,
  and nothing but a label could say so. Every row is now the same shape, so
  `paintFilters()` lights them with one function over the row's `data-*` and
  `chipGroup()` binds them all the same way. Two consequences worth keeping:
  a value no chip carries lights none of them (which is how a dated day
  leaves the window row dark), and the `Voted` row is two chips rather than
  one toggle, because it is a filter with two states and read as a button
  that does something while it was a lone pill in the window row. The
  `Read` row has three — `Hide` / `Show` / `Only` — because nothing else
  lists what you have opened: Voted's "only" is the Votes tab, Read's has to
  be a chip (`docs/design/reads.md`).
- **Points and comments are two floors, not one traction idea.** Points are
  the crowd's verdict on the link, comments are how much it was argued about,
  and a story is regularly one without the other — a linkbait post with 90
  comments and 2 points, a quiet paper with 120 points and none. `p` and `c`
  are independent, intersect when both are set, and neither implies the
  other.

## How the URL is spelled

- **One letter each, and only non-defaults are written**: `?m=top&d=30&c=50&v=1&r=show&q=rust`,
  and the common case is a bare `/feed`. Two of the letters carry a word
  rather than a number — `m` and `r` — because the server switches on them,
  and the chips in `index.html` are the one place either is declared: the
  parser is handed both lists rather than keeping a copy, and a word no chip
  carries falls back to the default (`hide`, for `r`) rather than showing a
  list nobody asked for. State keys stay spelled out — only
  the address bar is terse. `FEED_DEFAULTS` is the single declaration of what
  a filter is and `FEED_PARAM` maps each to its letter; a value that fails to
  parse falls back rather than reaching the API as `NaN` or as a mode the
  server doesn't switch on. A hand-edited link normalizes on arrival, since
  boot writes `urlFor()`'s canonical form back. `tests/feed-params.test.mjs`
  holds the two tables to the same key set and the letters distinct — an
  unlettered filter never round-trips, and two sharing a letter give you a
  bookmark that applies the wrong one — while `tests/app.test.mjs` boots the
  app and checks each one reaches the actual request.
- **Two letters carry two shapes each**, and in both cases the shapes are one
  idea that is never in force twice over. `s=70` is the slider's floor,
  `s=70-75` a bucket out of the Brain histogram. `d=30` is a window back from
  now, `d=2026-08-12` one dated day out of the stories-per-day chart —
  writing either retires the other, so state never holds two answers about
  time, and `FeedOptions::day` **replaces** the window server-side rather
  than intersecting with it (a clicked day is usually outside the 7-day
  default, so anding them would always give nothing and the bar would look
  broken rather than empty). A third claimant on either letter would have no
  shape left to be told apart by, which is what `tests/feed-params.test.mjs`
  holds them to. The date picker in the window row is the second shape made
  reachable without a chart: it sits *in* that row rather than beside it,
  because there is only ever one answer about time and two controls in two
  places would look like two filters to intersect.
  A **link** carrying either shape implies its own context — all time, no
  traction floor — because the histogram counts the whole unvoted corpus and
  a 7-day window would show nine stories where the bar promised twelve
  hundred. That is what keeps `?s=70-75` from spelling out `d=0&c=0` beside
  it; an explicit `d`/`c` in the link still wins. The implication belongs to
  the link and not to the control: a day named in the **panel** leaves the
  floors standing, because you are looking straight at them and a bar
  promised you nothing. An inverted or unparseable range is rejected whole
  rather than half-applied.
- **Both score bounds are integer percentages**, in state and in the URL,
  divided by 100 once in `loadFeed()` for the API. That is the slider's unit
  (`step=5`), the band chip's and the histogram's — 20 equal bins over [0,1],
  so every edge is a whole 5% and nothing is lost. Two representations of one
  number is what this replaced.
- **The panel's controls replace, the histogram drill-down pushes.** Dragging
  the slider or typing a search must leave one history entry, not dozens;
  arriving at a score bucket from Brain is a real navigation and back should
  reach the chart. `setFeed()` defaults to `replaceState` and pushes only when
  asked.
- **A band restores only what identifies it.** Touching any other filter
  leaves a band — a context clicked out of a Brain chart — but what comes
  back is the day, or the two score bounds, and not the whole view the band
  opened. Leaving a day used to also snap the comment floor back to 10, which
  silently threw away a floor set by hand in the panel; the two exits now
  follow one rule.

`paintFilters()` is the one paint path. Reaching into a widget from anywhere
else forks the panel from the URL — which is exactly what `showScoreBand()`
used to do, mirroring six controls by hand so the closed panel wouldn't lie
when it was next opened.
