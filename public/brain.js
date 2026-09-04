/* Brain: what the model knows (the learning curve, the corpus charts), the
   You panel — rename, sign out, "Add a device" (its copy-link box), export
   votes — and the Invite panel (the composed card, the five pips, the link
   shown once, the list of invites you have sent). Chart bars **navigate**
   (`/feed?s=70-75`, `/feed?d=…`) rather than calling into the feed; the Data
   panel ends with `#version-note`, from `version` on `/api/stats`. */

import { FEED_DEFAULTS, feedParams } from './feed-params.js';
import { register } from './registry.js';
import { navigate } from './router.js';
import { saveDisplayName } from './chrome.js';
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
    // The server's floor is on each class, not on the total (see `train()`).
    const each = Math.ceil(s.minVotesToTrain / 2);
    note.push(`Cast ${each} yes and ${each} no votes, and it starts learning.`);
  } else {
    const baseline = m.metrics?.baseline;
    note.push(`Accuracy comes from ${m.metrics?.folds ?? 5}-fold cross-validation over your ${m.nVotes} votes` +
      (baseline != null ? `; always guessing your usual verdict would score ${pct(baseline)}.` : '.'));
    if (m.metrics?.auc != null) {
      note.push(m.metrics.auc > 0.8
        ? ' It ranks unseen titles well.'
        : m.metrics.auc > 0.65 ? ' It has a real signal and wants more votes.' : ' Still mostly guessing — keep judging.');
    }
  }
  $('#brain-note').textContent = note.join('');

  const chips = (rows, cls) => rows?.length
    ? rows.map((r) => el('span', { className: `term-chip ${cls}` }, [
        r.label, el('em', {}, r.weight.toFixed(2)), el('small', {}, r.kind),
      ]))
    : [el('span', { className: 'muted', style: 'font-size:13px' }, 'Not enough votes yet.')];

  renderDistribution(m?.distribution);
  loadDaysChart();
  loadCurve();

  $('#brain-likes').replaceChildren(...chips(m?.insights?.likes, 'pos'));
  $('#brain-dislikes').replaceChildren(...chips(m?.insights?.dislikes, 'neg'));

  renderMe(s.user);
  loadInvites();

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
    const lo = Math.round(100 * i / n), hi = Math.round(100 * (i + 1) / n);
    // Square-root scale so the ~0.5 hump doesn't flatten the tails into nothing.
    const h = Math.sqrt(count / max) * barsH;
    const bar = svgEl('rect', {
      class: `bar${i / n >= 0.7 ? ' hot' : ''}`,
      x: x + gap / 2, y: baseline - h, width: step - gap, height: h, rx: 2,
    });
    bar.append(svgEl('title', {}, [`${lo}–${hi}%: ${count} stories (${(100 * count / d.total).toFixed(1)}%) · click to browse`]));
    bar.addEventListener('click', () => openScoreBand(i / n, (i + 1) / n));
    svg.append(bar);
  });

  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const anchor = t === 0 ? 'start' : t === 1 ? 'end' : 'middle';
    svg.append(svgEl('text', { class: 'axis', x: PAD.l + t * plotW, y: H - 4, 'text-anchor': anchor }, [t === 0.5 ? '50% · unsure' : `${Math.round(t * 100)}%`]));
  }
  $('#brain-dist').replaceChildren(svg);

  const share = (lo, hi) => d.bins.reduce((acc, c, i) => (i / n >= lo && i / n < hi ? acc + c : acc), 0);
  const fmt = (k) => `${k} (${(100 * k / d.total).toFixed(1)}%)`;
  $('#brain-dist-note').replaceChildren(
    // Scores are percentages everywhere else the reader meets them — the feed
    // badge, the slider, the band chip — so they are percentages here too.
    `Of ${d.total} unvoted stories, ${fmt(share(0.7, 1.01))} score 70% or higher (orange). That is your slice of HN.`,
    el('br'),
    `${fmt(share(0.4, 0.6))} sit between 40% and 60%, where it has little to say, ` +
    `and ${fmt(share(0, 0.4))} score below 40% and sink to the bottom of For you. ` +
    `Bars are on a square-root scale so the tails stay visible. Click a bar to browse those stories.`,
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

// The row behind the cookie. Only the name is the user's to edit here; the
// email is the operator's handle for them and is shown so they know which
// address a login link would go to.
function renderMe(user) {
  const input = $('#me-name');
  // Never overwrite something being typed.
  if (document.activeElement !== input) input.value = user?.displayName ?? '';
  // "Signed in as" is followed by something that names you — the address
  // will do until there is a name — and "no name yet" is a note, never the
  // name.
  const handle = user?.displayName ?? user?.email;
  $('#me-note').textContent = !user
    ? ''
    : [
        handle ? `Signed in as ${handle}` : 'Signed in',
        user.displayName != null ? user.email : 'no name yet',
      ].filter(Boolean).join(' · ');
}

$('#me-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await saveDisplayName($('#me-name').value);
  } catch (err) {
    $('#me-note').textContent = err.message;
  }
});

// The two one-use links this panel can hand out: a login link for another of
// your own devices, and an invite for a friend. Each is a box with the URL and
// a copy button, and they differ only in what the link opens — so the showing
// and the copying is one function with a table of ids.
const LINK_BOXES = {
  device: {
    box: '#device-link', url: '#device-link-url',
    copy: '#btn-copy-link', note: '#device-link-note',
  },
  invite: {
    box: '#invite-link', url: '#invite-link-url',
    copy: '#btn-copy-invite', note: '#invite-link-note',
  },
};

// Shown once, and only here. The server knows the path and the browser knows
// the host: whoever it is going to gets the whole URL, because the other end
// cannot fill in the rest.
function showLink(which, path, note) {
  const b = LINK_BOXES[which];
  $(b.url).value = new URL(path, location.origin).href;
  $(b.copy).textContent = 'Copy link';
  $(b.note).textContent = note;
  $(b.box).hidden = false;
}

// Copying is a single tap, because the phone it is going to is in your other
// hand.
for (const b of Object.values(LINK_BOXES)) {
  $(b.copy).addEventListener('click', async (e) => {
    const input = $(b.url);
    try {
      await navigator.clipboard.writeText(input.value);
      e.target.textContent = 'Copied';
      setTimeout(() => { e.target.textContent = 'Copy link'; }, 2000);
    } catch {
      // No clipboard (plain http, an old browser): leave the link selected so
      // the long-press menu does the job.
      input.select?.();
      $(b.note).textContent = 'Copy failed — select the link and copy it by hand.';
    }
  });
}

// A link for another of your own devices. The server mints it for the account
// behind the cookie; it can only ever be for that account.
$('#btn-add-device').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  try {
    const { link } = await api('/api/me/link', { method: 'POST', body: {} });
    showLink('device', link.path,
      'Open this on the other device. It works once and expires in a week.');
  } catch (err) {
    $('#me-note').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------------------------- inviting a friend

   The one act in this app that makes another person an account, so it is not
   a button that mints on press. You have five invites; each one is a card you
   address first, and the row exists only when "Make the link" is submitted.

   The name you write is yours alone — the invitee never sees it — and its
   pay-off is the ledger below: once they arrive, the list shows what you
   called them beside the name they chose for themselves.

   It is the sender's half of the doorstep at the other end (`doorstep.html`),
   where the invitee presses to accept. Both halves are a deliberate press;
   neither is a page load. */

// Open the card. Nothing is minted here — this is stationery, not an invite.
$('#btn-invite').addEventListener('click', () => {
  $('#invite-start').hidden = true;
  $('#invite-compose').hidden = false;
  // A fresh card each time: the last friend's name is not a default for the
  // next one, and the last friend's link is put away. Two links on screen with
  // one of them stale is how the wrong one gets pasted.
  $('#invite-for').value = '';
  $('#btn-invite-make').disabled = true;
  $('#invite-note').textContent = '';
  $('#invite-link').hidden = true;
  $('#invite-for').focus?.();
});

function closeComposer() {
  $('#invite-compose').hidden = true;
  $('#invite-start').hidden = false;
}

$('#btn-invite-cancel').addEventListener('click', closeComposer);

// There is nothing to make until the invite is for somebody. Whitespace is
// not somebody, and the server trims it away too.
$('#invite-for').addEventListener('input', (e) => {
  $('#btn-invite-make').disabled = !(e.target.value ?? '').trim();
});

// The submit is the mint: one row, one link, shown once. Enter in the field
// gets here too, which is why the card is a form.
$('#invite-compose').addEventListener('submit', async (e) => {
  e.preventDefault();
  const note = $('#invite-for').value.trim();
  if (!note) return;
  const btn = $('#btn-invite-make');
  btn.disabled = true;
  try {
    const answer = await api('/api/me/invites', { method: 'POST', body: { note } });
    closeComposer();
    $('#invite-link-for').textContent = `For ${answer.invite.note ?? 'your friend'}`;
    showLink('invite', answer.invite.path,
      'Paste it into a chat. It works once, for one person, and expires in a week.');
    paintInvites(answer);
  } catch (err) {
    // The cap and the length limit included: the server's sentence is the one
    // to show, not a paraphrase of it.
    $('#invite-note').textContent = err.message;
    btn.disabled = false;
  }
});

// The invites you have sent. Fetched when Brain paints, like the charts above,
// and like them a failed fetch leaves the panel as it was.
async function loadInvites() {
  try {
    paintInvites(await api('/api/me/invites'));
  } catch {
    // Nothing to say: the rest of the panel stands.
  }
}

// The list and the tally always move together — every route that changes one
// answers with both, so there is no moment where the pips and the rows
// disagree.
function paintInvites({ invites, cap }) {
  renderInvites(invites);
  renderTally(cap);
}

// Five pips: how many invites you have left to give. The cap is a real limit
// (any user minting invites is any user minting users), and showing it beats
// letting somebody discover it by being refused — a spent pip is an outline
// rather than a gap, so the five stay countable.
function renderTally(cap) {
  if (!cap) return;
  const left = Math.max(0, Math.min(cap.max, cap.left));
  $('#invite-pips').replaceChildren(...Array.from({ length: cap.max }, (_, i) =>
    el('span', { className: i < left ? 'pip' : 'pip spent' })));
  $('#invite-tally-note').textContent = left
    ? `${plural(left, 'invite')} left to give`
    : 'All five are out — void one, or wait for one to be taken up';
  // Nothing to press when there is nothing left; the card would only lead to
  // a 409.
  $('#btn-invite').disabled = !left;
}

const now = () => Date.now() / 1000;

// What became of one invite, in the order the answer matters: who took it up,
// then why nobody can. A `redeemedAt` with no user is somebody since removed —
// the ledger keeps the event and loses the name.
//
// The nicest line here is the one where the two names differ: you wrote down
// "Anna, from work" and she calls herself something else. Both are true, and
// the ledger is the only place that knows it.
function inviteState(i) {
  if (i.redeemedAt) {
    if (!i.user) return `taken up ${ago(i.redeemedAt)} · that account is gone`;
    const chosen = i.user.displayName;
    const same = !i.note || !chosen || chosen === i.note;
    return same
      ? `joined ${ago(i.redeemedAt)}`
      : `joined ${ago(i.redeemedAt)} as ${chosen}`;
  }
  if (i.revokedAt) return `voided ${ago(i.revokedAt)}`;
  if (i.expiresAt <= now()) return 'expired, never opened';
  const days = Math.max(0, Math.round((i.expiresAt - now()) / 86400));
  return `unopened · ${days ? `${plural(days, 'day')} left` : 'expires today'}`;
}

// Who an invite was for: the name you wrote down, or — for one you sent before
// the card existed, or the operator's — whoever it turned out to be.
function inviteLabel(i) {
  return i.note ?? i.user?.displayName ?? 'Someone';
}

// One line per invite you have sent. The list is hidden when you have sent
// none, so the panel says nothing about a ledger until you have one.
function renderInvites(invites) {
  const list = $('#invite-list');
  list.hidden = !invites.length;
  list.replaceChildren(...invites.map((i) => {
    const row = el('li', {}, [el('span', {}, [
      el('b', {}, inviteLabel(i)),
      el('span', { className: 'muted' }, ` · ${inviteState(i)}`),
    ])]);
    // Only an unspent invite can be voided. The server checks it again — this
    // button is the affordance, not the rule.
    if (!i.redeemedAt && !i.revokedAt && i.expiresAt > now()) {
      const btn = el('button', { type: 'button' }, 'Void');
      btn.addEventListener('click', () => revokeInvite(i.id, btn));
      row.append(btn);
    }
    return row;
  }));
}

// Void a link before anyone opens it — the wrong chat, or a change of mind.
// The link box goes with it: the URL it is showing may be the voided one, and
// a copyable dead link is worse than no box.
async function revokeInvite(id, btn) {
  btn.disabled = true;
  try {
    const answer = await api(`/api/me/invites/${id}/revoke`, { method: 'POST', body: {} });
    $('#invite-link').hidden = true;
    paintInvites(answer);
  } catch (err) {
    $('#invite-note').textContent = err.message;
    btn.disabled = false;
  }
}

// This device only. The server clears the cookie; a reload then meets the
// 401 page, which says to open a login link.
$('#btn-logout').addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST', body: {} });
    location.reload();
  } catch (err) {
    $('#me-note').textContent = err.message;
  }
});

// Your votes are yours, so the export sits with the rest of you rather than
// with the corpus: it is one user's history, not the shared data.
$('#btn-export').addEventListener('click', async () => {
  try {
    const data = await api('/api/export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = el('a', { href: url, download: `rekorderlig-votes-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    $('#me-note').textContent = err.message;
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
