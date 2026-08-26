/* rekorderlig front end — no framework, just the DOM. */

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, kids = []) => {
  const { dataset, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(node.dataset, dataset);
  for (const k of [].concat(kids)) node.append(k);
  return node;
};

/**
 * Outline icons, inlined from Lucide (lucide.dev, ISC licence). Inlined rather
 * than pulled from npm because this project is deliberately zero-dependency
 * with no build step. Each icon is the inner markup of a 24×24 viewBox; the
 * .icon class sizes it to 1em and strokes it with currentColor, so icons
 * follow the font size and colour of whatever they sit in.
 */
const ICON_PATHS = {
  'thumbs-up': '<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
  'thumbs-down': '<path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/>',
  'arrow-down': '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  newspaper: '<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6Z"/>',
  brain: '<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
  shuffle: '<path d="M2 18h1.4c1.3 0 2.5-.6 3.3-1.7l6.1-8.6c.7-1.1 2-1.7 3.3-1.7H22"/><path d="m18 2 4 4-4 4"/><path d="M2 6h1.9c1.5 0 2.9.9 3.6 2.2"/><path d="M22 18h-5.9c-1.3 0-2.6-.7-3.3-1.8l-.5-.8"/><path d="m18 14 4 4-4 4"/>',
  'message-circle': '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  list: '<path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  // The reveal compares two verdicts rather than marking one of them correct,
  // so it uses equals / not-equals. A tick and a cross grade the vote.
  equals: '<path d="M5 9h14"/><path d="M5 15h14"/>',
  'not-equals': '<path d="M5 9h14"/><path d="M5 15h14"/><path d="M19 5 5 19"/>',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICON_PATHS[name];
  return svg;
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
  return data;
}

let statusTimer;
// How long a verdict stays before it fades. Long enough to finish reading the
// title it names and glance at the tally, without still being there when the
// next swipe lands on top of it. The fade itself is slow (see .train-status)
// so it reads as leaving rather than blinking out.
const REVEAL_HOLD_MS = 5500;
// Below this the hit rate is noise: "1 of your last 1 vote" is a percentage
// sign on a coin toss.
const MIN_TALLY_VOTES = 5;

/**
 * Status goes into the layout, never over it. The old floating toast was
 * unreadable mid-swipe and gone by the time you looked up — and it announced
 * "Learned · 64% accurate" after a skip, which trained nothing.
 *
 * `nodes` may be a string or elements. An error stays until something replaces
 * it; anything else clears itself after a few seconds.
 */
function setTrainStatus(nodes, { error = false, hold = false } = {}) {
  const t = $('#train-status');
  clearTimeout(statusTimer);
  t.classList.remove('fading');
  t.classList.toggle('err', error);
  t.replaceChildren(...(Array.isArray(nodes) ? nodes : [nodes ?? '']));
  if (!hold && !error && nodes) {
    statusTimer = setTimeout(() => t.classList.add('fading'), REVEAL_HOLD_MS);
  }
}

/** The same idea for the other views: a note line that belongs to the page. */
function setNote(sel, message, { error = false } = {}) {
  const n = $(sel);
  if (!n) return;
  n.textContent = message ?? '';
  n.classList.toggle('err', Boolean(error));
}
const setVotesNote = (m, o) => setNote('#votes-note', m, o);
/** The same list rows appear in Feed and Votes; report into whichever is open. */
const setListNote = (m, o) => setNote(state.view === 'feed' ? '#feed-note' : '#votes-note', m, o);
const setDataNote = (m, o) => setNote('#data-note', m, o);

// Never print 0% or 100%: the model is a guess, not an oracle.
const pct = (x) => `${Math.min(99, Math.max(1, Math.round(x * 100)))}%`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ago = (ts) => {
  const h = (Date.now() / 1000 - ts) / 3600;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
};
const scoreColor = (s) =>
  s == null ? 'var(--faint)' : s >= 0.5
    ? `color-mix(in srgb, var(--up) ${Math.round((s - 0.5) * 200)}%, var(--faint))`
    : `color-mix(in srgb, var(--down) ${Math.round((0.5 - s) * 200)}%, var(--faint))`;

const state = {
  view: 'train',
  stats: null,
  queue: [],
  judgedIds: new Set(),
  queueCursor: 0,
  // Reset on reload, on purpose: a session count is a sitting's worth of work,
  // not a lifetime total. The lifetime numbers live in Brain. Verdicts only —
  // see vote().
  session: { judged: 0 },
  agreement: null,
  // minComments defaults to 10: the corpus holds ~300 stories/day but the tail
  // is 1-comment noise nobody reads; "any" is one tap away for gem-hunting.
  feed: { mode: 'foryou', days: 7, minScore: 0, maxScore: null, minComments: 10, includeVoted: false, q: '', offset: 0, items: [], loading: false },
  votes: { value: 'all', offset: 0, items: [], loading: false },
};

/* ------------------------------------------------------------------ views */

const VIEWS = ['train', 'feed', 'votes', 'brain'];
const viewFromPath = () => {
  const name = location.pathname.replace(/^\//, '');
  return VIEWS.includes(name) ? name : 'train';
};

function showView(view, { push = true } = {}) {
  // Each section owns a path (/train, /feed, /brain) so a refresh or a
  // bookmark lands back on the same section; the server serves the app
  // shell for every one of them.
  // location.search rides along so a ?token=… link keeps working across tabs.
  if (push && location.pathname !== `/${view}`) history.pushState(null, '', `/${view}${location.search}`);
  state.view = view;
  for (const name of VIEWS) $(`#view-${name}`).hidden = name !== view;
  for (const tab of document.querySelectorAll('nav.tabs button')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  }
  $('#filters-toggle').hidden = view !== 'feed';
  renderTagline();
  if (view === 'feed') loadFeed({ reset: true });
  if (view === 'votes') loadVotes({ reset: true });
  if (view === 'brain') renderBrain();
  if (view === 'train' && state.queue.length === 0) loadQueue();
}

/* ---------------------------------------------------------------- trainer */

// Small decks, drawn fresh. Every refill redraws against the model as it is
// *now*: a 40-card deck meant its tail had been chosen by a model thirty
// votes out of date, back when the queue was a ranking and staleness only
// cost you ordering. Now that the deck is a sample around a moving decision
// boundary, a stale tail is the wrong sample. The size varies so the refill
// never lands on the same beat twice.
const DECK_MIN = 8;
const DECK_MAX = 16;
const deckSize = () => DECK_MIN + Math.floor(Math.random() * (DECK_MAX - DECK_MIN + 1));
// Refill with a few cards still in hand, so the fetch happens behind a card
// you are still reading rather than against an empty deck.
const REFILL_AT = 3;

async function loadQueue() {
  $('#deck').replaceChildren(el('div', { className: 'card trainer-card' }, [
    el('div', { className: 'row muted' }, [el('span', { className: 'spinner' }), ' Finding titles to judge…']),
  ]));
  try {
    const { items, cursor } = await api(`/api/queue?limit=${deckSize()}`);
    state.queueCursor = cursor ?? 0;
    state.queue = items;
    renderCard();
  } catch (err) {
    $('#deck').replaceChildren(el('div', { className: 'card trainer-card muted' }, err.message));
  }
}

/**
 * Top up the deck WITHOUT touching the card being shown. Replacing the visible
 * card mid-judgement (what loadQueue does) reads as a glitch; here the current
 * card stays and only the tail of the queue is refreshed behind it.
 */
async function refillQueue() {
  try {
    // Each refill walks the cursor on, so a sampled deck pages forward instead
    // of redrawing the same batch; anything already in hand is filtered anyway.
    const { items, cursor } = await api(`/api/queue?limit=${deckSize()}&cursor=${state.queueCursor}`);
    state.queueCursor = cursor ?? state.queueCursor + 1;
    const current = state.queue[0];
    const held = new Set(state.queue.map((s) => s.id));
    const fresh = items.filter((s) => !state.judgedIds.has(s.id) && !held.has(s.id));
    if (current) {
      state.queue = [current, ...fresh];
      renderTagline();
    } else {
      state.queue = fresh;
      renderCard();
    }
  } catch {
    /* a failed refill just means the deck runs down to empty; loadQueue can recover */
  }
}

function renderCard() {
  const deck = $('#deck');
  const story = state.queue[0];
  if (!story) {
    deck.replaceChildren(el('div', { className: 'card trainer-card' }, [
      el('div', { className: 'trainer-title' }, 'Nothing left to judge'),
      el('div', { className: 'muted' }, 'Fetch more stories from the Brain tab, or widen the date range.'),
    ]));
    renderTagline();
    return;
  }

  // No model score on the card: showing a prediction before the vote anchors
  // the judgement and contaminates the labels. The queue still prioritises
  // uncertain stories server-side; it just doesn't say so.
  const card = el('div', { className: 'card trainer-card' }, [
    el('a', {
      className: 'trainer-title',
      href: story.url ?? `https://news.ycombinator.com/item?id=${story.id}`,
      target: '_blank', rel: 'noreferrer',
    }, story.title),
    el('div', { className: 'trainer-meta' }, [
      el('span', { className: 'domain' }, story.domain ?? 'news.ycombinator.com'),
      el('span', {}, plural(story.points, 'point')),
      el('span', {}, plural(story.num_comments, 'comment')),
      el('span', {}, ago(story.created_at)),
    ]),
  ]);

  deck.replaceChildren(card);
  renderTagline();
}

async function vote(value) {
  const story = state.queue[0];
  if (!story) return;

  const card = $('#deck .trainer-card');
  if (card) card.classList.add(value > 0 ? 'leaving-up' : value < 0 ? 'leaving-down' : 'leaving-skip');

  state.queue.shift();
  state.judgedIds.add(story.id);
  // A skip is not a judgement: it is not a training example, it triggers no
  // retrain, and it gives the model nothing. Counting it would inflate the one
  // number on screen that reports what you actually did.
  if (value !== 0) state.session.judged++;

  setTimeout(renderCard, 130);
  // Not tied to the retrain any more: a run of skips triggers no training, and
  // the deck would drain to "Nothing left to judge" with a corpus full of
  // unjudged stories.
  if (state.queue.length <= REFILL_AT) refillQueue();

  try {
    const res = await api('/api/vote', { method: 'POST', body: { id: story.id, value } });
    if (res.agreement) state.agreement = res.agreement;
    const need = needMore(res.votes);
    if (need) setTrainStatus(need, { hold: true });
    else showReveal(res.prediction, value, story);
    await refreshStats();
    // A skip teaches the model nothing — it is not in the training set — so it
    // must not trigger a retrain. It used to, which is why "Learned · 64%
    // accurate" appeared after a skip: a full rescore of the corpus, a new
    // model revision identical to the last, and a claim that something was
    // learned from a story you declined to judge.
    if (value !== 0) scheduleTrain();
  } catch (err) {
    setTrainStatus(err.message, { error: true });
  }
}

/**
 * What the model had guessed, revealed only now that the vote is cast. The
 * prediction was frozen server-side before the vote existed, so this is an
 * honest out-of-sample call, not the memorised score.
 *
 * The glyph is an equals sign, struck through when the two differ: this line
 * compares two verdicts, it does not mark one of them correct. A tick and a
 * cross would grade the vote against the guess.
 *
 * Both parties are named on every line, and the two halves stay symmetric:
 * what the model guessed, then what you said — never "you agreed", which casts
 * the model as the reference and your vote as the thing falling in line. Your
 * vote is the truth here; the guess is only ever a guess. ("Got that one
 * wrong" had the same problem in reverse: it never said whose mistake it was.)
 */
function showReveal(prediction, value, story) {
  const title = story
    ? el('a', {
        className: 'judged-title',
        href: story.url ?? `https://news.ycombinator.com/item?id=${story.id}`,
        target: '_blank', rel: 'noreferrer',
        title: story.title,
      }, story.title)
    : null;

  // Named as the model's hit rate, with its own subject: the tally lost track
  // of who was doing the matching. Held back until there are enough votes for
  // a rate to mean anything — one out of one is noise with a percentage sign.
  // Skips are excluded; a skip has no verdict for a guess to be right about.
  const tally = state.agreement?.total >= MIN_TALLY_VOTES
    ? el('span', { className: 'tally' },
        `Brain guessed ${state.agreement.agreed} of your last ${plural(state.agreement.total, 'vote')} correctly.`)
    : null;

  const line = (...nodes) => el('div', { className: 'judged-line' }, nodes.filter(Boolean));

  if (!prediction) {
    // A skip, or a story the model had never scored. Say what actually
    // happened rather than inventing a result.
    const said = value === 0
      ? el('span', {}, 'You skipped it — nothing to learn from a skip.')
      : el('span', {}, 'Brain had no guess on file for that one.');
    setTrainStatus([line(said, tally), ...(title ? [title] : [])]);
    return;
  }

  const guessedYes = prediction.score >= 0.5;
  // How sure it was of the call it actually made. Beside "guessed no", the
  // probability of yes reads as the opposite of what it means.
  const strength = pct(guessedYes ? prediction.score : 1 - prediction.score);

  setTrainStatus([
    line(
      el('span', { className: `verdict ${prediction.agreed ? 'hit' : 'miss'}` }, [
        icon(prediction.agreed ? 'equals' : 'not-equals'),
        `Brain guessed ${guessedYes ? 'yes' : 'no'} (${strength} certain)`,
      ]),
      el('span', {}, `— you said ${value > 0 ? 'yes' : 'no'}.`),
      tally,
    ),
    ...(title ? [title] : []),
  ]);
}

/** Human message when one class is still short of the minimum, else null. */
function needMore(votes) {
  const min = state.stats?.minVotesToTrain ? Math.ceil(state.stats.minVotesToTrain / 2) : 3;
  const up = Math.max(0, min - votes.up);
  const down = Math.max(0, min - votes.down);
  if (!up && !down) return null;
  const part = (n, word) => `${n} more ${word} vote${n === 1 ? '' : 's'}`;
  return `Need ${up ? part(up, 'yes') : ''}${up && down ? ' and ' : ''}${down ? part(down, 'no') : ''}`;
}

/* --------------------------------------------------------------- training */

// Voting only records. A burst of votes is debounced into one retrain
// trigger; the server runs it in a worker thread and answers at once, so we
// poll for the outcome and refresh once the new model has landed.
let trainTimer;
function scheduleTrain(delay = 1200) {
  clearTimeout(trainTimer);
  trainTimer = setTimeout(() => {
    triggerTrain().catch((err) => setTrainStatus(err.message, { error: true }));
  }, delay);
}

let trainWatch = null;
async function triggerTrain() {
  await api('/api/train', { method: 'POST' });
  if (trainWatch) return trainWatch;   // a poller is already waiting on this run (and any queued one)
  trainWatch = (async () => {
    try {
      let status;
      for (let i = 0; i < 300; i++) {
        await new Promise((r) => setTimeout(r, 400));
        status = await api('/api/train');
        if (!status.running && !status.pending) break;
      }
      return status;
    } finally {
      trainWatch = null;
    }
  })();
  const status = await trainWatch;
  if (!status || status.running) return status;
  if (status.lastError) { setTrainStatus(`Training failed: ${status.lastError}`, { error: true }); return status; }
  // Held from before the refresh so the retrain can be reported as a change
  // rather than as a number with nothing to compare it to.
  const before = state.stats?.model;
  await refreshStats();
  if (status.last?.trained) {
    reportRetrain(before, state.stats?.model);
    // A fresh model reorders what is worth asking about next — but top up
    // behind the visible card, never replacing it (that reads as a glitch).
    if (state.view === 'train' && state.queue.length <= REFILL_AT) refillQueue();
  }
  return status;
}

/**
 * The answer to "did that make it smarter?" — the accuracy delta across the
 * retrain your votes just triggered, and how much vocabulary it gained.
 *
 * This is news about the model, not about the swipe, so it goes to the header
 * line rather than the deck: putting it where the verdict appears would have
 * it overwrite what you just judged, and it belongs with the other numbers
 * describing the model's state anyway. A flat delta is reported as flat — the
 * honest answer to a burst of votes is often "no change", and a number that
 * always moves stops meaning anything.
 */
function reportRetrain(before, after) {
  if (!after?.metrics) return;
  const now = after.metrics.accuracy;
  const was = before?.metrics?.accuracy;
  const newWords = before?.features != null ? after.features - before.features : null;

  const parts = was == null || pct(was) === pct(now)
    ? [el('span', {}, `retrained · ${pct(now)} accurate`)]
    : [el('span', { className: `delta ${now > was ? 'up' : 'down'}` }, `${pct(was)} → ${pct(now)}`), el('span', {}, ' accurate')];
  if (newWords > 0) parts.push(el('span', {}, ` · +${plural(newWords, 'signal')}`));

  flashTagline(parts);
}

// A transient line in the header, which then falls back to whatever the view
// normally shows. Nothing else in the app writes over the tagline, so the
// fallback is just a re-render.
let taglineTimer;
function flashTagline(nodes) {
  clearTimeout(taglineTimer);
  $('#tagline').replaceChildren(...nodes);
  taglineTimer = setTimeout(renderTagline, 6000);
}

/* ------------------------------------------------------------------- feed */

// Each load gets a ticket; a response whose ticket is stale (the user changed
// a filter while it was in flight) is dropped instead of appended.
let feedRequest = 0;

async function loadFeed({ reset = false } = {}) {
  const f = state.feed;
  const ticket = ++feedRequest;
  if (reset) { f.offset = 0; f.items = []; }
  f.loading = true;
  const params = new URLSearchParams({
    mode: f.mode, days: f.days, minScore: f.minScore / 100, minComments: f.minComments,
    limit: 50, offset: f.offset, includeVoted: f.includeVoted ? '1' : '0',
  });
  if (f.q) params.set('q', f.q);
  if (f.maxScore != null) params.set('maxScore', f.maxScore);

  const list = $('#feed-list');
  if (reset) list.replaceChildren(el('li', { className: 'muted', style: 'padding:16px' }, 'Loading…'));

  try {
    const data = await api(`/api/feed?${params}`);
    if (ticket !== feedRequest) return;
    if (reset) list.replaceChildren();
    f.items.push(...data.items);
    for (const story of data.items) list.append(renderStory(story));

    $('#feed-empty').hidden = f.items.length > 0;
    $('#feed-empty').replaceChildren(...(data.hasModel
      ? ['Nothing matches those filters. Lower the minimum match or widen the range.']
      : ['The feed only shows stories the model has scored.', el('br'), 'Vote on a few titles in Train and it fills up.']));
    // Unhiding the sentinel is what arms the observer for the next page; once
    // the corpus is exhausted it stays hidden and the paging stops on its own.
    f.loading = false;
    $('#feed-sentinel').hidden = f.items.length >= data.total;
  } catch (err) {
    if (ticket !== feedRequest) return;
    f.loading = false;
    $('#feed-sentinel').hidden = true;
    list.replaceChildren(el('li', { className: 'muted', style: 'padding:16px' }, err.message));
  }
}

function renderStory(story) {
  const score = story.score;
  const li = el('li', { className: 'story', dataset: { id: story.id } });
  if (score != null && score >= 0.75) li.classList.add('hot');
  if (score != null && score < 0.3) li.classList.add('cold');
  if (story.vote > 0) li.classList.add('voted-up');
  if (story.vote < 0) li.classList.add('voted-down');

  const badge = el('div', { className: 'score-badge' }, [
    el('span', { style: `color:${scoreColor(score)}` }, score == null ? '—' : pct(score)),
    el('div', { className: 'bar' }, [
      el('i', { style: `width:${score == null ? 0 : Math.round(score * 100)}%;background:${scoreColor(score)}` }),
    ]),
    el('small', {}, story.confidence >= 0.5 ? 'match' : story.confidence > 0 ? 'guess' : 'new'),
  ]);

  const title = el('a', {
    className: 'story-title',
    href: story.url ?? `https://news.ycombinator.com/item?id=${story.id}`,
    target: '_blank', rel: 'noreferrer',
  }, [story.title, ' ', el('span', { className: 'dom' }, story.domain ? `(${story.domain})` : '')]);

  const whyBtn = el('button', { type: 'button' }, 'Why');
  whyBtn.addEventListener('click', () => toggleWhy(li, story.id, whyBtn));

  const mini = el('div', { className: 'mini-votes' }, [
    voteButton(story, -1, 'thumbs-down'),
    voteButton(story, 1, 'thumbs-up'),
  ]);

  const sub = el('div', { className: 'story-sub' }, [
    el('span', {}, plural(story.num_comments, 'comment')),
    el('span', {}, plural(story.points, 'point')),
    el('span', {}, ago(story.created_at)),
    el('a', { href: `https://news.ycombinator.com/item?id=${story.id}`, target: '_blank', rel: 'noreferrer' }, 'Thread'),
    whyBtn,
    mini,
  ]);

  li.append(badge, el('div', { className: 'story-main' }, [title, sub]));
  return li;
}

function voteButton(story, value, iconName) {
  const btn = el('button', { type: 'button', title: value > 0 ? 'More like this' : 'Less like this' }, icon(iconName));
  const paint = () => {
    btn.classList.toggle('on-up', story.vote === 1 && value === 1);
    btn.classList.toggle('on-down', story.vote === -1 && value === -1);
  };
  paint();
  btn.addEventListener('click', async () => {
    const next = story.vote === value ? 0 : value;
    story.vote = next;
    paint();
    const li = btn.closest('li.story');
    li.classList.toggle('voted-up', next === 1);
    li.classList.toggle('voted-down', next === -1);
    try {
      if (next === 0) await api('/api/unvote', { method: 'POST', body: { id: story.id } });
      else await api('/api/vote', { method: 'POST', body: { id: story.id, value: next } });
      await refreshStats();
      // Nothing to report on success: the filled thumb and the row tint
      // already say the vote landed.
      setListNote('');
      scheduleTrain();
    } catch (err) {
      setListNote(err.message, { error: true });
    }
  });
  return btn;
}

async function toggleWhy(li, id, btn) {
  const existing = li.querySelector('.why');
  if (existing) { existing.remove(); btn.textContent = 'Why'; return; }
  btn.textContent = 'Hide';
  const box = el('div', { className: 'why muted' }, 'Thinking…');
  li.querySelector('.story-main').append(box);
  try {
    const data = await api(`/api/explain?id=${id}`);
    if (!data.contributions.length) {
      box.replaceChildren('No learned signal in this title yet — vote on a few like it.');
      return;
    }
    box.replaceChildren(...data.contributions.slice(0, 8).map((c) =>
      el('span', { className: `term ${c.effect > 0 ? 'pos' : 'neg'}` },
        `${c.effect > 0 ? '+' : '−'} ${c.label}`)));
  } catch (err) {
    box.replaceChildren(err.message);
  }
}

/* ------------------------------------------------------------------ votes */

const VOTE_KINDS = {
  1: { name: 'yes', label: 'Yes', icon: 'thumbs-up' },
  0: { name: 'skip', label: 'Skip', icon: 'arrow-down' },
  '-1': { name: 'no', label: 'No', icon: 'thumbs-down' },
};

// Same stale-response guard as the feed: a filter changed mid-flight wins.
let votesRequest = 0;

async function loadVotes({ reset = false } = {}) {
  const v = state.votes;
  const ticket = ++votesRequest;
  if (reset) { v.offset = 0; v.items = []; }
  v.loading = true;
  const params = new URLSearchParams({ value: v.value, limit: 50, offset: v.offset });

  const list = $('#votes-list');
  if (reset) list.replaceChildren(el('li', { className: 'muted', style: 'padding:16px' }, 'Loading…'));

  try {
    const data = await api(`/api/votes?${params}`);
    if (ticket !== votesRequest) return;
    if (reset) list.replaceChildren();
    v.items.push(...data.items);
    for (const story of data.items) list.append(renderVoteRow(story));

    $('#votes-empty').hidden = v.items.length > 0;
    $('#votes-empty').textContent = v.value === 'all'
      ? 'No votes yet — judge a few titles in Train.'
      : 'No votes with that verdict yet.';
    // Unhiding the sentinel is what arms the observer for the next page; once
    // the list is complete it stays hidden and the paging stops on its own.
    v.loading = false;
    $('#votes-sentinel').hidden = v.items.length >= data.total;
    renderTagline();
  } catch (err) {
    if (ticket !== votesRequest) return;
    v.loading = false;
    $('#votes-sentinel').hidden = true;
    list.replaceChildren(el('li', { className: 'muted', style: 'padding:16px' }, err.message));
  }
}

async function setVerdict(story, value, repaint) {
  const previous = story.vote;
  story.vote = value;
  repaint();
  try {
    if (value === null) await api('/api/unvote', { method: 'POST', body: { id: story.id } });
    else await api('/api/vote', { method: 'POST', body: { id: story.id, value } });
    await refreshStats();
    setVotesNote('');
    // The row repaints itself — that is the confirmation. What matters here is
    // whether the training set actually changed: a verdict on either side of
    // the change means it did, and only then is a retrain worth a corpus
    // rescore. Skip-to-skip is a no-op.
    if ((previous ?? 0) !== 0 || (value ?? 0) !== 0) scheduleTrain();
  } catch (err) {
    story.vote = previous;
    repaint();
    setVotesNote(err.message, { error: true });
  }
}

// Every story in the Votes list is a training example, and the trained model
// separates its own training set perfectly — every yes scores ~0.99, every no
// ~0.00 — so the stored `score` here only ever restates the badge beside it.
// What can disagree is the *held-out* prediction: what the model said about
// this title while trained on a fold that excluded this vote. That number is
// the one worth showing, and only when it contradicts the verdict.
//
// The margin keeps near-neutral predictions quiet: at 0.5 the model has no
// opinion to disagree with, and flagging that would put the noise back.
const CONFLICT_MARGIN = 0.15;

/** The verdict the held-out model would have cast, or 0 for "no opinion". */
function modelVerdict(score) {
  if (score == null) return 0;
  if (score > 0.5 + CONFLICT_MARGIN) return 1;
  if (score < 0.5 - CONFLICT_MARGIN) return -1;
  return 0;
}

// Repainted, not rebuilt, because the mini buttons can flip the verdict under
// it: changing yes→no on a row the model read as yes must light the flag up
// without a reload. Hidden rather than removed so the flex gap goes with it.
// (The held-out score itself is stale until the next train — it is a statement
// about the model, not about the vote you just cast.)
function paintConflict(node, story) {
  const says = modelVerdict(story.oof_score);
  const clash = says !== 0 && (story.vote === 1 || story.vote === -1) && says !== story.vote;
  node.hidden = !clash;
  node.textContent = clash ? `Model says ${says === 1 ? 'yes' : 'no'} · ${pct(story.oof_score)}` : '';
}

function renderVoteRow(story) {
  const li = el('li', { className: 'story', dataset: { id: story.id } });

  // The verdict badge takes the score badge's place: on this list what the
  // eye should land on is how you judged the story, not what the model thinks.
  const badge = el('div', { className: 'vote-badge' });
  const paintBadge = () => {
    const kind = VOTE_KINDS[String(story.vote ?? '')];
    badge.className = `vote-badge ${kind?.name ?? 'none'}`;
    badge.replaceChildren(
      kind ? icon(kind.icon) : el('span', { className: 'glyph' }, '·'),
      el('small', {}, kind?.label ?? 'None'),
    );
    li.classList.toggle('voted-up', story.vote === 1);
    li.classList.toggle('voted-down', story.vote === -1);
    li.classList.toggle('voted-skip', story.vote === 0);
  };
  paintBadge();

  const title = el('a', {
    className: 'story-title',
    href: story.url ?? `https://news.ycombinator.com/item?id=${story.id}`,
    target: '_blank', rel: 'noreferrer',
  }, [story.title, ' ', el('span', { className: 'dom' }, story.domain ? `(${story.domain})` : '')]);

  // Verdict buttons here set a value outright (no toggle-off, unlike the
  // feed's) — removing a vote has its own ✕, so a mis-tap on a list of
  // hundreds of rows can't silently unlabel a story.
  const mini = el('div', { className: 'mini-votes' });
  const buttons = [
    [-1, 'thumbs-down', 'Change to no'],
    [0, 'arrow-down', 'Change to skip'],
    [1, 'thumbs-up', 'Change to yes'],
    [null, 'x', 'Remove this vote'],
  ].map(([value, iconName, hint]) => {
    const btn = el('button', { type: 'button', title: hint }, icon(iconName));
    btn.addEventListener('click', () => setVerdict(story, value, repaint));
    return { value, btn };
  });
  mini.append(...buttons.map((b) => b.btn));

  const flag = el('span', {
    className: 'conflict',
    title: 'Trained without this vote, the model read the title the other way — your other votes argue against this one',
  });

  function repaint() {
    paintBadge();
    paintConflict(flag, story);
    for (const { value, btn } of buttons) {
      btn.classList.toggle('on-up', value === 1 && story.vote === 1);
      btn.classList.toggle('on-down', value === -1 && story.vote === -1);
      btn.classList.toggle('on-skip', value === 0 && story.vote === 0);
      btn.hidden = value === null && story.vote == null;
    }
  }
  repaint();

  const sub = el('div', { className: 'story-sub' }, [
    el('span', {}, `Voted ${ago(story.voted_at)}`),
    el('span', {}, plural(story.num_comments, 'comment')),
    flag,
    el('a', { href: `https://news.ycombinator.com/item?id=${story.id}`, target: '_blank', rel: 'noreferrer' }, 'Thread'),
    mini,
  ]);

  li.append(badge, el('div', { className: 'story-main' }, [title, sub]));
  return li;
}

/* ------------------------------------------------------------------ brain */

function metric(value, label) {
  return el('div', { className: 'metric' }, [el('b', {}, value), el('span', {}, label)]);
}

function renderBrain() {
  const s = state.stats;
  if (!s) return;
  const m = s.model;

  $('#brain-metrics').replaceChildren(
    metric(String(s.votes.up), 'yes votes'),
    metric(String(s.votes.down), 'no votes'),
    metric(m?.metrics?.accuracy != null ? pct(m.metrics.accuracy) : '—', 'accuracy'),
    metric(m?.metrics?.auc != null ? m.metrics.auc.toFixed(2) : '—', 'ranking (AUC)'),
    metric(String(s.stories), 'stories'),
    metric(m ? String(m.features) : '—', 'signals learned'),
  );

  const note = [];
  if (!m) {
    note.push(`Vote on at least ${s.minVotesToTrain} titles (both yes and no) and the model starts working.`);
  } else {
    const baseline = m.metrics?.baseline;
    note.push(`Accuracy is measured by ${m.metrics?.folds ?? 5}-fold cross-validation on your ${m.nVotes} votes` +
      (baseline != null ? `, against ${pct(baseline)} for always guessing your majority verdict.` : '.'));
    if (m.metrics?.auc != null) {
      note.push(m.metrics.auc > 0.8
        ? ' It ranks unseen titles well.'
        : m.metrics.auc > 0.65 ? ' It has a real signal but wants more votes.' : ' Still mostly guessing. Keep voting.');
    }
  }
  $('#brain-note').textContent = note.join('');

  const chips = (rows, cls) => rows?.length
    ? rows.map((r) => el('span', { className: `term-chip ${cls}` }, [
        r.label, el('em', {}, r.weight.toFixed(2)), el('small', {}, r.kind),
      ]))
    : [el('span', { className: 'muted', style: 'font-size:13px' }, 'not enough votes yet')];

  renderDistribution(m?.distribution);
  loadDaysChart();
  loadCurve();

  $('#brain-likes').replaceChildren(...chips(m?.insights?.likes, 'pos'));
  $('#brain-dislikes').replaceChildren(...chips(m?.insights?.dislikes, 'neg'));

  $('#data-note').textContent = s.lastSyncAt
    ? `${s.stories} stories across ${s.days} days · last fetched ${ago(s.lastSyncAt)}`
    : 'No stories fetched yet.';
}

// Both Brain histograms are hand-rolled inline SVG — same helper, same styles.
const svgEl = (tag, attrs = {}, kids = []) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const k of kids) node.append(k);
  return node;
};

// Histogram of the unvoted corpus by stored score. Voted stories are left
// out: they are the training set and sit pinned at the extremes, which says
// nothing about how the model treats new titles.
function renderDistribution(d) {
  const panel = $('#brain-dist-panel');
  if (!d || !d.total) { panel.hidden = true; return; }
  panel.hidden = false;

  const n = d.bins.length;
  const W = 600, H = 140, PAD = { l: 4, r: 4, t: 8, b: 22 };
  const plotW = W - PAD.l - PAD.r;
  const barsH = H - PAD.t - PAD.b;
  const step = plotW / n;
  const gap = 2;
  const max = Math.max(1, ...d.bins);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Distribution of story scores' });
  const baseline = PAD.t + barsH;

  // Faint line at 0.5: the model's "no opinion" point that shrinkage pulls toward.
  svg.append(svgEl('line', { class: 'mid', x1: PAD.l + plotW / 2, x2: PAD.l + plotW / 2, y1: PAD.t, y2: baseline }));

  d.bins.forEach((count, i) => {
    const x = PAD.l + i * step;
    const lo = (i / n).toFixed(2), hi = ((i + 1) / n).toFixed(2);
    // Square-root scale so the ~0.5 hump doesn't flatten the tails into nothing.
    const h = Math.sqrt(count / max) * barsH;
    const bar = svgEl('rect', {
      class: `bar${i / n >= 0.7 ? ' hot' : ''}`,
      x: x + gap / 2, y: baseline - h, width: step - gap, height: h, rx: 2,
    });
    bar.append(svgEl('title', {}, [`${lo}–${hi}: ${count} stories (${(100 * count / d.total).toFixed(1)}%) · click to browse`]));
    bar.addEventListener('click', () => showScoreBand(i / n, (i + 1) / n));
    svg.append(bar);
  });

  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const anchor = t === 0 ? 'start' : t === 1 ? 'end' : 'middle';
    svg.append(svgEl('text', { class: 'axis', x: PAD.l + t * plotW, y: H - 4, 'text-anchor': anchor }, [t === 0.5 ? '0.5 · unsure' : t.toFixed(2)]));
  }
  $('#brain-dist').replaceChildren(svg);

  const share = (lo, hi) => d.bins.reduce((acc, c, i) => (i / n >= lo && i / n < hi ? acc + c : acc), 0);
  const fmt = (k) => `${k} (${(100 * k / d.total).toFixed(1)}%)`;
  $('#brain-dist-note').replaceChildren(
    `Of ${d.total} unvoted stories, ${fmt(share(0.7, 1.01))} score 0.70 or higher (orange). That is your slice of HN.`,
    el('br'),
    `${fmt(share(0.4, 0.6))} sit between 0.40 and 0.60 where the model has little to say, ` +
    `and ${fmt(share(0, 0.4))} score below 0.40 and are effectively ignored. ` +
    `Bar heights use a square-root scale so the tails stay visible. Click a bar to browse those stories.`,
  );
}

// The tagline is view-specific: Train gets the full picture, Feed only the
// model quality (vote count lives in Train where voting happens), Votes the
// verdict tally, Brain nothing — its panels already show every number.
function renderTagline() {
  const s = state.stats;
  const t = $('#tagline');
  clearTimeout(taglineTimer);
  if (!s || state.view === 'brain') { t.replaceChildren(); return; }
  if (state.view === 'votes') {
    t.textContent = `${s.votes.up} yes · ${s.votes.down} no · ${s.votes.skip} skipped`;
    return;
  }
  const accuracy = s.model?.metrics?.accuracy != null ? `${pct(s.model.metrics.accuracy)} accurate` : 'learning';
  if (state.view !== 'train') { t.textContent = accuracy; return; }
  // Queue depth was the old headline and it measured nothing you did — "31
  // queued" only ever went up. Session count is the work you just put in; the
  // agreement rate is what came back for it.
  // "judged" is already the past participle — plural() turned it into
  // "2 judgeds". Counted things take the plural; this counts judgements made.
  const done = state.session.judged
    ? `${state.session.judged} judged`
    : plural(s.votes.up + s.votes.down, 'vote');
  const a = state.agreement ?? s.agreement;
  // Same word as the reveal's "guessed N of your last M correctly" — one idea
  // should not go by two names on two lines of the same screen.
  const agree = a?.total >= MIN_TALLY_VOTES ? `brain correct ${a.agreed}/${a.total}` : accuracy;
  t.textContent = `${done} · ${agree}`;
}

/* ------------------------------------------------------- learning curve */

// "Does the brain get smarter?" answered with the only honest evidence there
// is: cross-validated accuracy at each retrain, against the baseline a coin
// weighted to your yes/no split would score. Below the baseline means the
// model is worse than guessing your majority verdict every time.
async function loadCurve() {
  try {
    const { points, revs } = await api('/api/history');
    if (points.length < 2) { $('#curve-panel').hidden = true; return; }
    renderCurve(points, revs);
    $('#curve-panel').hidden = false;
  } catch {
    // Same as the other panels: a failed fetch leaves this one as it was.
  }
}

function renderCurve(points, revs) {
  const readout = $('#curve-readout');
  const W = 600, H = 140, PAD = { l: 4, r: 4, t: 10, b: 22 };
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;

  // Fixed 0..1 scale. Auto-scaling would turn noise between 68% and 71% into a
  // dramatic climb, which is exactly the lie this panel exists to avoid.
  const x = (i) => PAD.l + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v) => PAD.t + (1 - v) * plotH;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'accuracy at each retrain' });
  const line = (vals, cls) => svgEl('path', {
    class: cls, fill: 'none',
    d: vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' '),
  });

  svg.append(
    svgEl('line', { class: 'curve-grid', x1: PAD.l, x2: PAD.l + plotW, y1: y(0.5), y2: y(0.5) }),
    line(points.map((p) => p.baseline ?? 0.5), 'curve-baseline'),
    line(points.map((p) => p.accuracy), 'curve-line'),
  );

  const last = points.at(-1);
  const show = (p) => readout.replaceChildren(
    el('b', {}, pct(p.accuracy)), ` accurate at ${plural(p.votes, 'vote')}`,
    el('span', { className: 'muted' }, ` · baseline ${pct(p.baseline ?? 0.5)}`),
  );
  points.forEach((p, i) => {
    const dot = svgEl('circle', { class: 'curve-dot', cx: x(i), cy: y(p.accuracy), r: i === points.length - 1 ? 3.5 : 2 });
    dot.append(svgEl('title', {}, [`${plural(p.votes, 'vote')} · ${pct(p.accuracy)}`]));
    dot.addEventListener('pointerenter', () => show(p));
    svg.append(dot);
  });
  svg.append(
    svgEl('text', { class: 'axis', x: PAD.l, y: H - 4, 'text-anchor': 'start' }, [plural(points[0].votes, 'vote')]),
    svgEl('text', { class: 'axis', x: PAD.l + plotW, y: H - 4, 'text-anchor': 'end' }, [plural(last.votes, 'vote')]),
  );
  $('#curve-chart').replaceChildren(svg);
  show(last);

  const first = points[0];
  const delta = last.accuracy - first.accuracy;
  const gain = last.accuracy - (last.baseline ?? 0.5);
  $('#curve-summary').textContent =
    `${plural(revs, 'retrain')} · ${Math.abs(delta) < 0.005 ? 'flat since' : delta > 0 ? `up ${Math.round(delta * 100)} points since` : `down ${Math.round(-delta * 100)} points since`} `
    + `${plural(first.votes, 'vote')} · ${gain > 0 ? `${Math.round(gain * 100)} points better than guessing` : 'not yet better than guessing'}`;
}

/* ------------------------------------------------- stories-per-day chart */

const nStories = (n) => `${n} ${n === 1 ? 'story' : 'stories'}`;
const fmtDay = (day) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

// The days chart lives beside the score histogram in Brain and is drawn the
// same way: grey bars, no toggle. Its own endpoint (`/api/days`), so it is
// fetched when Brain opens rather than riding along on `/api/stats`.
async function loadDaysChart() {
  try {
    const { days, older } = await api('/api/days');
    renderDaysChart(days, older);
    $('#days-panel').hidden = false;
  } catch {
    // A failed fetch just leaves the panel as it was; the rest of Brain stands.
  }
}

function renderDaysChart(days, older) {
  const readout = $('#days-readout');
  const summary = $('#days-summary');

  if (!days.length) {
    $('#days-chart').replaceChildren();
    readout.textContent = '';
    summary.textContent = 'No stories fetched yet.';
    return;
  }

  const counts = days.map((d) => d.count);
  const max = Math.max(...counts);
  const sorted = [...counts].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  // Scale heights to the 95th percentile, not the max: one huge archive-fill day
  // would otherwise squash every normal day into an unreadable stub.
  const cap = Math.max(1, sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95))]);
  // "Low" = under half the median: enough of a dip to matter for training data.
  const isLow = (n) => n < Math.max(1, median / 2);
  const lowDays = days.filter((d) => isLow(d.count));

  const show = (d) => readout.replaceChildren(
    el('b', {}, nStories(d.count)), ` on ${fmtDay(d.day)}`,
    isLow(d.count) ? el('span', { className: 'day-low-tag' }, d.count === 0 ? ' · missing' : ' · low') : '',
  );

  // Same geometry as the score histogram so the two panels read as a pair.
  const n = days.length;
  const W = 600, H = 140, PAD = { l: 4, r: 4, t: 8, b: 22 };
  const plotW = W - PAD.l - PAD.r;
  const barsH = H - PAD.t - PAD.b;
  const step = plotW / n;
  const gap = 2;
  const baseline = PAD.t + barsH;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'stories fetched per day' });
  days.forEach((d, i) => {
    const h = Math.min(1, d.count / cap) * barsH;
    const bar = svgEl('rect', {
      class: `bar${isLow(d.count) ? ' low' : ''}`,
      x: PAD.l + i * step + gap / 2, y: baseline - h,
      width: step - gap, height: Math.max(isLow(d.count) ? 2 : 0, h), rx: 2,
    });
    bar.append(svgEl('title', {}, [`${d.day} · ${nStories(d.count)}`]));
    bar.addEventListener('pointerenter', () => show(d));
    svg.append(bar);
  });
  svg.append(
    svgEl('text', { class: 'axis', x: PAD.l, y: H - 4, 'text-anchor': 'start' }, [fmtDay(days[0].day)]),
    svgEl('text', { class: 'axis', x: PAD.l + plotW, y: H - 4, 'text-anchor': 'end' }, [fmtDay(days.at(-1).day)]),
  );
  $('#days-chart').replaceChildren(svg);
  show(days.at(-1));

  summary.textContent = `${days.length} days · median ${median}/day · max ${max} · ` + (lowDays.length
    ? `${lowDays.length} day${lowDays.length === 1 ? '' : 's'} under half the median: `
      + lowDays.slice(0, 6).map((d) => fmtDay(d.day)).join(', ') + (lowDays.length > 6 ? '…' : '')
    : 'every day has a healthy share of stories')
    + (older ? ` · plus ${nStories(older.stories)} scattered over ${older.days} older days, not shown` : '');
}

async function refreshStats() {
  state.stats = await api('/api/stats');
  renderTagline();
  if (state.view === 'brain') renderBrain();
}

/* ------------------------------------------------------------------- theme */

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

/* ------------------------------------------------------------------ wiring */

// Static icon slots in the HTML; app.js is the single source for icon markup.
for (const slot of document.querySelectorAll('[data-icon]')) {
  slot.replaceChildren(icon(slot.dataset.icon));
}

for (const tab of document.querySelectorAll('nav.tabs button')) {
  tab.addEventListener('click', () => showView(tab.dataset.view));
}
for (const btn of document.querySelectorAll('.judge button')) {
  btn.addEventListener('click', () => vote(Number(btn.dataset.vote)));
}

// Arrows only, one binding per action, mirroring the glyphs on the buttons.
document.addEventListener('keydown', (e) => {
  if (state.view !== 'train' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select')) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); vote(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); vote(-1); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); vote(0); }
});

// The cog lives in the header so the filter panel costs no vertical space
// when closed. Filters start hidden on every page load (the `hidden`
// attribute in the HTML is the only source of truth — deliberately not
// persisted).
$('#filters-toggle').addEventListener('click', (e) => {
  const panel = $('#feed-filters');
  const opening = panel.hidden;
  panel.hidden = !opening;
  e.currentTarget.classList.toggle('active', opening);
  e.currentTarget.setAttribute('aria-expanded', String(opening));
});

// A score band set by clicking a histogram bar in Brain. It rides on top of
// the normal filters (minScore + an exclusive maxScore) and is shown as one
// chip above the list; touching any other filter, or the chip, clears it.
function renderScoreBand() {
  const f = state.feed;
  $('#score-band').hidden = f.maxScore == null;
  if (f.maxScore != null) {
    $('#score-band-clear').textContent = `match ${f.minScore}–${Math.round(f.maxScore * 100)}% · all time · ✕`;
  }
}

function clearScoreBand() {
  if (state.feed.maxScore == null) return;
  state.feed.maxScore = null;
  state.feed.minScore = 0;
  $('#min-score').value = 0;
  $('#min-score-out').textContent = 'off';
  renderScoreBand();
}

function showScoreBand(lo, hi) {
  const f = state.feed;
  Object.assign(f, { mode: 'foryou', days: 0, minComments: 0, includeVoted: false, q: '', minScore: Math.round(lo * 100), maxScore: hi });
  // Mirror the state into the filter panel so it doesn't lie when opened.
  for (const b of $('#mode-chips').children) b.classList.toggle('active', b.dataset.mode === 'foryou');
  for (const b of $('#range-chips').querySelectorAll('[data-days]')) b.classList.toggle('active', b.dataset.days === '0');
  $('#voted-toggle').classList.remove('active');
  for (const b of $('#talk-chips').children) b.classList.toggle('active', b.dataset.minComments === '0');
  $('#min-score').value = Math.min(90, f.minScore);
  $('#min-score-out').textContent = f.minScore === 0 ? 'off' : `${f.minScore}%`;
  $('#search').value = '';
  renderScoreBand();
  showView('feed');
}

$('#score-band-clear').addEventListener('click', () => { clearScoreBand(); loadFeed({ reset: true }); });

$('#mode-chips').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  clearScoreBand();
  state.feed.mode = btn.dataset.mode;
  for (const b of $('#mode-chips').children) b.classList.toggle('active', b === btn);
  loadFeed({ reset: true });
});

$('#range-chips').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  clearScoreBand();
  if (btn.id === 'voted-toggle') {
    state.feed.includeVoted = !state.feed.includeVoted;
    btn.classList.toggle('active', state.feed.includeVoted);
  } else {
    state.feed.days = Number(btn.dataset.days);
    for (const b of $('#range-chips').querySelectorAll('[data-days]')) b.classList.toggle('active', b === btn);
  }
  loadFeed({ reset: true });
});

$('#min-score').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  state.feed.maxScore = null; renderScoreBand();
  state.feed.minScore = v;
  $('#min-score-out').textContent = v === 0 ? 'off' : `${v}%`;
});
$('#min-score').addEventListener('change', () => loadFeed({ reset: true }));

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearScoreBand();
  state.feed.q = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadFeed({ reset: true }), 250);
});

$('#talk-chips').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  clearScoreBand();
  state.feed.minComments = Number(btn.dataset.minComments);
  for (const b of $('#talk-chips').children) b.classList.toggle('active', b === btn);
  loadFeed({ reset: true });
});

// The Feed pages itself: the sentinel below the list scrolling into view (with
// a screen of margin, so the next page lands before the user hits the bottom)
// asks for the next 50. A filter change resets the offset, so a page in flight
// when that happens is dropped by the stale-ticket guard, not appended.
new IntersectionObserver((entries) => {
  if (!entries.some((e) => e.isIntersecting)) return;
  if (state.view !== 'feed' || state.feed.loading) return;
  state.feed.offset += 50;
  loadFeed();
}, { rootMargin: '400px' }).observe($('#feed-sentinel'));

$('#vote-chips').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.votes.value = btn.dataset.value;
  for (const b of $('#vote-chips').children) b.classList.toggle('active', b === btn);
  loadVotes({ reset: true });
});

// The Votes list pages itself: the sentinel below the list scrolling into
// view (with a screen of margin, so the next page lands before the user hits
// the bottom) asks for the next 50.
new IntersectionObserver((entries) => {
  if (!entries.some((e) => e.isIntersecting)) return;
  if (state.view !== 'votes' || state.votes.loading) return;
  state.votes.offset += 50;
  loadVotes();
}, { rootMargin: '400px' }).observe($('#votes-sentinel'));

// Fetching runs in a worker thread server-side and answers 202 at once, so
// the button polls for progress the same way the retrain trigger does.
$('#btn-sync').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  const label = btn.textContent;
  try {
    const started = await api('/api/sync', { method: 'POST', body: { days: 2 } });
    if (started.status === 'busy') setDataNote('Already fetching…');
    let status = started;
    for (let i = 0; i < 900 && status.running; i++) {
      btn.textContent = status.progress ? `fetching ${status.progress.day}…` : 'fetching…';
      await new Promise((r) => setTimeout(r, 500));
      status = await api('/api/sync');
    }
    if (status.lastError) setDataNote(`Fetch failed: ${status.lastError}`, { error: true });
    else if (status.last) {
      const r = status.last;
      setDataNote(`${r.inserted} new stories (${r.fetched} seen, ${r.scored} scored)`);
    }
    await refreshStats();
    if (state.view === 'train') loadQueue();
  } catch (err) {
    setDataNote(err.message, { error: true });
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

$('#btn-train').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    clearTimeout(trainTimer);
    setDataNote('Training…');
    const status = await triggerTrain();
    if (status?.last && !status.last.trained) setDataNote('Need more votes on both sides');
    else setDataNote(`Retrained · ${state.stats?.model?.metrics?.accuracy != null ? pct(state.stats.model.metrics.accuracy) + ' accurate' : 'done'}`);
  } catch (err) {
    setDataNote(err.message, { error: true });
  } finally {
    e.target.disabled = false;
  }
});

$('#btn-export').addEventListener('click', async () => {
  try {
    const data = await api('/api/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = el('a', { href: url, download: `rekorderlig-votes-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    setDataNote(err.message, { error: true });
  }
});


window.addEventListener('popstate', () => showView(viewFromPath(), { push: false }));

/* -------------------------------------------------------------------- boot */

await refreshStats();
// Normalize the address bar (e.g. bare /) to the section path without
// adding a history entry.
history.replaceState(null, '', `/${viewFromPath()}${location.search}`);
showView(viewFromPath(), { push: false });
