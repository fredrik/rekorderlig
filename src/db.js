import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEFAULT_PATH = process.env.REKORDERLIG_DB
  ? resolve(process.env.REKORDERLIG_DB)
  : resolve(process.cwd(), 'data', 'rekorderlig.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stories (
  id            INTEGER PRIMARY KEY,      -- Hacker News item id
  title         TEXT    NOT NULL,
  url           TEXT,
  domain        TEXT,
  author        TEXT,
  points        INTEGER NOT NULL DEFAULT 0,
  num_comments  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,         -- unix seconds, story creation
  day           TEXT    NOT NULL,         -- YYYY-MM-DD (UTC) for day grouping
  fetched_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stories_day ON stories(day);
CREATE INDEX IF NOT EXISTS idx_stories_created ON stories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stories_comments ON stories(num_comments DESC);
-- Reposts are collapsed at read time (service.js), so nothing looks stories up
-- by URL any more; the index only cost us writes on every sync.
DROP INDEX IF EXISTS idx_stories_url;

-- One row per judged story. value: 1 = thumb up, -1 = thumb down, 0 = skipped.
CREATE TABLE IF NOT EXISTS votes (
  story_id   INTEGER PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
  value      INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_votes_created ON votes(created_at DESC);

-- Cached model scores so the feed can be sorted in SQL.
CREATE TABLE IF NOT EXISTS scores (
  story_id   INTEGER PRIMARY KEY REFERENCES stories(id) ON DELETE CASCADE,
  score      REAL NOT NULL,               -- probability of "thumb up", 0..1
  confidence REAL NOT NULL DEFAULT 0,     -- 0..1, how much evidence backs the score
  model_rev  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_score ON scores(score DESC);

-- Serialised model snapshots (weights + metrics), newest revision wins.
CREATE TABLE IF NOT EXISTS models (
  rev        INTEGER PRIMARY KEY AUTOINCREMENT,
  trained_at INTEGER NOT NULL,
  n_votes    INTEGER NOT NULL,
  payload    TEXT NOT NULL                -- JSON: weights, vocab, metrics
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let handle = null;

/** Where the process-wide connection lives; workers open their own connection here. */
export function dbPath() { return DEFAULT_PATH; }

/** The process-wide connection (server and CLI). Always opens DEFAULT_PATH. */
export function db() {
  if (!handle) handle = openDb(DEFAULT_PATH);
  return handle;
}

/** Open an independent connection to `path` (tests, tooling). */
export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode = WAL');
  // An out-of-band job (npm run sync) may write while the server is
  // serving; with WAL that only ever means waiting out a short transaction.
  conn.exec('PRAGMA busy_timeout = 5000');
  conn.exec('PRAGMA foreign_keys = ON');
  conn.exec(SCHEMA);
  return conn;
}

export function closeDb() {
  if (handle) { handle.close(); handle = null; }
}

export function getMeta(conn, key, fallback = null) {
  const row = conn.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setMeta(conn, key, value) {
  conn.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

export function upsertStory(conn, s) {
  conn.prepare(`
    INSERT INTO stories (id, title, url, domain, author, points, num_comments, created_at, day, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      url = excluded.url,
      domain = excluded.domain,
      points = MAX(stories.points, excluded.points),
      num_comments = MAX(stories.num_comments, excluded.num_comments),
      fetched_at = excluded.fetched_at
  `).run(
    s.id, s.title, s.url ?? null, s.domain ?? null, s.author ?? null,
    s.points | 0, s.num_comments | 0, s.created_at | 0, s.day, s.fetched_at | 0
  );
}

// A vote is recorded against exactly the submission that was judged. Reposts of
// the same URL are NOT co-signed: the model reads titles, and a twin's title is
// one you never saw. Duplicates are collapsed where they show up instead — the
// training queue (service.js) offers one card per URL / title.
export function recordVote(conn, storyId, value, now = Math.floor(Date.now() / 1000)) {
  conn.prepare(`
    INSERT INTO votes (story_id, value, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(story_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(storyId, value | 0, now, now);
}

// Restoring a vote from an old history: unlike recordVote, the supplied
// timestamp wins on conflict — re-running an import must converge on what the
// export says, not on whenever the first attempt happened to run.
export function importVote(conn, storyId, value, createdAt) {
  conn.prepare(`
    INSERT INTO votes (story_id, value, created_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(story_id) DO UPDATE SET
      value = excluded.value,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at
  `).run(storyId, value | 0, createdAt, Math.floor(Date.now() / 1000));
}

export function deleteVote(conn, storyId) {
  conn.prepare('DELETE FROM votes WHERE story_id = ?').run(storyId);
}

/** Every labelled story (skips excluded) — the model's training set. */
export function labelledStories(conn) {
  return conn.prepare(`
    SELECT s.*, v.value, v.created_at AS voted_at
    FROM votes v JOIN stories s ON s.id = v.story_id
    WHERE v.value != 0
    ORDER BY v.created_at ASC
  `).all();
}

export function voteCounts(conn) {
  const rows = conn.prepare('SELECT value, COUNT(*) AS n FROM votes GROUP BY value').all();
  const out = { up: 0, down: 0, skip: 0 };
  for (const r of rows) {
    if (r.value > 0) out.up = r.n;
    else if (r.value < 0) out.down = r.n;
    else out.skip = r.n;
  }
  out.total = out.up + out.down + out.skip;
  return out;
}
