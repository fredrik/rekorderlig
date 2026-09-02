# The front end's module graph, and how it is tested

Why the views never import each other, why the registry exists, and why the
front-end tests boot the real module graph instead of reading it as text.

## One module per view, and the views never import each other

`app.js` is a composition root, not a file with everything in it. Views
reach each other through `registry.js`: each calls `register()` at import
with the hooks it answers to (`show`, `url`, `adopt`, `stats`), and
the router and chrome call them through `hook()`. That is the whole reason
the registry exists — the router has to start the feed loading and the
chrome has to redraw Brain when stats arrive, and a view importing the
router while the router imported it back would be a cycle. ES modules
tolerate cycles until they don't: declarations hoist, so it works right up
until a binding is read during initialisation and is still in its temporal
dead zone. `tests/modules.test.mjs` walks the real import graph and fails on
a cycle, on a view importing a view, and on a leaf growing a dependency.

Two cross-view edges used to exist and both are gone rather than moved:
Brain called into the feed to open a histogram bucket (it navigates to
`/feed?s=70-75` now, which is also what makes the back button work), and the
router called each view's loader by name. The one genuinely shared piece of
judging UI lives in `reveal.js`, which both decks import — that is a leaf,
not an edge between views.

There is still no build step: `index.html` loads `/app.js` as a module and
the browser fetches the rest — which costs nothing on a repeat visit,
because `serve_static` sends an `ETag` and answers a matching
`If-None-Match` with a 304 (see the `src/server.rs` row in CLAUDE.md).

`signed-out.html` is the one page outside that graph, and deliberately so: it
is served under a 401 to a browser with no session, so every module it could
load and every route it could call would answer 401 as well. It borrows the
stylesheet and nothing else — which is why that one file is public — and the
two halves of its copy are switched in CSS off `data-reason`, set by the
server, rather than by any code of its own.

## Tested by running it

The front end is tested by **running it**. `tests/helpers/dom.mjs` is a DOM
stub — element identity per selector, a child tree with readable text,
classes, `hidden`, firable handlers, `history` and `fetch` — which is enough
to boot the real module graph and check what it does. Its `history` moves
`location` the way a browser's does; before it did, `navigate('/brain')` in
a test mounted at `/feed` logged the entry and left the router reading
`/feed`, so a test could only ever exercise the view its file was mounted
at. One `mount()` per
file, because only the entry point can be re-imported under a fresh query
string; its dependencies resolve without one and stay cached, so a second
mount would leave handlers bound to the first mount's nodes. `mount()`
refuses it rather than let that confuse anyone, and boot scenarios live in
files of their own (`boot-token.test.mjs`, `boot-unauthorized.test.mjs`).

It is a stub, not a browser: no layout, no CSS, no selector matching, no
bubbling. Assertions needing those do not belong in it.

- `app.test.mjs` — what reaches the feed request, and which navigations push
  history rather than replace it.
- `reveal.test.mjs` — the line shown after a swipe.
- `feed-params.test.mjs`, `certainty.test.mjs`, `format.test.mjs` — the
  DOM-free modules, imported and called.
- `modules.test.mjs` — the import graph, walked: cycles, view-to-view
  imports, and the leaves staying leaves.
- `styles.test.mjs` — **the only text assertions left**, and only because a
  stylesheet has no behaviour to run: a `CERTAINTY` band needing a matching
  `.verdict.sure-<name>` colour, the deck's zero floor, title overflow. The
  band names are *imported* rather than parsed out of the source, so they
  cannot drift from the table.

## Never assert on source text

`tests/frontend.rs` is gone. It read the front end as text and asserted
about its shape, which is a check that cannot fail the way a test fails: it
passes when the code is renamed around it and passes when the behaviour is
wrong but the spelling is right. One of its helpers grabbed a destructured
parameter instead of a function body and made three assertions unfailable
without anyone noticing. When a rule can be exercised, exercise it; reach
for text only for an invariant spanning two files that nothing at runtime
notices breaking, and put it in `styles.test.mjs` with the reason.
