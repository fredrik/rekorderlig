/**
 * Glue between the database, the model and the HTTP API: training, scoring,
 * the ranked feed, and the "what should I vote on next" queue.
 */
import { featurize, describeFeature } from './features.js';
import { fit, toRuntime, scoreFeatures, crossValidate, insights, mulberry32 } from './model.js';
import { labelledStories, voteCounts, getMeta, setMeta, recordVote, capturePrediction } from './db.js';
import { syncDays, syncFrontPage, recentDays, daysBetween, dayKey } from './hn.js';

const MIN_VOTES_TO_TRAIN = 6;   // below this, both classes are usually not present

let cache = { rev: -1, runtime: null, metrics: null };

export function loadModel(conn) {
  const row = conn.prepare('SELECT rev, trained_at, n_votes, payload FROM models ORDER BY rev DESC LIMIT 1').get();
  if (!row) return null;
  if (cache.rev === row.rev) return cache;
  const payload = JSON.parse(row.payload);
  cache = {
    rev: row.rev,
    trainedAt: row.trained_at,
    nVotes: row.n_votes,
    runtime: toRuntime(payload.model),
    model: payload.model,
    metrics: payload.metrics,
  };
  return cache;
}

/** Retrain from every vote, store the snapshot, and rescore the whole corpus. */
export function trainAndScore(conn, options = {}) {
  const labelled = labelledStories(conn);
  const counts = voteCounts(conn);
  if (labelled.length < MIN_VOTES_TO_TRAIN || !labelled.some((s) => s.value > 0) || !labelled.some((s) => s.value < 0)) {
    return {
      trained: false,
      reason: 'need_more_votes',
      need: { up: Math.max(0, 3 - counts.up), down: Math.max(0, 3 - counts.down) },
      counts,
    };
  }

  // Every vote is an example. Two submissions of the same article are two
  // separate titles you read and judged, so they carry twice the weight on
  // purpose — the repeat is signal about phrasing, not a duplicate to collapse.
  const examples = labelled.map((s) => ({ id: s.id, features: featurize(s), label: s.value > 0 ? 1 : 0 }));
  const model = fit(examples, options);
  const metrics = crossValidate(examples, options);

  const trainedAt = Math.floor(Date.now() / 1000);
  // `heldOut` is one row per vote and lives in its own table; keeping it in the
  // payload too would grow every snapshot by the whole vote history.
  const { heldOut, ...rest } = metrics ?? {};
  const publicMetrics = metrics && rest;
  const info = conn.prepare('INSERT INTO models (trained_at, n_votes, payload) VALUES (?, ?, ?)')
    .run(trainedAt, examples.length, JSON.stringify({ model, metrics: publicMetrics }));
  const rev = Number(info.lastInsertRowid);
  storeHeldOut(conn, heldOut, rev);

  cache = { rev, trainedAt, nVotes: examples.length, runtime: toRuntime(model), model, metrics: publicMetrics };
  const scored = rescoreAll(conn, cache);
  setMeta(conn, 'last_train_at', trainedAt);

  return { trained: true, rev, scored, metrics: publicMetrics, counts, insights: insights(model) };
}

/**
 * Replace the held-out predictions with this revision's.
 *
 * Whole-table rewrite rather than an upsert: a vote that was removed since the
 * last train must not leave a stale row behind, and 386 rows is nothing. With
 * no cross-validation (too few votes for two folds) the table is simply empty —
 * better than serving predictions from a model that never held anything out.
 */
export function storeHeldOut(conn, heldOut, rev) {
  const stmt = conn.prepare('INSERT INTO oof_scores (story_id, score, model_rev) VALUES (?, ?, ?)');
  conn.exec('BEGIN');
  try {
    conn.exec('DELETE FROM oof_scores');
    for (const { id, score } of heldOut ?? []) stmt.run(id, score, rev);
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
  return heldOut?.length ?? 0;
}

export function rescoreAll(conn, current = cache) {
  if (!current?.runtime) return 0;
  const stories = conn.prepare('SELECT id, title, url, domain, author FROM stories').all();
  const stmt = conn.prepare(`
    INSERT INTO scores (story_id, score, confidence, model_rev) VALUES (?, ?, ?, ?)
    ON CONFLICT(story_id) DO UPDATE SET
      score = excluded.score, confidence = excluded.confidence, model_rev = excluded.model_rev
  `);
  conn.exec('BEGIN');
  try {
    for (const s of stories) {
      const { score, confidence } = scoreFeatures(current.runtime, featurize(s));
      stmt.run(s.id, score, confidence, current.rev);
    }
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
  return stories.length;
}

/**
 * Pull stories from HN into the database, then score whatever the current
 * model has not seen. The one way stories enter the database: give it either a
 * rolling window (`days`, default the last two) or an explicit range
 * (`from`/`to`, defaulting `to` to today), and it walks those days
 * oldest-first through `syncDays()`.
 *
 * Scoring is folded in on purpose — a story with no score is invisible to the
 * ranked feed, so "fetch" and "score the new arrivals" are one operation and
 * no caller has to remember the second half.
 *
 * The front page is fetched only when today is in scope, since that is the
 * only case where it can hold anything the day queries have not already seen.
 */
export async function sync(conn, { days, from, to, frontPage, now = new Date(), ...opts } = {}) {
  const today = dayKey(Math.floor(now.getTime() / 1000));
  const list = (from ? daysBetween(from, to ?? today) : recentDays(days ?? 2, now)).slice().sort();
  const countStories = () => conn.prepare('SELECT COUNT(*) AS n FROM stories').get().n;
  const before = countStories();
  const result = await syncDays(conn, list, opts);
  result.from = list[0];
  result.to = list[list.length - 1];
  result.frontPage = (frontPage ?? list.includes(today))
    ? await syncFrontPage(conn, { deps: opts.deps })
    : 0;
  result.fetched += result.frontPage;
  // syncDays counts its own inserts; recount so front-page arrivals are in it.
  result.inserted = countStories() - before;
  result.scored = scoreMissing(conn);
  setMeta(conn, 'last_sync_at', Math.floor(now.getTime() / 1000));
  return result;
}

/** Score any freshly fetched stories without a full retrain. */
export function scoreMissing(conn) {
  const current = loadModel(conn);
  if (!current?.runtime) return 0;
  const stories = conn.prepare(`
    SELECT s.id, s.title, s.url, s.domain, s.author FROM stories s
    LEFT JOIN scores sc ON sc.story_id = s.id
    WHERE sc.story_id IS NULL OR sc.model_rev != ?
  `).all(current.rev);
  const stmt = conn.prepare(`
    INSERT INTO scores (story_id, score, confidence, model_rev) VALUES (?, ?, ?, ?)
    ON CONFLICT(story_id) DO UPDATE SET
      score = excluded.score, confidence = excluded.confidence, model_rev = excluded.model_rev
  `);
  conn.exec('BEGIN');
  try {
    for (const s of stories) {
      const { score, confidence } = scoreFeatures(current.runtime, featurize(s));
      stmt.run(s.id, score, confidence, current.rev);
    }
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
  return stories.length;
}

const STORY_COLUMNS = `
  s.id, s.title, s.url, s.domain, s.author, s.points, s.num_comments,
  s.created_at, s.day, sc.score, sc.confidence, v.value AS vote
`;
const STORY_JOINS = `
  FROM stories s
  LEFT JOIN scores sc ON sc.story_id = s.id
  LEFT JOIN votes  v  ON v.story_id  = s.id
`;
const SELECT_STORY = `SELECT ${STORY_COLUMNS} ${STORY_JOINS}`;

/**
 * The ranked feed. Filtering, ordering and pagination all happen in SQL so
 * the result is exact however large the corpus grows (a backfilled archive
 * holds tens of thousands of stories; a JS-side candidate cap silently
 * dropped everything past it — and, without an ORDER BY, kept the oldest).
 *
 * @param {object} opts
 *  - mode: 'foryou' | 'hybrid' | 'top' | 'new'
 *  - days: how far back to look (default 7; 0 = everything)
 *  - minScore: hide anything the model likes less than this (0..1)
 *  - includeVoted: keep already-judged stories in the list
 */
export function feed(conn, opts = {}) {
  const {
    mode = 'foryou', days = 7, minScore = 0, maxScore = 1, minComments = 0, limit = 50, offset = 0,
    includeVoted = false, day = null, query = null,
  } = opts;
  const hasModel = Boolean(loadModel(conn)?.runtime);

  const where = [];
  const params = [];
  if (minComments > 0) { where.push('s.num_comments >= ?'); params.push(minComments); }
  if (day) { where.push('s.day = ?'); params.push(day); }
  else if (days > 0) {
    where.push('s.created_at >= ?');
    params.push(Math.floor(Date.now() / 1000) - days * 86400);
  }
  if (!includeVoted) where.push('(v.value IS NULL OR v.value = 0)');
  if (query) { where.push('LOWER(s.title) LIKE ?'); params.push(`%${String(query).toLowerCase()}%`); }
  // Never show unscored stories. A title the model has not looked at has no
  // business in a ranked feed, and pretending it is a 0.5 would leak it into
  // score bands. Before the first model that means an empty feed — the Train
  // tab is how you get past that. Unscored is transient otherwise: sync()
  // runs scoreMissing() on what it fetched before it returns.
  where.push('sc.score IS NOT NULL');
  if (minScore > 0) { where.push('sc.score >= ?'); params.push(minScore); }
  // Exclusive upper bound so adjacent histogram buckets don't overlap; 1 means "no cap".
  if (maxScore < 1) { where.push('sc.score < ?'); params.push(maxScore); }

  const scope = `${STORY_JOINS} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const total = conn.prepare(`SELECT COUNT(*) AS n ${scope}`).get(...params).n;

  let orderBy;
  const orderParams = [];
  switch (mode) {
    case 'top': orderBy = 's.num_comments DESC, s.points DESC'; break;
    case 'new': orderBy = 's.created_at DESC'; break;
    case 'hybrid': {
      // Blends taste with the crowd, so the feed keeps some serendipity.
      // Popularity is log-scaled relative to the busiest story in scope.
      const maxComments = conn.prepare(`SELECT MAX(s.num_comments) AS m ${scope}`).get(...params).m ?? 0;
      orderBy = '0.7 * sc.score + 0.3 * ln(1 + s.num_comments) / ? DESC';
      orderParams.push(Math.log1p(Math.max(20, maxComments)));
      break;
    }
    default: orderBy = 'sc.score DESC, s.num_comments DESC';
  }

  const rows = conn.prepare(
    `SELECT ${STORY_COLUMNS} ${scope} ORDER BY ${orderBy}, s.id DESC LIMIT ? OFFSET ?`
  ).all(...params, ...orderParams, limit, offset);

  return {
    total,
    hasModel,
    items: rows.map((r) => ({ ...r, score: r.score ?? null, confidence: r.confidence ?? 0 })),
  };
}

/**
 * Every vote, newest verdict first — the "my votes" list.
 *
 * Filtering and paging stay in SQL, like the feed. `value` is 1 / -1 / 0 to
 * show one verdict only, or null for all of them. Skips are votes too, so
 * they are included unless filtered out.
 */
export function voteLog(conn, { value = null, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (value != null) { where.push('v.value = ?'); params.push(value); }

  // Driven from `votes`, so this is an inner join, unlike the feed's joins.
  const scope = `
    FROM votes v
    JOIN stories s ON s.id = v.story_id
    LEFT JOIN scores sc ON sc.story_id = s.id
    LEFT JOIN oof_scores oof ON oof.story_id = s.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
  const total = conn.prepare(`SELECT COUNT(*) AS n ${scope}`).get(...params).n;
  const rows = conn.prepare(
    `SELECT ${STORY_COLUMNS}, v.updated_at AS voted_at, oof.score AS oof_score
     ${scope} ORDER BY v.updated_at DESC, v.story_id DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  return { total, counts: voteCounts(conn), items: rows };
}

/* --------------------------------------------------------- training queue */

// A swipe is only worth spending if the submission was worth reading. HN's
// long tail of one- and two-point posts is mostly links nobody opened, and at
// archive scale it is *most* of the corpus — without a floor the deck fills
// with dead weight from 2021. Ten is deliberately steep; raising the pool
// later is a one-line change, unlearning a thousand votes on junk is not.
const QUEUE_MIN_POINTS = 10;

// `scores` holds the shrunk score: 0.5 + (raw - 0.5) * (0.3 + 0.7 * confidence)
// (model.js). So ordering by |score - 0.5| ranks by *ignorance*, not by
// uncertainty — a title with no known words is pushed onto the boundary and
// outranks one the model knows well and still cannot call. Undoing the
// shrinkage recovers the honest distance, and costs nothing: both halves are
// stored. Signed, so a range seek around 0 is a seek around "undecided", and
// idx_scores_raw_offset indexes exactly this expression.
const RAW_OFFSET = '((sc.score - 0.5) / (0.3 + 0.7 * sc.confidence))';
const rawOffset = (r) => (r.score - 0.5) / (0.3 + 0.7 * r.confidence);

const BOUNDARY_BAND = 0.15;           // how far from 0.5 still counts as undecided
const BOUNDARY_MIN_CONFIDENCE = 0.4;  // below this, hesitation is just an unread word
const NOVEL_MAX_CONFIDENCE = 0.4;     // the other end: titles with no vocabulary at all
const RECENT_DAYS = 3;
const MAX_PROBES = 8;                 // seeded probes per slot before giving up on a stratum
// A seek lands on the first row past its target, so where a band holds few
// distinct scores every target in a gap collapses onto the same row and the
// next page redraws the last one. Stepping each page a little further past the
// target breaks that tie. Bounded and tiny: an index scan of a few rows.
const PAGE_STEP = 8;

// LIMIT and OFFSET are written into the SQL, never bound. A bound limit is
// opaque to the planner, which then sorts the whole candidate set instead of
// keeping a bounded top-N — measured at 21 ms against a million rows where the
// same query with a literal limit costs 0.4 ms. `int()` is what keeps that
// safe: every interpolated number goes through it.
const int = (n) => {
  const v = Math.trunc(Number(n));
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`bad row count: ${n}`);
  return v;
};

// Every stratum drives from `scores` rather than from `stories`, so the
// planner can open an expression index and seek instead of scanning. That is
// the whole scalability story: a batch costs ~`limit` index seeks whether the
// archive holds ten thousand stories or ten million.
const SCORED_FROM = `
  FROM scores sc
  JOIN stories s ON s.id = sc.story_id
  LEFT JOIN votes v ON v.story_id = s.id
`;

/**
 * The deck is drawn from four strata, each answering a different question.
 * Shares are of `limit`; a stratum that comes up short is backfilled from the
 * boundary. None of them is ordered by recency — that is what stops a deck
 * from clustering on whichever days happen to be newest.
 */
const STRATA = [
  // Where a vote moves the weights most: the model knows the words and still
  // cannot decide.
  { reason: 'boundary', share: 0.4, draw: drawBoundary },
  // Vocabulary growth. The old queue did this with every slot, by accident;
  // here it gets a budget.
  { reason: 'novel', share: 0.2, draw: drawNovel },
  // At archive scale today is a rounding error. A news app that never shows
  // the news is broken however well it ranks.
  { reason: 'recent', share: 0.2, draw: drawRecent },
  // Uniform over the whole history: the only labels not selected by what the
  // model already believes, and so the only ones that can catch a blind spot
  // it does not know it has.
  { reason: 'explore', share: 0.2, draw: drawExplore },
];

/**
 * What to show in the thumbs-up/down trainer.
 *
 * With no model: the most discussed stories first (fast, familiar signal).
 * With one: a stratified sample, seeded on the model revision so a refill
 * mid-swipe does not reshuffle the cards behind the one on screen. `cursor`
 * walks that stream for the next page.
 */
export function trainingQueue(conn, { limit = 12, cursor = 0, minPoints = QUEUE_MIN_POINTS } = {}) {
  const current = loadModel(conn);
  if (!current?.runtime) return coldQueue(conn, limit, minPoints);

  const rng = mulberry32((Math.imul(current.rev, 0x9e3779b1) + Math.imul(cursor + 1, 0x85ebca6b)) >>> 0);
  const picked = new Map();
  const quotas = allocate(limit, STRATA.map((s) => s.share));
  const buckets = STRATA.map((stratum, i) => (quotas[i] === 0 ? [] :
    stratum.draw(conn, { quota: quotas[i], picked, rng, minPoints, cursor })
      .map((r) => ({ ...r, reason: stratum.reason }))));

  const out = interleave(buckets, limit);
  if (out.length < limit) out.push(...backfill(conn, limit - out.length, picked, minPoints));
  return out;
}

/** Before any model exists there is nothing to be uncertain about. */
function coldQueue(conn, limit, minPoints) {
  return conn.prepare(`
    ${SELECT_STORY}
    WHERE v.value IS NULL AND s.points >= ?
    ORDER BY s.num_comments DESC, s.id DESC
    LIMIT ${int(limit)}
  `).all(minPoints).map((r) => ({ ...r, reason: 'popular' }));
}

/**
 * Draw `quota` rows by seeded probe: pick a random key, seek the first
 * unjudged story at or past it. Sampling by *key* rather than by row offset is
 * what keeps this O(log n) — counting the band first would be the one query
 * that scans it. A probe past the end wraps to the band's floor.
 */
function probe(quota, picked, once) {
  const rows = [];
  let attempts = 0;
  let misses = 0;
  while (rows.length < quota && attempts < quota * MAX_PROBES) {
    attempts++;
    const row = once();
    // Two empty seeks in a row means the stratum itself is empty, not that we
    // were unlucky: stop rather than burn the whole probe budget on it.
    if (!row) { if (++misses >= 2) break; continue; }
    misses = 0;
    if (picked.has(row.id)) continue;
    picked.set(row.id, row);
    rows.push(row);
  }
  return rows;
}

/** Take up to `quota` not-yet-picked rows from an ordered list. */
function take(rows, quota, picked) {
  const out = [];
  for (const r of rows) {
    if (out.length >= quota) break;
    if (picked.has(r.id)) continue;
    picked.set(r.id, r);
    out.push(r);
  }
  return out;
}

function drawBoundary(conn, { quota, picked, rng, minPoints, cursor }) {
  const stmt = conn.prepare(`
    SELECT ${STORY_COLUMNS} ${SCORED_FROM}
    WHERE ${RAW_OFFSET} >= ? AND ${RAW_OFFSET} <= ?
      AND sc.confidence >= ? AND s.points >= ? AND v.value IS NULL
    ORDER BY ${RAW_OFFSET}
    LIMIT 1 OFFSET ${int(cursor % PAGE_STEP)}
  `);
  const first = conn.prepare(`
    SELECT ${STORY_COLUMNS} ${SCORED_FROM}
    WHERE ${RAW_OFFSET} >= ? AND ${RAW_OFFSET} <= ?
      AND sc.confidence >= ? AND s.points >= ? AND v.value IS NULL
    ORDER BY ${RAW_OFFSET}
    LIMIT 1
  `);
  const args = [BOUNDARY_BAND, BOUNDARY_MIN_CONFIDENCE, minPoints];
  const seek = (from) => stmt.get(from, ...args) ?? first.get(from, ...args);
  return probe(quota, picked, () => seek((rng() * 2 - 1) * BOUNDARY_BAND) ?? seek(-BOUNDARY_BAND));
}

function drawNovel(conn, { quota, picked, rng, minPoints, cursor }) {
  const stmt = conn.prepare(`
    SELECT ${STORY_COLUMNS} ${SCORED_FROM}
    WHERE sc.confidence >= ? AND sc.confidence < ?
      AND s.points >= ? AND v.value IS NULL
    ORDER BY sc.confidence
    LIMIT 1 OFFSET ${int(cursor % PAGE_STEP)}
  `);
  const first = conn.prepare(`
    SELECT ${STORY_COLUMNS} ${SCORED_FROM}
    WHERE sc.confidence >= ? AND sc.confidence < ?
      AND s.points >= ? AND v.value IS NULL
    ORDER BY sc.confidence
    LIMIT 1
  `);
  const seek = (from) => stmt.get(from, NOVEL_MAX_CONFIDENCE, minPoints)
    ?? first.get(from, NOVEL_MAX_CONFIDENCE, minPoints);
  return probe(quota, picked, () => seek(rng() * NOVEL_MAX_CONFIDENCE) ?? seek(0));
}

/**
 * The one stratum that is ranked, not sampled: today's deck, best first.
 * The page offset cycles with PAGE_STEP rather than climbing forever — the
 * recent window is only a few thousand stories wide, and an offset that ran
 * past its end would quietly stop showing the news after a dozen refills.
 */
function drawRecent(conn, { quota, picked, minPoints, cursor }) {
  const rows = conn.prepare(`
    ${SELECT_STORY}
    WHERE v.value IS NULL AND s.created_at >= ? AND s.points >= ?
    ORDER BY s.num_comments DESC, s.id DESC
    LIMIT ${int(quota * 3)} OFFSET ${int((cursor % PAGE_STEP) * quota)}
  `).all(Math.floor(Date.now() / 1000) - RECENT_DAYS * 86400, minPoints);
  return take(rows, quota, picked);
}

/**
 * Uniform over the whole archive. HN ids climb monotonically with time, so a
 * uniform draw over the id range is a uniform draw over history — and the
 * primary key makes each one a single seek, however many years are stored.
 */
function drawExplore(conn, { quota, picked, rng, minPoints, cursor }) {
  // One statement asking for both MIN and MAX scans the table; SQLite only
  // rewrites a lone MIN or a lone MAX into an index lookup. Two queries, 23 ms
  // saved per deck against a million rows.
  const lo = conn.prepare('SELECT MIN(id) AS v FROM stories').get()?.v;
  const hi = conn.prepare('SELECT MAX(id) AS v FROM stories').get()?.v;
  if (lo == null || hi == null) return [];
  const stmt = conn.prepare(`
    ${SELECT_STORY}
    WHERE s.id >= ? AND s.points >= ? AND v.value IS NULL
    ORDER BY s.id
    LIMIT 1 OFFSET ${int(cursor % PAGE_STEP)}
  `);
  const first = conn.prepare(`
    ${SELECT_STORY}
    WHERE s.id >= ? AND s.points >= ? AND v.value IS NULL
    ORDER BY s.id
    LIMIT 1
  `);
  const seek = (from) => stmt.get(from, minPoints) ?? first.get(from, minPoints);
  return probe(quota, picked, () => seek(lo + Math.floor(rng() * (hi - lo + 1))) ?? seek(lo));
}

/**
 * Fill a short batch from the boundary outwards. Two one-sided seeks merged in
 * JS, rather than `ORDER BY abs(...)`: abs() cannot use the index, and this
 * path exists precisely for the case where the strata came up empty — a young
 * model over a large archive, where a scan would hurt most.
 */
function backfill(conn, need, picked, minPoints) {
  const want = need + picked.size;
  const side = (cmp, dir) => conn.prepare(`
    SELECT ${STORY_COLUMNS} ${SCORED_FROM}
    WHERE ${RAW_OFFSET} ${cmp} 0 AND s.points >= ? AND v.value IS NULL
    ORDER BY ${RAW_OFFSET} ${dir}
    LIMIT ${int(want)}
  `).all(minPoints);
  const merged = [...side('>=', 'ASC'), ...side('<', 'DESC')]
    .sort((a, b) => Math.abs(rawOffset(a)) - Math.abs(rawOffset(b)));
  return take(merged, need, picked).map((r) => ({ ...r, reason: 'boundary' }));
}

/**
 * Split `limit` into whole cards by share, largest remainder first, so the
 * parts sum to exactly the limit. Rounding each share on its own overshoots —
 * a deck of 8 asked for 3+2+2+2, and the ninth card was then truncated off the
 * end, quietly turning a 40/20/20/20 split into 25/25/25/25. Small decks are
 * where that distortion bites, which is exactly the size we now ask for.
 */
function allocate(limit, shares) {
  const exact = shares.map((share) => limit * share);
  const counts = exact.map(Math.floor);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  let left = limit - counts.reduce((a, b) => a + b, 0);
  for (let k = 0; left > 0; k++, left--) counts[order[k % order.length].i]++;
  return counts;
}

/** Round-robin, so the deck never comes out in blocks of one stratum. */
function interleave(buckets, limit) {
  const out = [];
  for (let i = 0; out.length < limit; i++) {
    let drained = true;
    for (const b of buckets) {
      if (i >= b.length) continue;
      drained = false;
      out.push(b[i]);
      if (out.length >= limit) return out;
    }
    if (drained) break;
  }
  return out;
}

export function explain(conn, storyId) {
  const story = conn.prepare('SELECT * FROM stories WHERE id = ?').get(storyId);
  if (!story) return null;
  const current = loadModel(conn);
  if (!current?.runtime) return { story, score: null, contributions: [] };
  const res = scoreFeatures(current.runtime, featurize(story), { explain: true });
  return {
    story,
    score: res.score,
    raw: res.raw,
    confidence: res.confidence,
    coverage: res.coverage,
    contributions: res.contributions.slice(0, 10),
  };
}

/**
 * Per-day story counts, with gap days filled in as zero so thin coverage is
 * visible. Capped to the most recent `windowDays` — a sync never reaches
 * further back, and a single stray old story (a repost with an ancient
 * created_at) would otherwise stretch the chart into a sea of empty days.
 * Anything before the window is summarised in `older` instead of drawn.
 */
export function storiesPerDay(conn, { windowDays = 60 } = {}) {
  const rows = conn.prepare('SELECT day, COUNT(*) AS count FROM stories GROUP BY day ORDER BY day').all();
  if (rows.length === 0) return { days: [], older: null };

  const lastDay = rows[rows.length - 1].day;
  const start = new Date(`${lastDay}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - (windowDays - 1));
  const cutoff = start.toISOString().slice(0, 10);

  const inWindow = rows.filter((r) => r.day >= cutoff);
  const olderRows = rows.filter((r) => r.day < cutoff);

  const byDay = new Map(inWindow.map((r) => [r.day, r.count]));
  const out = [];
  const last = new Date(`${lastDay}T00:00:00Z`);
  for (let d = new Date(`${inWindow[0].day}T00:00:00Z`); d <= last; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = d.toISOString().slice(0, 10);
    out.push({ day, count: byDay.get(day) ?? 0 });
  }

  return {
    days: out,
    older: olderRows.length
      ? {
          days: olderRows.length,
          stories: olderRows.reduce((sum, r) => sum + r.count, 0),
          before: inWindow[0].day,
        }
      : null,
  };
}

// How the current model's scores spread across the corpus: unvoted stories
// per SCORE_BINS equal-width bucket over [0, 1]. The user's own votes are
// left out — they are the training set and sit pinned at the extremes, and
// the unvoted population is what the feed actually has to offer. Bins the
// stored (shrunk) score because that is what the feed sorts by.
// Done in SQL: ~70k rows bucket in a few ms.
export const SCORE_BINS = 20;

export function scoreDistribution(conn) {
  const rev = loadModel(conn)?.rev;
  if (rev == null) return null;
  // score = 1.0 would land in bin 20; clamp it into the top bin.
  const rows = conn.prepare(`
    SELECT MIN(CAST(s.score * ${SCORE_BINS} AS INTEGER), ${SCORE_BINS - 1}) AS bin, COUNT(*) AS n
    FROM scores s LEFT JOIN votes v ON v.story_id = s.story_id
    WHERE s.model_rev = ? AND v.story_id IS NULL
    GROUP BY bin`).all(rev);
  const bins = new Array(SCORE_BINS).fill(0);
  let total = 0;
  for (const r of rows) { bins[r.bin] = r.n; total += r.n; }
  return { bins, total, rev };
}

export function stats(conn) {
  const counts = voteCounts(conn);
  const storyCount = conn.prepare('SELECT COUNT(*) AS n FROM stories').get().n;
  const dayCount = conn.prepare('SELECT COUNT(DISTINCT day) AS n FROM stories').get().n;
  const current = loadModel(conn);
  return {
    stories: storyCount,
    days: dayCount,
    votes: counts,
    lastSyncAt: Number(getMeta(conn, 'last_sync_at', 0)),
    model: current
      ? {
          rev: current.rev,
          trainedAt: current.trainedAt,
          nVotes: current.nVotes,
          metrics: current.metrics,
          features: current.model.names.length,
          insights: insights(current.model),
          distribution: scoreDistribution(conn),
        }
      : null,
    minVotesToTrain: MIN_VOTES_TO_TRAIN,
  };
}

/**
 * Which parts of this title the model has never seen. These are what the next
 * retrain will actually learn from the vote — the direct, causal answer to
 * "what did that swipe do", and a count that only ever goes up.
 *
 * Style features (`t:`) are excluded: they match every title (is-a-question,
 * has-a-number) and were never news. Words come before phrases and sites
 * because a word reads as something you taught it; "6mb rust+tauri" reads as
 * machinery.
 */
const SIGNAL_ORDER = { w: 0, dom: 1, by: 2, tld: 3, b: 4 };
export function newSignals(conn, story, runtime, limit = 3) {
  const fresh = [];
  for (const [name] of featurize(story)) {
    if (name === '__bias__' || name.startsWith('t:')) continue;
    if (!runtime.index.has(name)) fresh.push(name);
  }
  fresh.sort((a, b) => (SIGNAL_ORDER[a.split(':')[0]] ?? 9) - (SIGNAL_ORDER[b.split(':')[0]] ?? 9));
  return {
    count: fresh.length,
    labels: [...new Set(fresh.map((n) => describeFeature(n).label))].slice(0, limit),
  };
}

/**
 * Record a vote and report what the model had guessed about it, and what the
 * vote gives it that it did not have. The capture happens first, on purpose:
 * a moment later the retrain will have memorised this story, and the score in
 * `scores` will only restate the verdict.
 *
 * The trainer card shows this *after* the swipe, never before — a prediction
 * on screen while you are deciding anchors the label it is trying to collect.
 */
export function judge(conn, storyId, value) {
  const captured = capturePrediction(conn, storyId);
  const story = conn.prepare('SELECT * FROM stories WHERE id = ?').get(storyId);
  const current = loadModel(conn);
  recordVote(conn, storyId, value);

  // A skip is not a verdict and not a training example: nothing for a guess to
  // be right about, and nothing taught.
  if (value === 0) return { prediction: null, taught: null };
  return {
    prediction: captured ? { ...captured, agreed: (captured.score >= 0.5) === (value > 0) } : null,
    taught: current?.runtime && story ? newSignals(conn, story, current.runtime) : null,
  };
}

/**
 * Accuracy across every model revision — the "is it actually getting better?"
 * curve. Metrics are read out of the stored payload with json_extract rather
 * than by parsing every snapshot in JS: a snapshot carries the whole weight
 * vector, and there is one per retrain.
 *
 * Revisions are thinned to `limit` points by taking every nth, so a long
 * history draws as a trend instead of a wall.
 */
export function modelHistory(conn, { limit = 60 } = {}) {
  const total = conn.prepare('SELECT COUNT(*) AS n FROM models').get().n;
  if (!total) return { points: [], revs: 0 };
  const step = Math.max(1, Math.ceil(total / limit));
  const points = conn.prepare(`
    SELECT rev, trained_at AS trainedAt, n_votes AS votes,
           json_extract(payload, '$.metrics.accuracy') AS accuracy,
           json_extract(payload, '$.metrics.baseline') AS baseline,
           json_extract(payload, '$.metrics.auc') AS auc,
           json_array_length(json_extract(payload, '$.model.names')) AS features
    FROM models
    WHERE rev % ${int(step)} = 0 OR rev = (SELECT MAX(rev) FROM models)
    ORDER BY rev
  `).all().filter((p) => p.accuracy != null);
  return { points, revs: total };
}

export function resetModelCache() { cache = { rev: -1, runtime: null, metrics: null }; }
