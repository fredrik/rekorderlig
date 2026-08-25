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
  'chart-column': '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  list: '<path d="M3 5h.01"/><path d="M3 12h.01"/><path d="M3 19h.01"/><path d="M8 5h13"/><path d="M8 12h13"/><path d="M8 19h13"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
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

let toastTimer;
function toast(message) {
  const t = $('#toast');
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

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
  voteLog: [],   // newest first: { story, value } — feeds the recent-votes rail
  // minComments defaults to 10: the corpus holds ~300 stories/day but the tail
  // is 1-comment noise nobody reads; "any" is one tap away for gem-hunting.
  feed: { mode: 'foryou', days: 7, minScore: 0, maxScore: null, minComments: 10, includeVoted: false, q: '', offset: 0, items: [] },
  votes: { value: 'all', q: '', offset: 0, items: [] },
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
  $('#log-link').hidden = view !== 'train';
  renderTagline();
  if (view === 'feed') loadFeed({ reset: true });
  if (view === 'votes') loadVotes({ reset: true });
  if (view === 'brain') renderBrain();
  if (view === 'train' && state.queue.length === 0) loadQueue();
}

/* ---------------------------------------------------------------- trainer */

async function loadQueue() {
  $('#deck').replaceChildren(el('div', { className: 'card trainer-card' }, [
    el('div', { className: 'row muted' }, [el('span', { className: 'spinner' }), ' Finding titles to judge…']),
  ]));
  try {
    const { items } = await api('/api/queue?limit=40');
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
    const { items } = await api('/api/queue?limit=40');
    const current = state.queue[0];
    const fresh = items.filter((s) => !state.judgedIds.has(s.id) && (!current || s.id !== current.id));
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
  state.voteLog.unshift({ story, value });
  renderVoteLog();

  setTimeout(renderCard, 130);

  try {
    const res = await api('/api/vote', { method: 'POST', body: { id: story.id, value } });
    const need = needMore(res.votes);
    if (need) toast(need);
    await refreshStats();
    scheduleTrain();
  } catch (err) {
    toast(err.message);
  }
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

/* --------------------------------------------------------------- vote log */

const VOTE_KINDS = {
  1: { name: 'yes', label: 'Yes', icon: 'thumbs-up' },
  0: { name: 'skip', label: 'Skip', icon: 'arrow-down' },
  '-1': { name: 'no', label: 'No', icon: 'thumbs-down' },
};

// Only the newest 20 entries render, so the log stays a glance surface
// rather than growing into a second feed.
const LOG_VISIBLE = 20;

function renderVoteLog() {
  const entries = state.voteLog.slice(0, LOG_VISIBLE);
  $('#log-count').textContent = String(state.voteLog.length);
  $('#log-empty').hidden = entries.length > 0;
  $('#log-list').replaceChildren(...entries.map((entry) => {
    const kind = VOTE_KINDS[entry.value];
    const undoBtn = el('button', { type: 'button', className: 'log-undo' }, 'Undo');
    undoBtn.addEventListener('click', () => undoVote(entry));
    return el('li', {}, [
      el('span', { className: `log-vote ${kind.name}` }, [icon(kind.icon), kind.label]),
      undoBtn,
      el('span', { className: 'log-title', title: entry.story.title }, entry.story.title),
      el('span', { className: 'log-domain' }, entry.story.domain ?? 'news.ycombinator.com'),
    ]);
  }));
}

/**
 * Undo any logged vote, not just the newest. Semantics: the vote row is
 * deleted server-side (votes are independent rows keyed by story, so removing
 * vote #3 never disturbs votes #4–#6) and the story is reinserted at the
 * FRONT of the queue — it becomes the card on screen for an immediate
 * re-vote, and the card the user was on becomes next in line. The log entry
 * is removed; every other entry keeps its place.
 */
async function undoVote(entry) {
  const at = state.voteLog.indexOf(entry);
  if (at === -1) return; // already undone (double-click)
  state.voteLog.splice(at, 1);
  state.judgedIds.delete(entry.story.id);
  // A queue refill may have re-added the story in the meantime; keep it unique.
  state.queue = [entry.story, ...state.queue.filter((s) => s.id !== entry.story.id)];
  renderVoteLog();
  renderCard();
  try {
    await api('/api/unvote', { method: 'POST', body: { id: entry.story.id } });
    await refreshStats();
    toast('Vote removed');
    scheduleTrain();
  } catch (err) {
    toast(err.message);
  }
}

/* --------------------------------------------------------------- training */

// Voting only records. A burst of votes is debounced into one retrain
// trigger; the server runs it in a worker thread and answers at once, so we
// poll for the outcome and refresh once the new model has landed.
let trainTimer;
function scheduleTrain(delay = 1200) {
  clearTimeout(trainTimer);
  trainTimer = setTimeout(() => { triggerTrain().catch((err) => toast(err.message)); }, delay);
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
  if (status.lastError) { toast(`Training failed: ${status.lastError}`); return status; }
  await refreshStats();
  if (status.last?.trained) {
    const acc = state.stats?.model?.metrics?.accuracy;
    toast(acc ? `Learned · ${pct(acc)} accurate` : 'Model updated');
    // A fresh model reorders what is worth asking about next — but top up
    // behind the visible card, never replacing it (that reads as a glitch).
    if (state.view === 'train' && state.queue.length < 8) refillQueue();
  }
  return status;
}

/* ------------------------------------------------------------------- feed */

// Each load gets a ticket; a response whose ticket is stale (the user changed
// a filter while it was in flight) is dropped instead of appended.
let feedRequest = 0;

async function loadFeed({ reset = false } = {}) {
  const f = state.feed;
  const ticket = ++feedRequest;
  if (reset) { f.offset = 0; f.items = []; }
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
    $('#feed-empty').textContent = data.hasModel
      ? 'Nothing matches those filters. Lower the minimum match or widen the range.'
      : 'No stories yet — fetch some from the Brain tab.';
    $('#load-more').hidden = f.items.length >= data.total;
  } catch (err) {
    if (ticket !== feedRequest) return;
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
      toast(next === 1 ? 'More like this' : next === -1 ? 'Less like this' : 'Vote removed');
      scheduleTrain();
    } catch (err) {
      toast(err.message);
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

// Same stale-response guard as the feed: a filter changed mid-flight wins.
let votesRequest = 0;

async function loadVotes({ reset = false } = {}) {
  const v = state.votes;
  const ticket = ++votesRequest;
  if (reset) { v.offset = 0; v.items = []; }
  const params = new URLSearchParams({ value: v.value, limit: 50, offset: v.offset });
  if (v.q) params.set('q', v.q);

  const list = $('#votes-list');
  if (reset) list.replaceChildren(el('li', { className: 'muted', style: 'padding:16px' }, 'Loading…'));

  try {
    const data = await api(`/api/votes?${params}`);
    if (ticket !== votesRequest) return;
    if (reset) list.replaceChildren();
    v.items.push(...data.items);
    for (const story of data.items) list.append(renderVoteRow(story));

    $('#votes-empty').hidden = v.items.length > 0;
    $('#votes-empty').textContent = v.q || v.value !== 'all'
      ? 'No votes match that filter.'
      : 'No votes yet — judge a few titles in Train.';
    $('#votes-more').hidden = v.items.length >= data.total;
    renderTagline();
  } catch (err) {
    if (ticket !== votesRequest) return;
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
    toast(value === null ? 'Vote removed' : `Marked ${VOTE_KINDS[String(value)].label.toLowerCase()}`);
    scheduleTrain();
  } catch (err) {
    story.vote = previous;
    repaint();
    toast(err.message);
  }
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

  function repaint() {
    paintBadge();
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
    el('span', {}, story.score == null ? 'Unscored' : `${pct(story.score)} match`),
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

  $('#brain-likes').replaceChildren(...chips(m?.insights?.likes, 'pos'));
  $('#brain-dislikes').replaceChildren(...chips(m?.insights?.dislikes, 'neg'));

  $('#data-note').textContent = s.lastIngestAt
    ? `${s.stories} stories across ${s.days} days · last fetched ${ago(s.lastIngestAt)}`
    : 'No stories fetched yet.';
}

// The tagline is view-specific: Train gets the full picture, Feed only the
// Histogram of the unvoted corpus by stored score. Voted stories are left
// out: they are the training set and sit pinned at the extremes, which says
// nothing about how the model treats new titles. Inline SVG, no dependencies.
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
  const svgEl = (tag, attrs = {}, kids = []) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    for (const k of kids) node.append(k);
    return node;
  };

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

// model quality (vote count lives in Train where voting happens), Votes the
// verdict tally, Brain nothing — its panels already show every number.
function renderTagline() {
  const s = state.stats;
  const t = $('#tagline');
  if (!s || state.view === 'brain') { t.textContent = ''; return; }
  if (state.view === 'votes') {
    t.textContent = `${s.votes.up} yes · ${s.votes.down} no · ${s.votes.skip} skipped`;
    return;
  }
  const accuracy = s.model?.metrics?.accuracy != null ? `${pct(s.model.metrics.accuracy)} accurate` : 'learning';
  t.textContent = state.view === 'train'
    ? `${plural(s.votes.up + s.votes.down, 'vote')} · ${accuracy} · ${state.queue.length} queued`
    : accuracy;
}

/* ------------------------------------------------- stories-per-day chart */

const nStories = (n) => `${n} ${n === 1 ? 'story' : 'stories'}`;
const fmtDay = (day) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

async function toggleDaysPanel(btn) {
  const panel = $('#days-panel');
  if (!panel.hidden) {
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    return;
  }
  btn.disabled = true;
  try {
    const { days, older } = await api('/api/days');
    renderDaysChart(days, older);
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

function renderDaysChart(days, older) {
  const bars = $('#days-bars');
  const axis = $('#days-axis');
  const readout = $('#days-readout');
  const summary = $('#days-summary');

  if (!days.length) {
    bars.replaceChildren();
    axis.replaceChildren();
    readout.textContent = '';
    summary.textContent = 'No stories fetched yet.';
    return;
  }

  const counts = days.map((d) => d.count);
  const max = Math.max(...counts);
  const sorted = [...counts].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  // Scale heights to the 95th percentile, not the max: one huge backfill day
  // would otherwise squash every normal day into an unreadable stub.
  const cap = Math.max(1, sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95))]);
  // "Low" = under half the median: enough of a dip to matter for training data.
  const isLow = (n) => n < Math.max(1, median / 2);
  const lowDays = days.filter((d) => isLow(d.count));

  const show = (d) => readout.replaceChildren(
    el('b', {}, nStories(d.count)), ` on ${fmtDay(d.day)}`,
    isLow(d.count) ? el('span', { className: 'day-low-tag' }, d.count === 0 ? ' · missing' : ' · low') : '',
  );

  bars.replaceChildren(...days.map((d) => {
    const col = el('div', {
      className: `day-col${isLow(d.count) ? ' low' : ''}`,
      title: `${d.day} · ${nStories(d.count)}`,
    }, [el('i', { style: `height:${Math.min(100, Math.round((d.count / cap) * 100))}%` })]);
    col.addEventListener('pointerenter', () => show(d));
    return col;
  }));

  axis.replaceChildren(el('span', {}, fmtDay(days[0].day)), el('span', {}, fmtDay(days.at(-1).day)));
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

// The header link swaps the card out for the vote log and back.
$('#log-link').addEventListener('click', (e) => {
  const open = $('#view-train').classList.toggle('log-open');
  e.currentTarget.setAttribute('aria-expanded', String(open));
});

// Arrows only, one binding per action, mirroring the glyphs on the buttons.
document.addEventListener('keydown', (e) => {
  if (state.view !== 'train' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select')) return;
  // While the log stands in for the card, voting blind would be a misclick.
  if ($('#view-train').classList.contains('log-open')) return;
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

$('#load-more').addEventListener('click', () => {
  state.feed.offset += 50;
  loadFeed();
});

$('#vote-chips').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.votes.value = btn.dataset.value;
  for (const b of $('#vote-chips').children) b.classList.toggle('active', b === btn);
  loadVotes({ reset: true });
});

let votesSearchTimer;
$('#votes-search').addEventListener('input', (e) => {
  state.votes.q = e.target.value.trim();
  clearTimeout(votesSearchTimer);
  votesSearchTimer = setTimeout(() => loadVotes({ reset: true }), 250);
});

$('#votes-more').addEventListener('click', () => {
  state.votes.offset += 50;
  loadVotes();
});

$('#btn-ingest').addEventListener('click', async (e) => {
  e.target.disabled = true;
  const label = e.target.textContent;
  e.target.textContent = 'Fetching…';
  try {
    const r = await api('/api/ingest', { method: 'POST', body: { days: 7 } });
    toast(`${r.inserted} new stories (${r.fetched} seen)`);
    await refreshStats();
    if (state.view === 'train') loadQueue();
  } catch (err) {
    toast(err.message);
  } finally {
    e.target.disabled = false;
    e.target.textContent = label;
  }
});

$('#btn-train').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    clearTimeout(trainTimer);
    toast('Training…');
    const status = await triggerTrain();
    if (status?.last && !status.last.trained) toast('Need more votes on both sides');
  } catch (err) {
    toast(err.message);
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
    toast(err.message);
  }
});

$('#btn-days').addEventListener('click', (e) => toggleDaysPanel(e.currentTarget));

$('#btn-import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const r = await api('/api/import', { method: 'POST', body: JSON.parse(await file.text()) });
    toast(`Imported ${r.applied} votes`);
    await refreshStats();
    if (r.training) triggerTrain().catch((err) => toast(err.message));
  } catch (err) {
    toast(err.message);
  }
  e.target.value = '';
});

window.addEventListener('popstate', () => showView(viewFromPath(), { push: false }));

/* -------------------------------------------------------------------- boot */

await refreshStats();
// Normalize the address bar (e.g. bare /) to the section path without
// adding a history entry.
history.replaceState(null, '', `/${viewFromPath()}${location.search}`);
showView(viewFromPath(), { push: false });
