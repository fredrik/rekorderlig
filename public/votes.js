/* Votes: the history list, and the held-out score when it argues with the
   verdict beside it. */

import { register } from './registry.js';
import { refreshStats, renderTagline } from './chrome.js';
import { $, api, el, icon } from './dom.js';
import { ago, pct, plural } from './format.js';
import { state } from './state.js';
import { setVotesNote } from './status.js';

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

register('votes', { show: () => loadVotes({ reset: true }) });
