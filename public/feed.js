/* Feed: the ranked list, its filters, and the GET parameters they live in —
   `setFeed()` is the one way a filter moves, `paintFilters()` the one paint
   path. */

import { register } from './registry.js';
import { refreshStats } from './chrome.js';
import { $, api, el, icon } from './dom.js';
import { FEED_DEFAULTS, feedParams, readFeedParams } from './feed-params.js';
import { ago, pct, plural, scoreColor } from './format.js';
import { bindRead, readRow, storyHref, threadHref, titleKind } from './read.js';
import { showView, urlFor } from './router.js';
import { state } from './state.js';
import { setListNote } from './status.js';

/** Where a view lives: its path, plus the feed's filters as GET parameters. */
// The mode chips in index.html are the only place a mode is declared, so the
// list is read off them and handed to the parser rather than kept twice. The
// Read row's three states are declared the same way, by its chips.
const feedModes = () => [...$('#mode-chips').children].map((b) => b.dataset.mode);
const feedReads = () => [...$('#read-chips').children].map((b) => b.dataset.read);

const readFilters = (search) => readFeedParams(search, feedModes(), feedReads());

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
    mode: f.mode, days: f.days, minScore: f.minScore / 100,
    minPoints: f.minPoints, minComments: f.minComments,
    limit: 50, offset: f.offset, includeVoted: f.includeVoted ? '1' : '0',
    read: f.read,
  });
  // One dated day instead of a window back from now. The server reads `day`
  // ahead of `days`, but sending both would leave two filters in the request
  // saying different things about time.
  if (f.day) { params.set('day', f.day); params.delete('days'); }
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
  if (story.vote > 0) li.classList.add('voted-up');
  if (story.vote < 0) li.classList.add('voted-down');

  const badge = el('div', { className: 'score-badge' }, [
    el('span', { style: `color:${scoreColor(score)}` }, score == null ? '—' : pct(score)),
    el('div', { className: 'bar' }, [
      el('i', { style: `width:${score == null ? 0 : Math.round(score * 100)}%;background:${scoreColor(score)}` }),
    ]),
    el('small', {}, story.confidence >= 0.5 ? 'match' : story.confidence > 0 ? 'guess' : 'new'),
  ]);

  // Opening either door marks the story read: the row dims and says so at
  // once, and the next load leaves it out (the Read row's default is Hide).
  // An Ask HN has no link, so its title opens the thread and is marked as one.
  const read = readRow(li, story, { onError: (err) => setListNote(err.message, { error: true }) });
  const title = bindRead(el('a', {
    className: 'story-title',
    href: storyHref(story),
    target: '_blank', rel: 'noreferrer',
  }, [story.title, ' ', el('span', { className: 'dom' }, story.domain ? `(${story.domain})` : '')]),
  story, titleKind(story), read.paint);

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
    bindRead(el('a', { href: threadHref(story), target: '_blank', rel: 'noreferrer' }, 'Thread'),
      story, 'thread', read.paint),
    whyBtn,
    ...read.nodes,
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
  // Every row is one filter and one active member, so lighting is one function
  // over the `data-*` the row is keyed by. A value no chip carries lights
  // none of them, which is how a dated day leaves the window row dark.
  const light = (sel, key, value) => {
    const attr = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    for (const b of $(sel).querySelectorAll(`button[data-${attr}]`)) {
      b.classList.toggle('active', b.dataset[key] === String(value));
    }
  };
  light('#mode-chips', 'mode', f.mode);
  // A dated day *is* this row's value while it is in force, so no window chip
  // is lit beside it. Without this the panel said "7 days" next to a list
  // showing one day in July — the one thing this function exists to prevent.
  light('#range-chips', 'days', f.day ? null : f.days);
  light('#points-chips', 'minPoints', f.minPoints);
  light('#talk-chips', 'minComments', f.minComments);
  light('#voted-chips', 'includeVoted', f.includeVoted ? 1 : 0);
  light('#read-chips', 'read', f.read);
  $('#day-picker').value = f.day ?? '';
  $('#day-picker').classList.toggle('active', f.day != null);
  $('#min-score').value = Math.min(90, f.minScore);
  $('#min-score-out').textContent = f.minScore === 0 ? 'off' : `${f.minScore}%`;
  // Never rewrite the box being typed in: `q` is trimmed and the raw value may
  // not be, so assigning it back would eat a trailing space mid-word.
  if (document.activeElement !== $('#search')) $('#search').value = f.q;

  // One chip for whichever context was clicked out of Brain — a score bucket
  // from the histogram, or a day from the stories-per-day chart. They are
  // mutually exclusive by construction: arriving at either clears the other,
  // because each is a whole set of filters rather than one more of them.
  const band = f.maxScore != null
    ? `match ${f.minScore}–${f.maxScore}% · all time · ✕`
    : f.day
      // Just the date. It used to read "all stories that day", which was never
      // quite true — the feed shows what it can rank, and hides what you have
      // voted on — and is now not true at all, since a day picked in the panel
      // keeps the traction floors standing beside it.
      ? `${fmtBandDay(f.day)} · ✕`
      : null;
  $('#filter-band').hidden = band == null;
  if (band) $('#filter-band-clear').textContent = band;
}

/**
 * A day key as the chip says it. Parsed as UTC — the corpus stores days in
 * UTC, so reading `2026-08-12` in local time would name the 11th west of
 * Greenwich and label the chip with a day the list is not showing.
 */
function fmtBandDay(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (d.getUTCFullYear() !== new Date().getUTCFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
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
  // Touching any filter that isn't the band itself leaves band-browsing. A
  // band is a whole context, not one more filter: intersecting it with a fresh
  // mode or range would show a count the bar it came from never promised.
  // Everything it set goes back to default, unless the patch sets it itself.
  // (This one rule replaced a `clearScoreBand()` at the top of five handlers.)
  let full = patch;
  if (f.maxScore != null && !('maxScore' in patch)) {
    full = { minScore: FEED_DEFAULTS.minScore, maxScore: null, ...full };
  }
  // A band restores only what identifies it — the day here, the two bounds
  // above — and leaves the rest of the view it opened standing. That rule was
  // the score bucket's already; the day used to also snap the comment floor
  // back to 10, which quietly threw away a floor set by hand in the panel.
  if (f.day && !('day' in patch)) {
    full = { day: null, ...full };
  }
  Object.assign(f, full);
  // `days` and `day` are two shapes of one filter; naming either retires the
  // other, so state never holds two answers about time.
  if ('days' in full) f.day = null;
  if (full.day) f.days = FEED_DEFAULTS.days;
  const url = urlFor('feed');
  if (push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
  paintFilters();
  loadFeed({ reset: true });
}

// Leaving the band by its own chip is the only exit that names both bounds, so
// it is the only one `setFeed`'s rule above leaves alone.
$('#filter-band-clear').addEventListener('click', () => {
  setFeed({ minScore: FEED_DEFAULTS.minScore, maxScore: null, day: null });
});

// Every chip group is the same gesture — one button in the group becomes the
// value of one filter — so they share a binding and differ only in which key
// the button carries. The date picker below is the one control that is not a
// chip, because a date is not four choices.
function chipGroup(sel, patchFor) {
  $(sel).addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) setFeed(patchFor(btn));
  });
}
chipGroup('#mode-chips', (b) => ({ mode: b.dataset.mode }));
chipGroup('#range-chips', (b) => ({ days: Number(b.dataset.days) }));
chipGroup('#points-chips', (b) => ({ minPoints: Number(b.dataset.minPoints) }));
chipGroup('#talk-chips', (b) => ({ minComments: Number(b.dataset.minComments) }));
chipGroup('#voted-chips', (b) => ({ includeVoted: b.dataset.includeVoted === '1' }));
chipGroup('#read-chips', (b) => ({ read: b.dataset.read }));

// The other shape of the window row. Naming a day retires the window (see
// `setFeed`), and clearing the picker hands the row back to the chips. It sits
// in the row rather than beside it because there is only ever one answer about
// time — two controls in two places would look like two filters to intersect.
$('#day-picker').addEventListener('change', (e) => setFeed({ day: e.target.value || null }));

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

register('feed', {
  show: () => loadFeed({ reset: true }),
  // The feed is the one view whose URL says more than which section is open.
  url: () => `/feed${feedParams(state.feed)}`,
  // A link, a bookmark or the back button landing here: take the filters out
  // of the URL and paint the panel from them before the list is asked for.
  adopt: (search) => {
    Object.assign(state.feed, readFilters(search));
    paintFilters();
  },
});
