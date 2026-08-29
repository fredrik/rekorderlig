/* rekorderlig front end — no framework, just the DOM.

   The DOM-free parts live in their own modules so tests can import and run
   them instead of asserting about this file's source text: `format.js`
   (numbers into words), `certainty.js` (the confidence bands) and
   `feed-params.js` (the feed's filters, to and from the URL). */

import { pct, plural, ago, scoreColor } from './format.js';
import { CERTAINTY, certainty } from './certainty.js';
import { FEED_DEFAULTS, readFeedParams, feedParams } from './feed-params.js';

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
  compass: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
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

/**
 * Status goes into the layout, never over it. The old floating toast was
 * unreadable mid-swipe and gone by the time you looked up — and it announced
 * "Learned · 64% accurate" after a skip, which trained nothing.
 *
 * `nodes` may be a string or elements. An error stays until something replaces
 * it; anything else clears itself after a few seconds.
 */
function setTrainStatus(nodes, { error = false, hold = false } = {}) {
  // Both decks judge, so both report; the line belongs to whichever is open.
  const t = $(state.view === 'explore' ? '#explore-status' : '#train-status');
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


/* --------------------------------------------------------- feed filters */

const state = {
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
};

/* ------------------------------------------------------------------ views */

const VIEWS = ['train', 'explore', 'feed', 'votes', 'brain'];
const viewFromPath = () => {
  const name = location.pathname.replace(/^\//, '');
  return VIEWS.includes(name) ? name : 'train';
};

/** Where a view lives: its path, plus the feed's filters as GET parameters. */
// The mode chips in index.html are the only place a mode is declared, so the
// list is read off them and handed to the parser rather than kept twice.
const feedModes = () => [...$('#mode-chips').children].map((b) => b.dataset.mode);
const readFilters = (search) => readFeedParams(search, feedModes());

const urlFor = (view) => (view === 'feed' ? `/feed${feedParams(state.feed)}` : `/${view}`);

function showView(view, { push = true } = {}) {
  // Each section owns a path (/train, /feed, /brain) so a refresh or a
  // bookmark lands back on the same section; the server serves the app
  // shell for every one of them. Only the feed carries GET parameters, and
  // they are written from `state.feed` rather than copied off the current URL
  // — so leaving the feed and coming back by a tab restores the filters you
  // left it under, and the address bar keeps saying what the list is showing.
  const url = urlFor(view);
  if (push && location.pathname + location.search !== url) history.pushState(null, '', url);
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
  if (view === 'train' && state.queue.length === 0) loadRound();
  if (view === 'explore' && state.explore.queue.length === 0) loadExplore();
}

/* ---------------------------------------------------------------- trainer */

// Training is dealt in rounds now, so there is no refilling, no cursor and no
// varying deck size: a round is one draw from one model revision, and the
// server decides how big it is. What the deck loses in continuity it gains in
// having an end — and in every card of a round being a sample from the same
// model state, which is what makes the round's numbers comparable.

/**
 * Put a round on the table. On open there is usually one in flight — resumed
 * from the server, so a reload or a switch of device continues where it left
 * off — and if there is not, one is dealt. Every round after the first is
 * dealt deliberately, by the button on the summary: the pause is what makes
 * the task finite.
 */
async function loadRound({ deal = false } = {}) {
  showDeckMessage([el('div', { className: 'row muted' }, [el('span', { className: 'spinner' }), ' Dealing…'])]);
  try {
    const { round } = deal
      ? await api('/api/round', { method: 'POST' })
      : await api('/api/round');
    if (!round) return loadRound({ deal: true });
    setRound(round);
    // Everything already judged: the round finished but its retrain never ran
    // (the tab was closed on the last card). Pick the beat back up.
    if (!state.queue.length) return finishRound();
    renderCard();
  } catch (err) {
    showDeckMessage([el('div', { className: 'muted' }, err.message)]);
  }
}

function setRound(round) {
  state.round = {
    seq: round.seq, size: round.size,
    judged: round.judged ?? 0, skipped: round.skipped ?? 0,
    finished: Boolean(round.finished),
  };
  state.queue = round.cards ?? [];
  renderTagline();
}

function showDeckMessage(nodes) {
  $('#deck').replaceChildren(el('div', { className: 'card trainer-card' }, nodes));
  showJudgeRow(false);
}

/** The vote buttons exist only while there is a card to judge. */
function showJudgeRow(visible) {
  $('#view-train .judge').hidden = !visible;
}

/**
 * The end of a round: one retrain, for the dozen votes that earned it, then
 * the summary. A round of nothing but skips added no examples, so it retrains
 * nothing and says so rather than announcing it learned something.
 *
 * `finished` guards the reload case — reopening the tab on a spent round shows
 * the summary again instead of paying for a second retrain of the same votes.
 */
async function finishRound() {
  const round = state.round;
  setTrainStatus('');
  if (round?.judged && !round.finished) {
    showDeckMessage([
      el('div', { className: 'row muted' }, [el('span', { className: 'spinner' }), ' Learning from this round…']),
    ]);
    try {
      await triggerTrain();
    } catch (err) {
      showDeckMessage([el('div', { className: 'muted' }, err.message)]);
      return;
    }
  }
  try {
    const { summary } = await api('/api/round/summary');
    renderRoundSummary(summary);
  } catch (err) {
    showDeckMessage([el('div', { className: 'muted' }, err.message)]);
  }
}

/**
 * What the round did, ordered by how much each line means rather than by how
 * good it looks.
 *
 * What it learned about you comes first: it is caused by these votes and it is
 * about you, which is the whole point of the app. Signals gained is next —
 * monotonic and honest. Accuracy comes last and is only reported as a move
 * when it clears its own noise band, because a dozen votes shift it by about
 * as much as nothing at all does (±3 points on this vote history).
 */
function renderRoundSummary(summary) {
  const round = summary ?? { seq: state.round?.seq ?? 0, judged: 0, skipped: 0 };
  const lines = [];

  const tally = [`${round.judged} judged`];
  if (round.skipped) tally.push(`${round.skipped} skipped`);
  lines.push(el('div', { className: 'summary-tally' }, tally.join(' · ')));

  if (round.signals?.gained > 0) {
    lines.push(el('div', { className: 'summary-gain' }, `+${plural(round.signals.gained, 'new signal')}`));
  }

  // The signals this round moved, green towards yes and red towards no. No
  // heading and no labels: the colours already say which way each one went,
  // and naming it twice read as an instruction.
  const movers = [
    ...(round.learned?.likes ?? []).map((m) => ({ ...m, cls: 'pos' })),
    ...(round.learned?.dislikes ?? []).map((m) => ({ ...m, cls: 'neg' })),
  ];
  if (movers.length) {
    lines.push(el('div', { className: 'summary-movers' },
      movers.map((m) => el('span', { className: `term-chip ${m.cls}` }, m.label))));
  }

  if (round.guessed) {
    // The explore subset is still computed — it is the only unbiased read of
    // true accuracy — but a bare "1/2 on the random cards" explained none of
    // that and asked the reader to guess. It belongs somewhere with room to
    // say what it is.
    lines.push(el('div', { className: 'muted' },
      `Brain called ${round.guessed.right} of ${round.guessed.of} before you did`));
  }

  const acc = round.accuracy;
  if (acc?.after != null) {
    // The move is shown whether or not it cleared the band, in grey when it did
    // not. Hiding the before-value on a flat round left only two states — a
    // coloured arrow or a bare number — so the same wobble read as a regression
    // one round and as nothing having happened the next, and a recovery was
    // invisible: 65 → 62 → 64 showed as a red drop and then silence. Grey says
    // "this moved and it means nothing", which is the honest reading of both.
    const same = acc.before != null && pct(acc.before) === pct(acc.after);
    const dir = !acc.significant ? 'flat' : acc.after > acc.before ? 'up' : 'down';
    lines.push(el('div', { className: 'summary-accuracy' }, [
      // Nothing to show a move with when both ends round to the same figure.
      acc.before != null && !same
        ? el('span', { className: `delta ${dir}` }, `${pct(acc.before)} → ${pct(acc.after)}`)
        : el('span', {}, `${pct(acc.after)}`),
      el('span', {}, ' accurate'),
      // The fallback band, and only when there is no paired count to show and
      // something to be unchanged *from* — not on the first round ever.
      el('span', { className: 'summary-band' },
        acc.flips || acc.before == null || acc.significant
          ? ''
          : ` · unchanged within ±${Math.round((acc.band ?? 0) * 100)}`),
    ]));

    // What the move actually rests on: of the votes both revisions held out,
    // the ones whose call changed sides. This is the line the summary could not
    // say before — an aggregate cannot tell twelve flipped one way from
    // thirty-five flipped, net twelve, and the percentages above move on the
    // denominator too, since the second one has this round's votes under it.
    if (acc.flips) {
      const { moved, shared, net } = acc.flips;
      const sign = net > 0 ? '+' : '−';
      lines.push(el('div', { className: 'summary-flips' },
        `${moved} of ${plural(shared, 'prediction')} changed sides`
        + (net ? `, net ${sign}${Math.abs(net)}` : '')));
    }
  }

  if (round.trained === false && round.judged === 0) {
    lines.push(el('div', { className: 'muted' }, 'Nothing to learn from — every card was skipped.'));
  }

  const button = el('button', { className: 'primary deal-again' }, 'Deal another round');
  button.addEventListener('click', () => loadRound({ deal: true }));

  $('#deck').replaceChildren(el('div', { className: 'card trainer-card round-summary' }, [
    el('div', { className: 'summary-head' }, `Round ${round.seq} done`),
    ...lines,
    button,
  ]));
  showJudgeRow(false);
  state.round = null;
  renderTagline();
  button.focus();
}

function renderCard() {
  const deck = $('#deck');
  const story = state.queue[0];
  if (!story) {
    // A round that came back empty: the corpus has nothing left to offer above
    // the points floor. Finishing a round lands in renderRoundSummary instead.
    const again = el('button', { className: 'primary deal-again' }, 'Try again');
    again.addEventListener('click', () => loadRound({ deal: true }));
    deck.replaceChildren(el('div', { className: 'card trainer-card round-summary' }, [
      el('div', { className: 'summary-head' }, 'Nothing left to judge'),
      el('div', { className: 'muted' }, 'Fetch new stories from the Brain tab.'),
      again,
    ]));
    showJudgeRow(false);
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
    // Title and domain only, because those are the only things on this card the
    // model can see. featurize() reads title words, bigrams, style, domain, tld
    // and author — never points, comments or age. Showing a number the model
    // cannot learn from contaminates the label: a yes swayed by "98 comments"
    // arrives attached to the story's *words*, which is all the model has, so
    // your reason lands as noise in the title weights. Comment counts are also
    // frozen at fetch time, making them a fact about when the sync ran rather
    // than about the story.
    //
    // The rule is one-directional. Author is a feature and is not shown, which
    // is fine — the model finding signal you did not consciously weigh is
    // learning, not contamination.
    el('div', { className: 'trainer-meta' }, [
      el('span', { className: 'domain' }, story.domain ?? 'news.ycombinator.com'),
    ]),
  ]);

  deck.replaceChildren(card);
  showJudgeRow(true);
  renderTagline();
}

async function vote(value) {
  const story = state.queue[0];
  if (!story) return;

  const card = $('#deck .trainer-card');
  if (card) card.classList.add(value > 0 ? 'leaving-up' : value < 0 ? 'leaving-down' : 'leaving-skip');

  state.queue.shift();
  state.judgedIds.add(story.id);
  if (state.round) {
    if (value === 0) state.round.skipped++;
    else state.round.judged++;
  }
  renderTagline();

  // The last card ends the round; until then the next card comes straight up.
  if (state.queue.length) setTimeout(renderCard, 130);
  else setTimeout(finishRound, 130);

  try {
    const res = await api('/api/vote', { method: 'POST', body: { id: story.id, value } });
    state.taught = res.taught ?? null;
    const need = needMore(res.votes);
    if (need) setTrainStatus(need, { hold: true });
    else showReveal(res.prediction, value, story);
    await refreshStats();
    // No retrain here. Training happens once, at the end of the round, so a
    // dozen votes buy one rescore instead of twelve — and every card of a
    // round is judged against the same model, which is what lets the round
    // report what it changed.
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
 *
 * How sure it was is said in words as well as a number, on the CERTAINTY
 * scale — "51% certain" is a sentence that contradicts itself.
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

  // What the vote gives the model that it did not have. Directly caused by the
  // swipe, and it only goes up — unlike a hit rate, which the queue pins near
  // chance by design, since the boundary stratum picks the cards the model is
  // least sure about.
  const taught = state.taught?.count
    ? el('span', { className: 'tally' }, [
        `Taught it ${plural(state.taught.count, 'new signal')}`,
        state.taught.labels.length ? `: ${state.taught.labels.join(', ')}` : '',
      ].join(''))
    : null;

  const line = (...nodes) => el('div', { className: 'judged-line' }, nodes.filter(Boolean));

  if (!prediction) {
    // A skip, or a story the model had never scored. Say what actually
    // happened rather than inventing a result.
    const said = value === 0
      ? el('span', {}, 'You skipped it — nothing to learn from a skip.')
      : el('span', {}, 'Brain had no guess on file for that one.');
    setTrainStatus([line(said), ...(taught ? [line(taught)] : []), ...(title ? [title] : [])]);
    return;
  }

  const guessedYes = prediction.score >= 0.5;
  // How sure it was of the call it actually made. Beside "guessed no", the
  // probability of yes reads as the opposite of what it means.
  const strength = guessedYes ? prediction.score : 1 - prediction.score;
  const sure = certainty(strength);

  setTrainStatus([
    line(
      el('span', { className: `verdict ${prediction.agreed ? 'hit' : 'miss'} sure-${sure.name}` }, [
        icon(prediction.agreed ? 'equals' : 'not-equals'),
        `Brain guessed ${guessedYes ? 'yes' : 'no'} (${sure.label}, ${pct(strength)})`,
      ]),
      el('span', {}, `— you said ${value > 0 ? 'yes' : 'no'}.`),
    ),
    // Its own line: what the model guessed and what it gained from the vote
    // are two different statements, and running them together made a sentence
    // long enough to lose.
    ...(taught ? [line(taught)] : []),
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

// Voting only records; the retrain is triggered once, by the end of a round.
// Nothing else asks for one — a vote cast in Feed or Votes is trained on when
// the next round finishes. That keeps one rule instead of three, and keeps a
// round's cards judged against a single model revision, which is what makes
// the round's before-and-after mean anything.
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
  if (status.lastError) return status;
  await refreshStats();
  return status;
}

/* ---------------------------------------------------------------- explore */

// The trainer's judging loop over a pool the crowd already picked: only stories
// that reached the traction bar, tiered "probably" (the model likes them too)
// before "possibly" (it has no strong opinion — the crowd is the reason the
// card is here). The deck itself lives in `state.explore`.
//
// Deliberately not round-shaped. A round is a sample from one model revision,
// dealt so its before-and-after numbers mean something; this deck is a reading
// list you happen to be able to vote on, so it refills instead of ending. It
// triggers no retrain either: a vote cast here is trained on when the next
// round finishes, the same rule Feed and Votes follow.

function showExploreMessage(nodes) {
  $('#explore-deck').replaceChildren(el('div', { className: 'card trainer-card round-summary' }, nodes));
  $('#view-explore .judge').hidden = true;
}

/** Fill the deck. A range chip changed mid-flight wins, hence the ticket. */
async function loadExplore() {
  const ticket = ++state.explore.ticket;
  showExploreMessage([
    el('div', { className: 'row muted' }, [el('span', { className: 'spinner' }), ' Finding stories worth your time…']),
  ]);
  try {
    const data = await api(`/api/explore?limit=40&days=${state.explore.days}`);
    if (ticket !== state.explore.ticket) return;
    if (data.bar) state.explore.bar = data.bar;
    // The server excludes what has been voted on, but a vote cast a moment ago
    // may not have landed yet; judgedIds covers that gap.
    state.explore.queue = data.items.filter((story) => !state.judgedIds.has(story.id));
    renderExploreCard();
  } catch (err) {
    if (ticket !== state.explore.ticket) return;
    showExploreMessage([el('div', { className: 'muted' }, err.message)]);
  }
}

function renderExploreCard() {
  const story = state.explore.queue[0];
  if (!story) {
    // The bar is quoted from the server's own answer rather than repeated
    // here, so this can never drift from the rule it describes.
    showExploreMessage([
      el('div', { className: 'summary-head' }, 'Nothing has cleared the bar'),
      el('div', { className: 'muted' }, state.explore.bar
        ? `Nothing unjudged in this range reached ${state.explore.bar.minPoints} points or `
          + `${state.explore.bar.minComments} comments. Widen the range, or fetch new stories from Brain.`
        : 'Widen the range, or fetch new stories from the Brain tab.'),
    ]);
    renderTagline();
    return;
  }

  // Unlike the trainer's card, this one shows points and comments. The trainer
  // hides them because a swipe swayed by "412 comments" lands as noise in the
  // title weights — the model reads words, not traction. Here the traction IS
  // the offer: it is why the story is on screen, and hiding it would leave the
  // deck unexplained. The model's own score stays hidden in both, and the tier
  // chip stays coarse, so the number that would anchor a vote never appears.
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
      // At the end of the meta line, so the tier costs no height of its own.
      el('span', { className: `tier-chip ${story.tier}` }, TIER_LABELS[story.tier] ?? ''),
    ]),
  ]);

  $('#explore-deck').replaceChildren(card);
  $('#view-explore .judge').hidden = false;
  renderTagline();
}

const TIER_LABELS = {
  probably: 'Probably for you',
  possibly: 'Possibly — the crowd is on it',
};

async function voteExplore(value) {
  const story = state.explore.queue[0];
  if (!story) return;

  const card = $('#explore-deck .trainer-card');
  if (card) card.classList.add(value > 0 ? 'leaving-up' : value < 0 ? 'leaving-down' : 'leaving-skip');

  state.explore.queue.shift();
  state.judgedIds.add(story.id);
  // A loud story can be in the round on the Train tab as well; drop it there
  // so the same title is never put twice. The round's own tally is a join
  // against `votes` server-side, so it stays right either way.
  state.queue = state.queue.filter((s) => s.id !== story.id);
  renderTagline();

  setTimeout(() => (state.explore.queue.length ? renderExploreCard() : loadExplore()), 130);

  try {
    const res = await api('/api/vote', { method: 'POST', body: { id: story.id, value } });
    state.taught = res.taught ?? null;
    const need = needMore(res.votes);
    if (need) setTrainStatus(need, { hold: true });
    else showReveal(res.prediction, value, story);
    await refreshStats();
  } catch (err) {
    setTrainStatus(err.message, { error: true });
  }
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
  // Both score bounds are percentages in state and in the URL; the API takes
  // fractions, and this is the one place they are converted.
  const params = new URLSearchParams({
    mode: f.mode, days: f.days, minScore: f.minScore / 100, minComments: f.minComments,
    limit: 50, offset: f.offset, includeVoted: f.includeVoted ? '1' : '0',
  });
  if (f.q) params.set('q', f.q);
  if (f.maxScore != null) params.set('maxScore', f.maxScore / 100);

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
    // The row repaints itself — that is the confirmation. The vote is trained
    // on when the next round ends, like every other vote.
    setVotesNote('');
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
  if (!s || state.view === 'brain') { t.replaceChildren(); return; }
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

/* ------------------------------------------------------- learning curve */

// When a training run happened. `trainedAt` is unix seconds from the Rust
// backend, but rows the Node backend wrote carried milliseconds — anything
// past ~33k years in seconds is read as ms. The year is spelled out only when
// it is not this year's; "Aug 12" says everything about a recent run.
function fmtRunDate(ts) {
  const d = new Date(ts > 1e12 ? ts : ts * 1000);
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

// "Does the brain get smarter?" answered with the only honest evidence there
// is: cross-validated accuracy at each retrain, against the baseline a coin
// weighted to your yes/no split would score. Below the baseline means the
// model is worse than guessing your majority verdict every time.
async function loadCurve() {
  try {
    const { points, runs } = await api('/api/history');
    if (points.length < 2) { $('#curve-panel').hidden = true; return; }
    renderCurve(points, runs);
    $('#curve-panel').hidden = false;
  } catch {
    // Same as the other panels: a failed fetch leaves this one as it was.
  }
}

function renderCurve(points, runs) {
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

  // The band the accuracy figure wobbles inside, drawn behind the line: half
  // the moves on this chart are inside it, and a curve without it invites you
  // to read noise as a trend. Only over the stretch where it was recorded —
  // revisions trained before the band existed do not get one invented for them.
  const bandFrom = points.findIndex((p) => p.noise != null);
  if (bandFrom >= 0 && points.length - bandFrom > 1) {
    const tail = points.slice(bandFrom);
    const upper = tail.map((p, i) => `${i ? 'L' : 'M'}${x(bandFrom + i).toFixed(1)} ${y(Math.min(1, p.accuracy + p.noise)).toFixed(1)}`);
    const lower = [...tail].reverse().map((p, i) => `L${x(points.length - 1 - i).toFixed(1)} ${y(Math.max(0, p.accuracy - p.noise)).toFixed(1)}`);
    svg.append(svgEl('path', { class: 'curve-band', d: `${upper.join(' ')} ${lower.join(' ')} Z` }));
  }

  svg.append(
    svgEl('line', { class: 'curve-grid', x1: PAD.l, x2: PAD.l + plotW, y1: y(0.5), y2: y(0.5) }),
    line(points.map((p) => p.baseline ?? 0.5), 'curve-baseline'),
    line(points.map((p) => p.accuracy), 'curve-line'),
  );

  const last = points.at(-1);
  // The readout always describes exactly one run — the hovered one, or the
  // latest when nothing is hovered — and that run's dot wears the highlight,
  // so the number and the point on the chart can never disagree about which
  // run is meant. The date is what places the run in time; the vote count
  // places it on the learning curve.
  const dots = points.map((p, i) =>
    svgEl('circle', { class: 'curve-dot', cx: x(i), cy: y(p.accuracy), r: i === points.length - 1 ? 3.5 : 2 }));
  const show = (i) => {
    const p = points[i];
    dots.forEach((d, j) => d.classList.toggle('hot', j === i));
    readout.replaceChildren(
      el('b', {}, pct(p.accuracy)),
      p.noise != null ? ` ±${Math.round(p.noise * 100)}` : '',
      ` accurate at ${plural(p.votes, 'vote')}`,
      el('span', { className: 'muted' },
        ` · baseline ${pct(p.baseline ?? 0.5)} · ${p === last ? 'latest run, ' : 'trained '}${fmtRunDate(p.trainedAt)}`),
    );
  };
  svg.append(...dots);
  // The visible dots are 2px; the hover targets are these invisible twins,
  // wide enough to hit without aiming. Appended after every dot so none of
  // them sits under a neighbour's dot.
  points.forEach((p, i) => {
    const hit = svgEl('circle', { class: 'curve-hit', cx: x(i), cy: y(p.accuracy), r: 9 });
    hit.append(svgEl('title', {}, [`${fmtRunDate(p.trainedAt)} · ${plural(p.votes, 'vote')} · ${pct(p.accuracy)}`]));
    hit.addEventListener('pointerenter', () => show(i));
    svg.append(hit);
  });
  // Leaving the chart hands the readout back to the latest run, instead of
  // leaving it stuck describing whichever point was hovered last.
  svg.addEventListener('pointerleave', () => show(points.length - 1));
  // The axis endpoints are the first and latest training run shown: when it
  // ran and how many votes it was trained on.
  svg.append(
    svgEl('text', { class: 'axis', x: PAD.l, y: H - 4, 'text-anchor': 'start' },
      [`${fmtRunDate(points[0].trainedAt)} · ${plural(points[0].votes, 'vote')}`]),
    svgEl('text', { class: 'axis', x: PAD.l + plotW, y: H - 4, 'text-anchor': 'end' },
      [`${fmtRunDate(last.trainedAt)} · ${plural(last.votes, 'vote')}`]),
  );
  $('#curve-chart').replaceChildren(svg);
  show(points.length - 1);

  const gain = last.accuracy - (last.baseline ?? 0.5);
  // A run is a retrain that actually added votes — from here on, one round.
  // No "up/flat/down since the first run" clause: the curve itself is that
  // sentence, and on a chart this flat it only ever restated the obvious.
  $('#curve-summary').textContent =
    `${plural(runs, 'training run')} · `
    + `${gain > 0 ? `${Math.round(gain * 100)} points better than guessing` : 'not yet better than guessing'}`;
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
  // Same rule as the learning curve: leaving the chart restores the latest
  // day, so the readout is never stuck on an old hover.
  svg.addEventListener('pointerleave', () => show(days.at(-1)));
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
// Both decks carry the same judge row; the section it sits in says which
// queue it moves.
for (const btn of document.querySelectorAll('#view-train .judge button')) {
  btn.addEventListener('click', () => vote(Number(btn.dataset.vote)));
}
for (const btn of document.querySelectorAll('#view-explore .judge button')) {
  btn.addEventListener('click', () => voteExplore(Number(btn.dataset.vote)));
}

$('#explore-range-chips').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  state.explore.days = Number(btn.dataset.days);
  for (const b of $('#explore-range-chips').children) b.classList.toggle('active', b === btn);
  loadExplore();
});

// Arrows only, one binding per action, mirroring the glyphs on the buttons.
document.addEventListener('keydown', (e) => {
  const judge = state.view === 'train' ? vote : state.view === 'explore' ? voteExplore : null;
  if (!judge || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest?.('input, textarea, select')) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); judge(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); judge(-1); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); judge(0); }
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

/**
 * Draw the whole filter panel from `state.feed`. One paint path, called after
 * every change, so the panel can never disagree with the list beside it — the
 * chips, the slider and the band chip are readouts, not a second copy of the
 * filters. (Before the URL held them, each handler lit its own chip and the
 * histogram drill-down mirrored six widgets by hand to stop the panel lying
 * when it was next opened.)
 */
function paintFilters() {
  const f = state.feed;
  // `#range-chips` also holds the judged toggle, which is not one of the days,
  // so each group names the buttons it owns rather than taking every child.
  const light = (sel, on) => {
    for (const b of $(sel).querySelectorAll('button[data-mode], button[data-days], button[data-min-comments]')) {
      b.classList.toggle('active', on(b));
    }
  };
  light('#mode-chips', (b) => b.dataset.mode === f.mode);
  light('#range-chips', (b) => Number(b.dataset.days) === f.days);
  light('#talk-chips', (b) => Number(b.dataset.minComments) === f.minComments);
  $('#voted-toggle').classList.toggle('active', f.includeVoted);
  $('#min-score').value = Math.min(90, f.minScore);
  $('#min-score-out').textContent = f.minScore === 0 ? 'off' : `${f.minScore}%`;
  // Never rewrite the box being typed in: `q` is trimmed and the raw value may
  // not be, so assigning it back would eat a trailing space mid-word.
  if (document.activeElement !== $('#search')) $('#search').value = f.q;

  // The score band is a bucket clicked out of the Brain histogram: minScore
  // plus an exclusive maxScore, standing in for the several filters it set.
  $('#score-band').hidden = f.maxScore == null;
  if (f.maxScore != null) {
    $('#score-band-clear').textContent = `match ${f.minScore}–${f.maxScore}% · all time · ✕`;
  }
}

/**
 * Change some filters: fold them into `state.feed`, write the URL, repaint,
 * reload. The single way the feed's filters ever move.
 *
 * `push` is false for the controls in the panel, so dragging the slider or
 * typing in the search box leaves one history entry rather than dozens; the
 * histogram drill-down passes true, because arriving at a bucket from Brain is
 * a real navigation and the back button should return you to the chart.
 */
function setFeed(patch, { push = false } = {}) {
  const f = state.feed;
  // Touching any filter that isn't the band itself leaves band-browsing. The
  // band is a bucket, not a floor: intersecting it with a fresh mode or range
  // would show a count the histogram bar never promised. Both bounds go back
  // to their defaults, unless the patch sets them itself. (This one rule
  // replaced a `clearScoreBand()` at the top of five separate handlers.)
  const full = f.maxScore != null && !('maxScore' in patch)
    ? { minScore: FEED_DEFAULTS.minScore, maxScore: null, ...patch }
    : patch;
  Object.assign(f, full);
  const url = urlFor('feed');
  if (push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
  paintFilters();
  loadFeed({ reset: true });
}

/** Open one bucket of the Brain histogram in the feed. Percentages, as the URL. */
function showScoreBand(lo, hi) {
  // Everything but the score bounds goes back to default, deliberately: the
  // histogram counts the whole unvoted corpus, so a 7-day window or a comment
  // floor left on would show nine stories where the bar promised twelve hundred.
  Object.assign(state.feed, {
    ...FEED_DEFAULTS,
    days: 0,
    minComments: 0,
    minScore: Math.round(lo * 100),
    maxScore: Math.round(hi * 100),
  });
  paintFilters();
  showView('feed');
}

// Leaving the band by its own chip is the only exit that names both bounds, so
// it is the only one `setFeed`'s rule above leaves alone.
$('#score-band-clear').addEventListener('click', () => {
  setFeed({ minScore: FEED_DEFAULTS.minScore, maxScore: null });
});

// Every chip group is the same gesture — one button in the group becomes the
// value of one filter — so they share a binding and differ only in which key
// the button carries. `#voted-toggle` rides in the range group as a toggle
// rather than a member, and is the one exception.
function chipGroup(sel, patchFor) {
  $(sel).addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) setFeed(patchFor(btn));
  });
}
chipGroup('#mode-chips', (b) => ({ mode: b.dataset.mode }));
chipGroup('#range-chips', (b) => (b.id === 'voted-toggle'
  ? { includeVoted: !state.feed.includeVoted }
  : { days: Number(b.dataset.days) }));
chipGroup('#talk-chips', (b) => ({ minComments: Number(b.dataset.minComments) }));

// The slider paints while it is dragged and only fetches when it settles, so a
// drag across the range is one request and one history entry, not twenty.
$('#min-score').addEventListener('input', (e) => {
  Object.assign(state.feed, { minScore: Number(e.target.value), maxScore: null });
  paintFilters();
});
$('#min-score').addEventListener('change', (e) => setFeed({ minScore: Number(e.target.value) }));

let searchTimer;
$('#search').addEventListener('input', (e) => {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => setFeed({ q }), 250);
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
    if (state.view === 'train') loadRound();
  } catch (err) {
    setDataNote(err.message, { error: true });
  } finally {
    btn.disabled = false;
    btn.textContent = label;
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


// Back and forward restore the filters as well as the section: the feed's GET
// parameters are the whole of what a feed entry is, so re-reading them here is
// what makes the back button out of a histogram drill-down land on the chart
// with the previous filters intact.
window.addEventListener('popstate', () => {
  const view = viewFromPath();
  if (view === 'feed') Object.assign(state.feed, readFilters(location.search));
  paintFilters();
  showView(view, { push: false });
});

/* -------------------------------------------------------------------- boot */

await refreshStats();
// Normalize the address bar (e.g. bare /) to the section path without
// adding a history entry, and drop ?token=… on the way past.
//
// The token in the URL is a bootstrap, not a session: the server answers the
// first tokened request with an `rk_token` cookie good for a year (see
// `authorize()` in src/server.rs), and every request after it authorizes on
// that. Carrying the param onwards only stamps the shared secret into every
// history entry and into anything copied out of the address bar.
//
// Placement is the safety check, not an accident. `refreshStats()` above
// fetches /api/stats with no token param and no Bearer header, so it can only
// have succeeded on the cookie — reaching this line is proof the cookie took.
// If it did not, `api()` throws on the 401 and this never runs, so the tokened
// URL survives for a reload. (The 401 body says to open the tokened link
// again, which is the same recovery.)
//
// The feed's filters are read out of the same GET parameters here, so a
// bookmarked or shared /feed?days=30&minComments=50 opens filtered. What goes
// back is `urlFor()`'s canonical form, which drops defaults and anything that
// failed to parse — so a hand-edited or stale link normalizes on arrival
// instead of leaving the address bar describing a filter that isn't applied.
const boot = new URL(location.href);
boot.searchParams.delete('token');
const view = viewFromPath();
if (view === 'feed') Object.assign(state.feed, readFilters(boot.search));
paintFilters();
history.replaceState(null, '', urlFor(view));
showView(view, { push: false });
