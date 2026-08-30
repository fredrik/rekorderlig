/*! A DOM stub, and deliberately not a browser.
 *
 * The front-end modules touch `document` at load, which is why so much of this
 * suite used to read them as text and assert about their shape. Text checks
 * cannot fail the way a real test fails: they pass when the code is renamed
 * around them and they pass when the behaviour is wrong but the spelling is
 * right. This is the smallest thing that lets the real functions run.
 *
 * What it models: element identity per selector, a child tree with readable
 * text, classes, `hidden`, event handlers you can fire, `history`, and `fetch`.
 * What it does not: layout, CSS, selector matching, bubbling, or anything about
 * how a browser paints. Assertions that would need those belong in the browser,
 * and the few that remain are text tripwires over `styles.css` for that reason.
 *
 * One mount per test file. A second would not get a second module graph:
 * only the entry point can be re-imported under a fresh query string, and its
 * dependencies resolve without one, so `feed.js` and `state.js` stay cached
 * and their handlers stay bound to the first mount's nodes. Rather than a
 * loader hook to work around that, `mount()` refuses the second call and boot
 * scenarios live in files of their own.
 */

import { readFileSync } from 'node:fs';

class El {
  constructor(tag = 'div', sel = '') {
    this.tagName = tag.toUpperCase();
    this.sel = sel;
    this.dataset = {};
    this.style = {};
    this.attrs = {};
    this.children = [];
    this.hidden = false;
    this.value = '';
    this.handlers = {};
    this._text = '';
    const set = new Set();
    this.classList = {
      add: (...c) => c.forEach((x) => set.add(x)),
      remove: (...c) => c.forEach((x) => set.delete(x)),
      contains: (c) => set.has(c),
      toggle: (c, on) => (on ?? !set.has(c)) ? set.add(c) : set.delete(c),
      has: (c) => set.has(c),
    };
  }
  get textContent() {
    if (this.children.length) {
      return this.children.map((c) => (typeof c === 'string' ? c : c.textContent)).join('');
    }
    return this._text;
  }
  set textContent(v) { this._text = String(v ?? ''); this.children = []; }
  append(...kids) { this.children.push(...kids.flat().filter((k) => k !== '' && k != null)); }
  replaceChildren(...kids) { this.children = kids.flat().filter((k) => k !== '' && k != null); }
  remove() {}
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  set ariaLabel(v) { this.attrs['aria-label'] = v; }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  removeEventListener() {}
  observe() {}
  // Enough for `e.target.closest('button')`, which is how every chip group
  // finds the button that was clicked.
  closest(sel) { return sel.includes(this.tagName.toLowerCase()) ? this : null; }
  querySelector(sel) { return globalThis.document.querySelector(sel); }
  querySelectorAll() { return []; }
  /** Fire one of this element's own handlers. */
  fire(type, event = {}) {
    for (const fn of this.handlers[type] ?? []) {
      fn({ target: this, currentTarget: this, preventDefault() {}, ...event });
    }
  }
}

let mounted = false;

/**
 * The mode chips, read out of index.html. `readFeedParams` validates `?m=`
 * against the buttons themselves — they are the only declaration of a mode —
 * so a stub without them silently rejects every mode and reads as a default.
 */
function chipsFromHtml() {
  const html = readFileSync(new URL('../../public/index.html', import.meta.url), 'utf8');
  const groups = {};
  for (const attr of ['mode', 'days', 'min-comments']) {
    const key = attr.replace(/-(\w)/g, (_, c) => c.toUpperCase());
    groups[attr] = [...html.matchAll(new RegExp(`data-${attr}="([^"]*)"`, 'g'))]
      .map((m) => ({ dataset: { [key]: m[1] } }));
  }
  return groups;
}

export async function mount({
  path = '/train',
  search = '',
  routes = {},
  statsFails = false,
} = {}) {
  if (mounted) {
    throw new Error('mount() twice in one process: see the note at the top of this file');
  }
  mounted = true;
  const chips = chipsFromHtml();
  const nodes = new Map();
  const history = [];
  const requests = [];

  const doc = {
    documentElement: new El('html'),
    activeElement: null,
    querySelector(sel) {
      if (!nodes.has(sel)) {
        const node = new El('div', sel);
        const group = { '#mode-chips': 'mode', '#range-chips': 'days', '#talk-chips': 'min-comments' }[sel];
        if (group) node.children = chips[group].map((c) => Object.assign(new El('button'), c));
        nodes.set(sel, node);
      }
      return nodes.get(sel);
    },
    querySelectorAll: () => [],
    createElement: (t) => new El(t),
    createElementNS: (_ns, t) => new El(t),
    addEventListener() {},
  };
  globalThis.document = doc;
  globalThis.window = globalThis;
  globalThis.location = {
    pathname: path, search,
    href: `https://rk.test${path}${search}`,
    origin: 'https://rk.test',
  };
  globalThis.history = {
    pushState: (_s, _t, url) => history.push({ type: 'push', url }),
    replaceState: (_s, _t, url) => history.push({ type: 'replace', url }),
  };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.IntersectionObserver = class { observe() {} };
  globalThis.addEventListener = () => {};
  // A browser tab is not kept alive by a pending timer, and neither should the
  // test runner be: the reveal's fade sits on a 5.5s timeout, which otherwise
  // holds every one of these files open long after its assertions are done.
  const timeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const handle = timeout(fn, ms, ...rest);
    handle?.unref?.();
    return handle;
  };

  const card = (id) => ({ id, title: `Story ${id}`, url: `https://x.dev/${id}`, domain: 'x.dev' });
  const DEFAULT = {
    'GET /api/stats': { votes: { up: 3, down: 2 }, stories: 12, model: null, distribution: null },
    'GET /api/feed': { items: [], total: 0, hasModel: false },
    // No round in flight, which is what the server says when nothing is dealt.
    'GET /api/round': { round: null },
    // A POST always deals: `deal_round` returns a round object even when the
    // corpus has no cards to offer. A stub answering null here sends
    // `loadRound()` into its own `deal` branch forever — which is a fact about
    // the stub, not about the app.
    'POST /api/round': { round: { seq: 1, size: 2, cards: [card(1), card(2)] }, size: 12 },
    'GET /api/explore': { items: [], bar: null },
    'GET /api/votes': { items: [], total: 0 },
  };
  globalThis.fetch = async (url, opts) => {
    const method = opts?.method ?? 'GET';
    requests.push({ url: String(url), method });
    // A stub that answers wrongly can put the app in a loop it would never
    // enter against the real server. Fail loudly rather than spin.
    if (requests.length > 200) {
      throw new Error(`runaway: 200 requests, last ${method} ${url}. Check the stubbed responses.`);
    }
    const path = String(url).split('?')[0];
    if (statsFails && path === '/api/stats') {
      return { ok: false, status: 401, json: async () => ({ error: 'Unauthorized' }) };
    }
    const body = routes[`${method} ${path}`] ?? routes[path] ?? DEFAULT[`${method} ${path}`] ?? {};
    return { ok: true, status: 200, json: async () => body };
  };

  // A fresh module graph per mount, so `state` never leaks between tests.
  const app = new URL('../../public/app.js', import.meta.url);
  let bootError = null;
  try { await import(app); } catch (e) { bootError = e; }

  return {
    bootError,
    history,
    requests,
    node: (sel) => doc.querySelector(sel),
    text: (sel) => doc.querySelector(sel).textContent,
    /** A stand-in for a chip: what `e.target.closest('button')` will return. */
    button: (dataset = {}) => Object.assign(new El('button'), { dataset }),
    fire: (sel, type, event) => doc.querySelector(sel).fire(type, event),
    urls: (match) => requests.filter((r) => r.url.includes(match)).map((r) => r.url),
    /** The modules of this mount, for reaching in at their exports. */
    load: (name) => import(new URL(`../../public/${name}`, import.meta.url)),
  };
}
