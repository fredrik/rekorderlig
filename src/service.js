/**
 * Glue between the database, the model and the HTTP API: training, scoring,
 * the ranked feed, and the "what should I vote on next" queue.
 */
import { featurize } from './features.js';
import { fit, toRuntime, scoreFeatures, crossValidate, insights } from './model.js';
import { labelledStories, voteCounts, getMeta, setMeta } from './db.js';

const MIN_VOTES_TO_TRAIN = 6;   // below this, both classes are usually not present
const CANDIDATE_CAP = 6000;

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

  const byTitle = new Map(); // voted_at ascending, so a later verdict overrides an earlier repost's
  for (const s of labelled) byTitle.set(titleKey(s.title), s);
  const examples = [...byTitle.values()].map((s) => ({ features: featurize(s), label: s.value > 0 ? 1 : 0 }));
  const model = fit(examples, options);
  const metrics = crossValidate(examples, options);

  const trainedAt = Math.floor(Date.now() / 1000);
  const info = conn.prepare('INSERT INTO models (trained_at, n_votes, payload) VALUES (?, ?, ?)')
    .run(trainedAt, examples.length, JSON.stringify({ model, metrics }));
  const rev = Number(info.lastInsertRowid);

  cache = { rev, trainedAt, nVotes: examples.length, runtime: toRuntime(model), model, metrics };
  const scored = rescoreAll(conn, cache);
  setMeta(conn, 'last_train_at', trainedAt);

  return { trained: true, rev, scored, metrics, counts, insights: insights(model) };
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

/** Score any freshly ingested stories without a full retrain. */
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

const SELECT_STORY = `
  SELECT s.id, s.title, s.url, s.domain, s.author, s.points, s.num_comments,
         s.created_at, s.day, sc.score, sc.confidence, v.value AS vote
  FROM stories s
  LEFT JOIN scores sc ON sc.story_id = s.id
  LEFT JOIN votes  v  ON v.story_id  = s.id
`;

function popularity(story, maxComments) {
  const denom = Math.log1p(Math.max(20, maxComments));
  return Math.log1p(story.num_comments ?? 0) / denom;
}

/**
 * The ranked feed.
 * @param {object} opts
 *  - mode: 'foryou' | 'hybrid' | 'top' | 'new'
 *  - days: how far back to look (default 7)
 *  - minScore: hide anything the model likes less than this (0..1)
 *  - includeVoted: keep already-judged stories in the list
 */
export function feed(conn, opts = {}) {
  const {
    mode = 'foryou', days = 7, minScore = 0, minComments = 0, limit = 50, offset = 0,
    includeVoted = false, day = null, query = null,
  } = opts;

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

  const rows = conn.prepare(
    `${SELECT_STORY} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} LIMIT ${CANDIDATE_CAP}`
  ).all(...params);

  const maxComments = rows.reduce((a, r) => Math.max(a, r.num_comments ?? 0), 0);
  const hasModel = Boolean(loadModel(conn)?.runtime);

  const enriched = rows.map((r) => ({
    ...r,
    score: r.score ?? null,
    confidence: r.confidence ?? 0,
    popularity: popularity(r, maxComments),
  }));

  const filtered = hasModel && minScore > 0
    ? enriched.filter((r) => (r.score ?? 0.5) >= minScore)
    : enriched;

  const sorters = {
    foryou: (a, b) => (b.score ?? 0.5) - (a.score ?? 0.5) || b.num_comments - a.num_comments,
    // Blends taste with the crowd, so the feed keeps some serendipity.
    hybrid: (a, b) => (0.7 * (b.score ?? 0.5) + 0.3 * b.popularity) - (0.7 * (a.score ?? 0.5) + 0.3 * a.popularity),
    top: (a, b) => b.num_comments - a.num_comments || b.points - a.points,
    new: (a, b) => b.created_at - a.created_at,
  };
  filtered.sort(sorters[mode] ?? sorters.foryou);

  return {
    total: filtered.length,
    hasModel,
    items: filtered.slice(offset, offset + limit),
  };
}

/**
 * What to show in the thumbs-up/down trainer.
 *
 * With no model: the most discussed stories first (fast, familiar signal).
 * With a model: mostly the titles it is least sure about — a vote there teaches
 * it the most — plus a slice of confident picks so the deck stays readable.
 */
const titleKey = (title) => String(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Collapse HN reposts: one card per URL / normalized title, keeping the most discussed. */
function dedupeStories(rows) {
  const best = new Map();
  for (const r of rows) {
    for (const key of [r.url && `u:${r.url}`, `t:${titleKey(r.title)}`]) {
      if (!key) continue;
      const cur = best.get(key);
      if (cur && cur !== r && (cur.num_comments ?? 0) >= (r.num_comments ?? 0)) { r.dropped = true; break; }
      if (cur && cur !== r) cur.dropped = true;
      best.set(key, r);
    }
  }
  return rows.filter((r) => !r.dropped);
}

export function trainingQueue(conn, { limit = 30, days = 30, explore = 0.35 } = {}) {
  const rows = dedupeStories(conn.prepare(`
    ${SELECT_STORY}
    WHERE v.value IS NULL AND s.created_at >= ?
    LIMIT ${CANDIDATE_CAP}
  `).all(Math.floor(Date.now() / 1000) - days * 86400));

  const current = loadModel(conn);
  if (!current?.runtime || rows.length === 0) {
    return rows.sort((a, b) => b.num_comments - a.num_comments).slice(0, limit)
      .map((r) => ({ ...r, reason: 'popular' }));
  }

  const uncertain = [...rows]
    .filter((r) => r.score != null)
    .sort((a, b) => Math.abs(a.score - 0.5) - Math.abs(b.score - 0.5));
  const popular = [...rows].sort((a, b) => b.num_comments - a.num_comments);

  const nExplore = Math.round(limit * explore);
  const picked = new Map();
  for (const r of uncertain) {
    if (picked.size >= limit - nExplore) break;
    picked.set(r.id, { ...r, reason: 'uncertain' });
  }
  for (const r of popular) {
    if (picked.size >= limit) break;
    if (!picked.has(r.id)) picked.set(r.id, { ...r, reason: 'popular' });
  }
  return [...picked.values()];
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
 * visible. Capped to the most recent `windowDays` — ingest never reaches
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

export function stats(conn) {
  const counts = voteCounts(conn);
  const storyCount = conn.prepare('SELECT COUNT(*) AS n FROM stories').get().n;
  const dayCount = conn.prepare('SELECT COUNT(DISTINCT day) AS n FROM stories').get().n;
  const current = loadModel(conn);
  return {
    stories: storyCount,
    days: dayCount,
    votes: counts,
    lastIngestAt: Number(getMeta(conn, 'last_ingest_at', 0)),
    model: current
      ? {
          rev: current.rev,
          trainedAt: current.trainedAt,
          nVotes: current.nVotes,
          metrics: current.metrics,
          features: current.model.names.length,
          insights: insights(current.model),
        }
      : null,
    minVotesToTrain: MIN_VOTES_TO_TRAIN,
  };
}

export function resetModelCache() { cache = { rev: -1, runtime: null, metrics: null }; }
