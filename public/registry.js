/* How the router reaches a view without importing it.

   Every view calls `register()` at import; `app.js` imports the views, so by
   the time anything runs they are all in. The router, and the chrome around
   it, then reach the open view through `hook()` alone.

   This exists to keep the module graph acyclic. The router has to start the
   feed loading and the chrome has to redraw Brain when the stats change, but
   a view that imported the router while the router imported it back would be
   a cycle — and cycles here would be the kind that work by accident, because
   function declarations hoist, right up until one of them doesn't.

   The hooks a view may register:

     show   the view has been opened — fill it
     url    where this view lives, when it is more than its path (the feed
            carries its filters as GET parameters)
     adopt  take the filters out of a URL, for a link, a bookmark, or the back
            button landing on this view
     stats  fresh /api/stats arrived while this view is open
*/

const views = new Map();

export function register(name, hooks) {
  views.set(name, hooks);
}

/** One hook of one view, or undefined. Every call site treats it as optional. */
export const hook = (view, name) => views.get(view)?.[name];
