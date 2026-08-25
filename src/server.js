import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { db, recordVote, deleteVote, getMeta, voteCounts } from './db.js';
import { ingest, MIN_POINTS } from './hn.js';
import {
  scoreMissing, feed, trainingQueue, explain, stats, loadModel, storiesPerDay, voteLog,
} from './service.js';
import { requestTrain, trainStatus } from './trainer.js';

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

/** Constant-time string comparison, so the token can't be guessed byte by byte. */
function tokenMatches(candidate, expected) {
  if (typeof candidate !== 'string' || candidate.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}

/** Read one cookie by name; a malformed header yields undefined, never a throw. */
function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return undefined; }
  }
  return undefined;
}

function authorize(req, res, url) {
  const expected = process.env.AUTH_TOKEN;
  if (!expected) return true;

  const header = req.headers.authorization ?? '';
  if (header.startsWith('Bearer ') && tokenMatches(header.slice(7), expected)) return true;

  if (tokenMatches(readCookie(req, COOKIE), expected)) return true;

  if (tokenMatches(url.searchParams.get('token'), expected)) {
    // `Secure` only when the request actually arrived over HTTPS (Fly sets
    // x-forwarded-proto); a plain-http tailnet host would otherwise never
    // get the cookie stored and need the ?token= link on every visit.
    const https = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
    res.setHeader('set-cookie',
      `${COOKIE}=${encodeURIComponent(expected)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`);
    return true;
  }

  send(res, 401, url.pathname.startsWith('/api/')
    ? { error: 'unauthorized' }
    : 'Unauthorized. Open the link that includes your ?token=…', {
      'content-type': url.pathname.startsWith('/api/') ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    });
  return false;
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

const httpError = (status, message) => Object.assign(new Error(message), { status });

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'payload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return body && typeof body === 'object' ? body : {};
  } catch {
    throw httpError(400, 'invalid JSON body');
  }
}

// Section paths the front end routes client-side; each serves the app shell
// so /feed etc. survive a refresh or work as a bookmark.
const APP_PATHS = new Set(['/', '/train', '/feed', '/brain', '/votes']);

async function serveStatic(req, res, pathname) {
  const rel = normalize(APP_PATHS.has(pathname) ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + sep)) return send(res, 403, { error: 'forbidden' });
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
const VOTE_VALUES = new Set([1, -1, 0]);

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
    maxScore: num(url.searchParams.get('maxScore'), 1),
    minComments: num(url.searchParams.get('minComments'), 0),
    limit: Math.min(200, num(url.searchParams.get('limit'), 50)),
    offset: num(url.searchParams.get('offset'), 0),
    includeVoted: bool(url.searchParams.get('includeVoted')),
    day: url.searchParams.get('day'),
    query: url.searchParams.get('q'),
  }),

  'GET /api/votes': (url) => {
    const raw = url.searchParams.get('value');
    const value = raw == null || raw === '' || raw === 'all' ? null : Number(raw);
    if (value != null && !VOTE_VALUES.has(value)) throw httpError(400, 'value must be 1, -1, 0 or all');
    return voteLog(conn, {
      value,
      limit: Math.min(200, num(url.searchParams.get('limit'), 50)),
      offset: num(url.searchParams.get('offset'), 0),
      query: url.searchParams.get('q'),
    });
  },

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
    if (!Number.isInteger(storyId)) throw httpError(400, 'id required');
    if (!VOTE_VALUES.has(Number(value))) throw httpError(400, 'value must be 1, -1 or 0');
    const exists = conn.prepare('SELECT 1 AS ok FROM stories WHERE id = ?').get(storyId);
    if (!exists) throw httpError(404, 'unknown story');
    recordVote(conn, storyId, Number(value));
    return { ok: true, votes: voteCounts(conn) };
  },

  'POST /api/unvote': async (url, req) => {
    const { id } = await readBody(req);
    const storyId = Number(id);
    if (!Number.isInteger(storyId)) throw httpError(400, 'id required');
    deleteVote(conn, storyId);
    return { ok: true, votes: voteCounts(conn) };
  },

  // Voting only records; the client asks for a retrain when it is ready (it
  // debounces a burst of votes into one trigger). Training runs in a worker
  // thread, so this answers 202 immediately — poll GET /api/train for the
  // outcome. Triggers that land mid-run collapse into a single follow-up run.
  'POST /api/train': (url, req, res) => {
    send(res, 202, requestTrain());
    return SENT;
  },

  'GET /api/train': () => trainStatus(),

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
    if (!result) throw httpError(404, 'unknown story');
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
      const exists = conn.prepare('SELECT 1 AS ok FROM stories WHERE id = ?');
      for (const v of votes) {
        if (!v || typeof v !== 'object') continue;
        const id = Number(v.story_id ?? v.id);
        const value = Number(v.value);
        if (!Number.isInteger(id) || !VOTE_VALUES.has(value)) continue;
        if (!exists.get(id)) continue;
        recordVote(conn, id, value, Number(v.created_at) || Math.floor(Date.now() / 1000));
        applied++;
      }
      conn.exec('COMMIT');
    } catch (err) {
      conn.exec('ROLLBACK');
      throw err;
    }
    return { applied, skipped: votes.length - applied, training: applied ? requestTrain() : null };
  },
};

async function handle(req, res) {
  // A bad Host header would make `new URL` throw; fall back rather than fail.
  const url = URL.parse(req.url, `http://${req.headers.host ?? 'localhost'}`)
    ?? new URL(req.url, 'http://localhost');
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
}

// Nothing thrown while handling a request may escape: in an async listener an
// uncaught error becomes an unhandled rejection, and Node exits on those.
const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(`[${req.method} ${req.url}]`, err);
    if (!res.headersSent) send(res, 500, { error: 'internal error' });
    else res.destroy();
  });
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
