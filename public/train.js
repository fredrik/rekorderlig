/* Train: the round deck (`loadRound()`, `finishRound()`, the summary) —
   rounds of cards drawn from one model revision, judged, then one retrain
   at the boundary. */

import { register } from './registry.js';
import { refreshStats, renderTagline } from './chrome.js';
import { $, api, el } from './dom.js';
import { pct, plural } from './format.js';
import { bindRead, storyHref, titleKind } from './read.js';
import { needMore, showReveal } from './reveal.js';
import { state } from './state.js';
import { setTrainStatus } from './status.js';

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
      el('div', { className: 'muted' }, 'The hourly fetch will bring in more.'),
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
    // Following the title marks the story read, here as in the feed: a card
    // you clicked through is one the feed need not offer again. The card
    // itself never shows the mark — a deck asks for a judgement, not a visit.
    bindRead(el('a', {
      className: 'trainer-title',
      href: storyHref(story),
      target: '_blank', rel: 'noreferrer',
    }, story.title), story, titleKind(story)),
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

export async function vote(value) {
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

// Both decks carry the same judge row; the section it sits in says which
// queue it moves.
for (const btn of document.querySelectorAll('#view-train .judge button')) {
  btn.addEventListener('click', () => vote(Number(btn.dataset.vote)));
}

// The round in flight lives on the server, so opening Train resumes it rather
// than dealing again.
register('train', {
  show: () => { if (state.queue.length === 0) loadRound(); },
});
