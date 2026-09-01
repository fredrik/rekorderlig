/* Brain: what the model knows, the learning curve, the corpus charts, and
   the two buttons that fetch and export. */

import { FEED_DEFAULTS, feedParams } from './feed-params.js';
import { hook, register } from './registry.js';
import { navigate } from './router.js';
import { refreshStats } from './chrome.js';
import { $, api, el } from './dom.js';
import { ago, pct, plural } from './format.js';
import { state } from './state.js';
import { setDataNote } from './status.js';

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

  $('#version-note').replaceChildren(...versionLine(s.version));
}

// Where this code came from: the origin of the commit link. Only the short
// sha is shown; the full one is the link target.
const REPO = 'https://github.com/fredrik/rekorderlig';

// Which build the server is. `version` is null on a server that predates the
// field, and carries null commit/builtAt on a local `cargo run` — a dev build
// has no commit to name, and saying so beats a blank line.
function versionLine(v) {
  if (!v) return [];
  const parts = [`rekorderlig ${v.app}`];
  if (v.commit) {
    parts.push(el('a', {
      href: `${REPO}/commit/${v.commit}`, target: '_blank', rel: 'noopener',
    }, v.commit.slice(0, 7)));
  } else {
    parts.push('dev build');
  }
  if (v.builtAt) parts.push(`built ${ago(v.builtAt)}`);
  return parts.flatMap((p, i) => (i ? [' · ', p] : [p]));
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
    bar.addEventListener('click', () => openScoreBand(i / n, (i + 1) / n));
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
    bar.append(svgEl('title', {}, [`${d.day} · ${nStories(d.count)} · click to browse`]));
    bar.addEventListener('pointerenter', () => show(d));
    bar.addEventListener('click', () => openDay(d.day));
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
    hook(state.view, 'sync')?.();
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

/**
 * Open one day of this chart in the feed.
 *
 * The bar counts every story the corpus holds for that day; the feed shows the
 * ones it can rank, so the list will be shorter than the bar. The traction
 * floors come off to narrow that gap as far as it honestly goes — the rest is
 * unscored and unrankable stories, which the feed has never shown.
 *
 * Written through `feedParams` like the bucket below, so the one place that
 * decides how a filter is spelled stays the one place. That means saying the
 * implied context out loud here: the writer omits a floor of nothing because
 * the day implies it, not the other way round.
 */
function openDay(day) {
  navigate('/feed' + feedParams({ ...FEED_DEFAULTS, day, minPoints: 0, minComments: 0 }));
}

/**
 * Open one bucket of the histogram in the feed.
 *
 * Everything but the score bounds goes back to default, deliberately: this
 * chart counts the whole unvoted corpus, so a 7-day window or a comment floor
 * left on would show nine stories where the bar promised twelve hundred. The
 * bucket says so itself — `?s=70-75` implies all time and no traction floor.
 *
 * Built as a URL rather than by calling into the feed. Brain has no business
 * knowing how the feed keeps its state, and a bucket is a place: the back
 * button should bring you back here.
 */
function openScoreBand(lo, hi) {
  navigate('/feed' + feedParams({
    ...FEED_DEFAULTS,
    days: 0,
    minComments: 0,
    minScore: Math.round(lo * 100),
    maxScore: Math.round(hi * 100),
  }));
}

register('brain', { show: renderBrain, stats: renderBrain });
