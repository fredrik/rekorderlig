import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { db, recordVote, deleteVote, getMeta, setMeta, voteCounts } from './db.js';
import { ingest, MIN_POINTS } from './hn.js';
import {
  trainAndScore, scoreMissing, feed, trainingQueue, explain, stats, loadModel, storiesPerDay,
} from './service.js';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const conn = db();

/**
 * Optional single-user auth for public hosting. When AUTH_TOKEN is set, every
 * request must carry it — as a Bearer header, or once as ?token=… (the server
 * then sets a cookie so phones only need the tokened link one time).
 * Unset (the localhost/Tailscale case) means no auth, same as before.
 */
const COOKIE = 'rk_token';

function authorize(req, res, url) {
  const expected = process.env.AUTH_TOKEN;
  if (!expected) return true;

  const header = req.headers.authorization ?? '';
  if (header === `Bearer ${expected}`) return true;

  const cookies = Object.fromEntries(
    (req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=').map(decodeURIComponent))
  );
  if (cookies[COOKIE] === expected) return true;

  if (url.searchParams.get('token') === expected) {
    res.setHeader('set-cookie',
      `${COOKIE}=${encodeURIComponent(expected)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax; Secure`);
    return true;
  }

  send(res, 401, url.pathname.startsWith('/api/')
    ? { error: 'unauthorized' }
    : 'Unauthorized. Open the link that includes your ?token=…', {
      'content-type': url.pathname.startsWith('/api/') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    });
  return false;
}

/** Retrain often while the model is young, less often once it has settled. */
function retrainIfNeeded(force = false) {
  const counts = voteCounts(conn);
  const labelled = counts.up + counts.down;
  const since = labelled - Number(getMeta(conn, 'votes_at_last_train', 0));
  const every = labelled < 50 ? 1 : labelled < 200 ? 2 : 5;
  if (!force && since < every) return { trained: false, reason: 'debounced', pending: since };
  const started = Date.now();
  const result = trainAndScore(conn);
  if (result.trained) {
    setMeta(conn, 'votes_at_last_train', labelled);
    result.ms = Date.now() - started;
  }
  return result;
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('payload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('invalid JSON body');
  }
}

// Section paths the front end routes client-side; each serves the app shell
// so /feed etc. survive a refresh or work as a bookmark.
const APP_PATHS = new Set(['/', '/train', '/feed', '/brain']);

async function serveStatic(req, res, pathname) {
  const rel = normalize(APP_PATHS.has(pathname) ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': body.length,
    });
    res.end(body);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

const num = (v, fallback) => (v == null || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v));
const bool = (v) => v === '1' || v === 'true';

let ingestInFlight = null;

// Sentinel a handler returns after writing the response itself.
const SENT = Symbol('sent');

const routes = {
  'GET /api/stats': () => stats(conn),

  'GET /api/days': () => storiesPerDay(conn),

  'GET /api/feed': (url) => feed(conn, {
    mode: url.searchParams.get('mode') ?? 'foryou',
    days: num(url.searchParams.get('days'), 7),
    minScore: num(url.searchParams.get('minScore'), 0),
    minComments: num(url.searchParams.get('minComments'), 0),
    limit: Math.min(200, num(url.searchParams.get('limit'), 50)),
    offset: num(url.searchParams.get('offset'), 0),
    includeVoted: bool(url.searchParams.get('includeVoted')),
    day: url.searchParams.get('day'),
    query: url.searchParams.get('q'),
  }),

  'GET /api/queue': (url) => ({
    items: trainingQueue(conn, {
      limit: Math.min(100, num(url.searchParams.get('limit'), 25)),
      days: num(url.searchParams.get('days'), 30),
    }),
    hasModel: Boolean(loadModel(conn)?.runtime),
  }),

  'POST /api/vote': async (url, req) => {
    const { id, value } = await readBody(req);
    const storyId = Number(id);
    if (!Number.isInteger(storyId)) throw Object.assign(new Error('id required'), { status: 400 });
    if (![1, -1, 0].includes(Number(value))) throw Object.assign(new Error('value must be 1, -1 or 0'), { status: 400 });
    const exists = conn.prepare('SELECT 1 AS ok FROM stories WHERE id = ?').get(storyId);
    if (!exists) throw Object.assign(new Error('unknown story'), { status: 404 });
    recordVote(conn, storyId, Number(value));
    const training = retrainIfNeeded();
    return { ok: true, votes: voteCounts(conn), training };
  },

  'POST /api/unvote': async (url, req) => {
    const { id } = await readBody(req);
    deleteVote(conn, Number(id));
    return { ok: true, votes: voteCounts(conn), training: retrainIfNeeded(true) };
  },

  'POST /api/train': async () => retrainIfNeeded(true),

  'POST /api/ingest': async (url, req) => {
    if (ingestInFlight) return ingestInFlight;
    const body = await readBody(req).catch(() => ({}));
    const days = Math.min(60, Math.max(1, num(body.days, 7)));
    ingestInFlight = (async () => {
      try {
        const result = await ingest(conn, {
          days,
          pagesPerDay: num(body.pagesPerDay, 3),
          minPoints: num(body.minPoints, MIN_POINTS),
        });
        result.scored = scoreMissing(conn);
        return result;
      } finally {
        ingestInFlight = null;
      }
    })();
    return ingestInFlight;
  },

  'GET /api/explain': (url) => {
    const id = Number(url.searchParams.get('id'));
    const result = explain(conn, id);
    if (!result) throw Object.assign(new Error('unknown story'), { status: 404 });
    return result;
  },

  'GET /api/export': (url, req, res) => {
    const votes = conn.prepare(`
      SELECT v.story_id, v.value, v.created_at, s.title, s.url, s.domain
      FROM votes v JOIN stories s ON s.id = v.story_id ORDER BY v.created_at
    `).all();
    if (url.searchParams.get('format') === 'csv') {
      const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      const lines = [
        'story_id,vote,value,voted_at,title,url,domain',
        ...votes.map((r) => [
          r.story_id, r.value > 0 ? 'up' : r.value < 0 ? 'down' : 'skip', r.value,
          new Date(r.created_at * 1000).toISOString(), r.title, r.url, r.domain,
        ].map(esc).join(',')),
      ];
      send(res, 200, lines.join('\n') + '\n', {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="rekorderlig-votes-${new Date().toISOString().slice(0, 10)}.csv"`,
      });
      return SENT;
    }
    return { exportedAt: new Date().toISOString(), votes };
  },

  'POST /api/import': async (url, req) => {
    const body = await readBody(req, 20_000_000);
    const votes = Array.isArray(body.votes) ? body.votes : [];
    let applied = 0;
    conn.exec('BEGIN');
    try {
      for (const v of votes) {
        const id = Number(v.story_id ?? v.id);
        if (!Number.isInteger(id)) continue;
        if (!conn.prepare('SELECT 1 AS ok FROM stories WHERE id = ?').get(id)) continue;
        recordVote(conn, id, Number(v.value) || 0, Number(v.created_at) || Math.floor(Date.now() / 1000));
        applied++;
      }
      conn.exec('COMMIT');
    } catch (err) {
      conn.exec('ROLLBACK');
      throw err;
    }
    return { applied, skipped: votes.length - applied, training: retrainIfNeeded(true) };
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;

  if (!authorize(req, res, url)) return;
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

  const handler = routes[key];
  if (!handler) return send(res, 404, { error: `no route for ${key}` });

  try {
    const result = await handler(url, req, res);
    if (result !== SENT) send(res, 200, result);
  } catch (err) {
    const status = err.status ?? 500;
    if (status >= 500) console.error(`[${key}]`, err);
    send(res, status, { error: err.message ?? 'internal error' });
  }
});

/**
 * Hosted mode: keep the corpus fresh without anyone thinking about it.
 * REFRESH_HOURS=6 → ingest the last 2 days whenever the data is older than 6h,
 * checked hourly and on boot (so a scale-to-zero machine catches up on wake).
 */
function startAutoRefresh() {
  const hours = Number(process.env.REFRESH_HOURS || 0);
  if (!hours) return;
  const refreshIfStale = async () => {
    const age = Math.floor(Date.now() / 1000) - Number(getMeta(conn, 'last_ingest_at', 0));
    if (age < hours * 3600) return;
    try {
      const result = await ingest(conn, { days: 2 });
      const scored = scoreMissing(conn);
      console.log(`auto-refresh: ${result.inserted} new stories, ${scored} scored`);
    } catch (err) {
      console.error('auto-refresh failed:', err.message);
    }
  };
  refreshIfStale();
  setInterval(refreshIfStale, 3600_000).unref();
}

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, HOST, () => {
    console.log(`rekorderlig → http://${HOST}:${PORT}`);
    const s = stats(conn);
    console.log(`  ${s.stories} stories, ${s.votes.total} votes, model rev ${s.model?.rev ?? '—'}`);
    if (s.stories === 0) console.log('  no stories yet — run `npm run ingest` or hit "Fetch stories" in the app');
    startAutoRefresh();
  });
}

export { server, conn };
