/* Explore: the same judging loop over a pool the crowd already picked.
   Not round-shaped, and triggers no retrain. */

import { register } from './registry.js';
import { refreshStats, renderTagline } from './chrome.js';
import { $, api, el } from './dom.js';
import { ago, plural } from './format.js';
import { needMore, showReveal } from './reveal.js';
import { state } from './state.js';
import { setTrainStatus } from './status.js';

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

export async function voteExplore(value) {
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

register('explore', {
  show: () => { if (state.explore.queue.length === 0) loadExplore(); },
});
