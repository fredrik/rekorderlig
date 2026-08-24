/* rekorderlig front end — no framework, just the DOM. */

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, kids = []) => {
  const { dataset, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(node.dataset, dataset);
  for (const k of [].concat(kids)) node.append(k);
  return node;
};

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
  judged: 0,
  judgedIds: new Set(),
  lastVote: null,
  // minComments defaults to 10: the corpus holds ~300 stories/day but the tail
  // is 1-comment noise nobody reads; "any" is one tap away for gem-hunting.
  feed: { mode: 'foryou', days: 7, minScore: 0, minComments: 10, includeVoted: false, q: '', offset: 0, items: [] },
};

/* ------------------------------------------------------------------ views */

function showView(view) {
  state.view = view;
  for (const name of ['train', 'feed', 'brain']) $(`#view-${name}`).hidden = name !== view;
  for (const tab of document.querySelectorAll('nav.tabs button')) {
    tab.setAttribute('aria-selected', String(tab.dataset.view === view));
  }
  if (view === 'feed') loadFeed({ reset: true });
  if (view === 'brain') renderBrain();
  if (view === 'train' && state.queue.length === 0) loadQueue();
}

/* ---------------------------------------------------------------- trainer */

async function loadQueue() {
  $('#deck').replaceChildren(el('div', { className: 'card trainer-card' }, [
    el('div', { className: 'row muted' }, [el('span', { className: 'spinner' }), ' finding titles to judge…']),
  ]));
  try {
    const { items } = await api('/api/queue?limit=40');
    state.queue = items;
    renderCard();
  } catch (err) {
    $('#deck').replaceChildren(el('div', { className: 'card trainer-card muted' }, err.message));
  }
}

function renderTrainMeta() {
  const done = state.judged;
  $('#train-progress').style.width = `${Math.min(100, (done / Math.max(20, done + state.queue.length)) * 100)}%`;
  $('#train-hint').textContent = state.queue.length > 1
    ? `${state.queue.length} queued · swipe or use arrow keys`
    : 'last one in the queue';
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
      state.queue = [current, ...fresh.filter((s) => s.id !== current.id)];
      renderTrainMeta();
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
    $('#train-progress').style.width = '100%';
    return;
  }

  const meta = el('div', { className: 'trainer-meta' }, [
    el('span', { className: 'domain' }, story.domain ?? 'news.ycombinator.com'),
    el('span', {}, plural(story.points, 'point')),
    el('span', {}, plural(story.num_comments, 'comment')),
    el('span', {}, ago(story.created_at)),
  ]);

  const guess = story.score != null && state.stats?.model
    ? el('div', { className: 'guess' }, [
        'hunch: ', el('b', {}, `${pct(story.score)} match`),
        story.reason === 'uncertain' ? ' — it is unsure, your vote counts double here' : '',
      ])
    : el('div', { className: 'guess muted' }, 'no model yet — the first votes teach it everything');

  const card = el('div', { className: 'card trainer-card' }, [
    el('div', { className: 'trainer-title' }, story.title),
    meta,
    guess,
    el('a', {
      className: 'hint', href: story.url ?? `https://news.ycombinator.com/item?id=${story.id}`,
      target: '_blank', rel: 'noreferrer',
    }, 'open the story ↗'),
  ]);

  attachSwipe(card);
  deck.replaceChildren(card);
  renderTrainMeta();
}

function attachSwipe(card) {
  let startX = 0;
  let startY = 0;
  let dragging = false;

  card.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    dragging = true;
  }, { passive: true });

  card.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (Math.abs(dx) < Math.abs(dy)) return;
    card.style.transform = `translateX(${dx}px) rotate(${dx / 26}deg)`;
    card.style.borderColor = dx > 40 ? 'var(--up)' : dx < -40 ? 'var(--down)' : 'var(--line)';
  }, { passive: true });

  card.addEventListener('touchend', (e) => {
    if (!dragging) return;
    dragging = false;
    const dx = e.changedTouches[0].clientX - startX;
    card.style.transform = '';
    card.style.borderColor = '';
    if (Math.abs(dx) > 70) vote(dx > 0 ? 1 : -1);
  });
}

async function vote(value) {
  const story = state.queue[0];
  if (!story) return;

  const card = $('#deck .trainer-card');
  if (card) card.classList.add(value > 0 ? 'leaving-up' : value < 0 ? 'leaving-down' : 'leaving-skip');

  state.queue.shift();
  state.judged++;
  state.judgedIds.add(story.id);
  state.lastVote = story;
  $('#undo-btn').hidden = false;

  setTimeout(renderCard, 130);

  try {
    const res = await api('/api/vote', { method: 'POST', body: { id: story.id, value } });
    if (res.training?.trained) {
      await refreshStats();
      const acc = state.stats?.model?.metrics?.accuracy;
      toast(acc ? `learned · ${pct(acc)} accurate` : 'model updated');
      // A fresh model reorders what is worth asking about next — but top up
      // behind the visible card, never replacing it (that reads as a glitch).
      if (state.queue.length < 8) refillQueue();
    } else if (res.training?.reason === 'need_more_votes') {
      const need = res.training.need;
      toast(need.up || need.down
        ? `need ${need.up ? `${need.up} more 👍` : ''}${need.up && need.down ? ' and ' : ''}${need.down ? `${need.down} more 👎` : ''}`
        : 'saved');
      await refreshStats();
    } else {
      await refreshStats();
    }
  } catch (err) {
    toast(err.message);
  }
}

async function undo() {
  const story = state.lastVote;
  if (!story) return;
  state.lastVote = null;
  $('#undo-btn').hidden = true;
  state.judgedIds.delete(story.id);
  state.queue.unshift(story);
  state.judged = Math.max(0, state.judged - 1);
  renderCard();
  try {
    await api('/api/unvote', { method: 'POST', body: { id: story.id } });
    await refreshStats();
    toast('vote removed');
  } catch (err) {
    toast(err.message);
  }
}

/* ------------------------------------------------------------------- feed */

async function loadFeed({ reset = false } = {}) {
  const f = state.feed;
  if (reset) { f.offset = 0; f.items = []; }
  const params = new URLSearchParams({
    mode: f.mode, days: f.days, minScore: f.minScore / 100, minComments: f.minComments,
    limit: 50, offset: f.offset, includeVoted: f.includeVoted ? '1' : '0',
  });
  if (f.q) params.set('q', f.q);

  const list = $('#feed-list');
  if (reset) list.replaceChildren(el('li', { className: 'muted', style: 'padding:16px' }, 'loading…'));

  try {
    const data = await api(`/api/feed?${params}`);
    if (reset) list.replaceChildren();
    f.items.push(...data.items);
    for (const story of data.items) list.append(renderStory(story));

    $('#feed-empty').hidden = f.items.length > 0;
    $('#feed-empty').textContent = data.hasModel
      ? 'Nothing matches those filters. Lower the minimum match or widen the range.'
      : 'No stories yet — fetch some from the Brain tab.';
    $('#load-more').hidden = f.items.length >= data.total;
  } catch (err) {
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

  const whyBtn = el('button', { type: 'button' }, 'why?');
  whyBtn.addEventListener('click', () => toggleWhy(li, story.id, whyBtn));

  const mini = el('div', { className: 'mini-votes' }, [
    voteButton(story, -1, '👎'),
    voteButton(story, 1, '👍'),
  ]);

  const sub = el('div', { className: 'story-sub' }, [
    el('span', {}, plural(story.num_comments, 'comment')),
    el('span', {}, plural(story.points, 'point')),
    el('span', {}, ago(story.created_at)),
    el('a', { href: `https://news.ycombinator.com/item?id=${story.id}`, target: '_blank', rel: 'noreferrer' }, 'thread'),
    whyBtn,
    mini,
  ]);

  li.append(badge, el('div', { className: 'story-main' }, [title, sub]));
  return li;
}

function voteButton(story, value, glyph) {
  const btn = el('button', { type: 'button', title: value > 0 ? 'more like this' : 'less like this' }, glyph);
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
      toast(next === 1 ? 'more like this' : next === -1 ? 'less like this' : 'vote removed');
    } catch (err) {
      toast(err.message);
    }
  });
  return btn;
}

async function toggleWhy(li, id, btn) {
  const existing = li.querySelector('.why');
  if (existing) { existing.remove(); btn.textContent = 'why?'; return; }
  btn.textContent = 'hide';
  const box = el('div', { className: 'why muted' }, 'thinking…');
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

/* ------------------------------------------------------------------ brain */

function metric(value, label) {
  return el('div', { className: 'metric' }, [el('b', {}, value), el('span', {}, label)]);
}

function renderBrain() {
  const s = state.stats;
  if (!s) return;
  const m = s.model;

  $('#brain-metrics').replaceChildren(
    metric(String(s.votes.up), 'thumbs up'),
    metric(String(s.votes.down), 'thumbs down'),
    metric(m?.metrics?.accuracy != null ? pct(m.metrics.accuracy) : '—', 'accuracy'),
    metric(m?.metrics?.auc != null ? m.metrics.auc.toFixed(2) : '—', 'ranking (AUC)'),
    metric(String(s.stories), 'stories'),
    metric(m ? String(m.features) : '—', 'signals learned'),
  );

  const note = [];
  if (!m) {
    note.push(`Vote on at least ${s.minVotesToTrain} titles (both 👍 and 👎) and the model starts working.`);
  } else {
    const baseline = m.metrics?.baseline;
    note.push(`Accuracy is measured by ${m.metrics?.folds ?? 5}-fold cross-validation on your ${m.nVotes} votes` +
      (baseline != null ? `, against ${pct(baseline)} for always guessing your majority verdict.` : '.'));
    if (m.metrics?.auc != null) {
      note.push(m.metrics.auc > 0.8
        ? ' It ranks unseen titles well.'
        : m.metrics.auc > 0.65 ? ' It has a real signal but wants more votes.' : ' Still mostly guessing — keep voting.');
    }
  }
  $('#brain-note').textContent = note.join('');

  const chips = (rows, cls) => rows?.length
    ? rows.map((r) => el('span', { className: `term-chip ${cls}` }, [
        r.label, el('em', {}, r.weight.toFixed(2)), el('small', {}, r.kind),
      ]))
    : [el('span', { className: 'muted', style: 'font-size:13px' }, 'not enough votes yet')];

  $('#brain-likes').replaceChildren(...chips(m?.insights?.likes, 'pos'));
  $('#brain-dislikes').replaceChildren(...chips(m?.insights?.dislikes, 'neg'));

  $('#data-note').textContent = s.lastIngestAt
    ? `${s.stories} stories across ${s.days} days · last fetched ${ago(s.lastIngestAt)}`
    : 'No stories fetched yet.';
}

async function refreshStats() {
  state.stats = await api('/api/stats');
  const s = state.stats;
  $('#tagline').textContent = s.model
    ? `${s.votes.up + s.votes.down} votes · ${s.model.metrics?.accuracy != null ? pct(s.model.metrics.accuracy) : '—'} accurate`
    : `${s.votes.up + s.votes.down} votes · learning`;
  if (state.view === 'brain') renderBrain();
}

/* ------------------------------------------------------------------ wiring */

for (const tab of document.querySelectorAll('nav.tabs button')) {
  tab.addEventListener('click', () => showView(tab.dataset.view));
}
for (const btn of document.querySelectorAll('.judge button')) {
  btn.addEventListener('click', () => vote(Number(btn.dataset.vote)));
}
$('#undo-btn').addEventListener('click', undo);

document.addEventListener('keydown', (e) => {
  if (state.view !== 'train' || e.metaKey || e.ctrlKey) return;
  if (e.key === 'ArrowRight' || e.key === 'l') vote(1);
  else if (e.key === 'ArrowLeft' || e.key === 'h') vote(-1);
  else if (e.key === 'ArrowDown' || e.key === ' ') { e.preventDefault(); vote(0); }
  else if (e.key === 'u') undo();
});

$('#mode-chips').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.feed.mode = btn.dataset.mode;
  for (const b of $('#mode-chips').children) b.classList.toggle('active', b === btn);
  loadFeed({ reset: true });
});

$('#range-chips').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
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
  state.feed.minScore = v;
  $('#min-score-out').textContent = v === 0 ? 'off' : `${v}%`;
});
$('#min-score').addEventListener('change', () => loadFeed({ reset: true }));

let searchTimer;
$('#search').addEventListener('input', (e) => {
  state.feed.q = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadFeed({ reset: true }), 250);
});

$('#talk-chips').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.feed.minComments = Number(btn.dataset.minComments);
  for (const b of $('#talk-chips').children) b.classList.toggle('active', b === btn);
  loadFeed({ reset: true });
});

$('#load-more').addEventListener('click', () => {
  state.feed.offset += 50;
  loadFeed();
});

$('#btn-ingest').addEventListener('click', async (e) => {
  e.target.disabled = true;
  const label = e.target.textContent;
  e.target.textContent = 'fetching…';
  try {
    const r = await api('/api/ingest', { method: 'POST', body: { days: 7 } });
    toast(`${r.inserted} new stories (${r.fetched} seen)${r.live ? ` — ${r.live} via live API` : ''}`);
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
    const r = await api('/api/train', { method: 'POST' });
    toast(r.trained ? `retrained on ${r.counts.up + r.counts.down} votes` : 'need more votes on both sides');
    await refreshStats();
  } catch (err) {
    toast(err.message);
  } finally {
    e.target.disabled = false;
  }
});

$('#btn-export').addEventListener('click', async () => {
  const data = await api('/api/export');
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = el('a', { href: url, download: `rekorderlig-votes-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  URL.revokeObjectURL(url);
});

$('#btn-import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const r = await api('/api/import', { method: 'POST', body: JSON.parse(await file.text()) });
    toast(`imported ${r.applied} votes`);
    await refreshStats();
  } catch (err) {
    toast(err.message);
  }
  e.target.value = '';
});

/* -------------------------------------------------------------------- boot */

await refreshStats();
showView('train');
