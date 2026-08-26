import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { db, importVote, deleteVote, voteCounts, upsertStory } from './db.js';
import { fetchStory } from './hn.js';
import {
  feed, trainingQueue, explain, stats, loadModel, storiesPerDay, voteLog, judge, modelHistory,
} from './service.js';
import { requestTrain, trainStatus } from './trainer.js';
import { requestSync, syncStatus } from './syncer.js';

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
    });
  },

  // The learning curve in Brain: accuracy per model revision. Its own
  // endpoint like /api/days, rather than riding along on /api/stats.
  'GET /api/history': () => modelHistory(conn),

  'GET /api/queue': (url) => {
    const cursor = Math.max(0, num(url.searchParams.get('cursor'), 0));
    const items = trainingQueue(conn, {
      limit: Math.max(1, Math.min(100, num(url.searchParams.get('limit'), 12))),
      cursor,
    });
    // `mix` is diagnostics, not decoration: the trainer card deliberately says
    // nothing about why a story was picked, so a swipe can't be anchored.
    const mix = {};
    for (const s of items) mix[s.reason] = (mix[s.reason] ?? 0) + 1;
    return { items, mix, cursor: cursor + 1, hasModel: Boolean(loadModel(conn)?.runtime) };
  },

  'POST /api/vote': async (url, req) => {
    const { id, value } = await readBody(req);
    const storyId = Number(id);
    if (!Number.isInteger(storyId)) throw httpError(400, 'id required');
    if (!VOTE_VALUES.has(Number(value))) throw httpError(400, 'value must be 1, -1 or 0');
    const exists = conn.prepare('SELECT 1 AS ok FROM stories WHERE id = ?').get(storyId);
    if (!exists) throw httpError(404, 'unknown story');
    // The reveal the trainer shows after the swipe: what the model had guessed,
    // captured before this vote existed to teach it the answer.
    const { prediction, agreement } = judge(conn, storyId, Number(value));
    return { ok: true, votes: voteCounts(conn), prediction, agreement };
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

  // Fetching runs in a worker thread (syncer.js) — a range of days is a few
  // hundred sequential HTTP calls, far too long to hold a request open for.
  // Answers 202 immediately; poll GET /api/sync for progress and the outcome.
  'POST /api/sync': async (url, req, res) => {
    const body = await readBody(req).catch(() => ({}));
    const opts = {};
    if (body.from) opts.from = String(body.from);
    if (body.to) opts.to = String(body.to);
    if (!opts.from) opts.days = Math.min(60, Math.max(1, num(body.days, 2)));
    if (body.pagesPerDay != null) opts.pagesPerDay = num(body.pagesPerDay, 10);
    if (body.minPoints != null) opts.minPoints = num(body.minPoints, 3);
    send(res, 202, requestSync(opts));
    return SENT;
  },

  'GET /api/sync': () => syncStatus(),

  'GET /api/explain': (url) => {
    const id = Number(url.searchParams.get('id'));
    const result = explain(conn, id);
    if (!result) throw httpError(404, 'unknown story');
    return result;
  },

  'GET /api/export': () => {
    const votes = conn.prepare(`
      SELECT v.story_id, v.value, v.created_at, s.title, s.url, s.domain
      FROM votes v JOIN stories s ON s.id = v.story_id ORDER BY v.created_at
    `).all();
    return { exportedAt: new Date().toISOString(), votes };
  },

  // Re-importing a vote history one vote at a time, so every vote can be eyeballed
  // as it lands. The story the vote was cast on may predate this corpus, so an
  // unknown id is looked up on HN rather than stubbed: `title`/`url`/`domain` in
  // the payload are ignored — HN is the authority on what was submitted, and the
  // response echoes the stored story back so the caller can compare. No retrain
  // is triggered per vote (each one would rescore the whole corpus) — POST
  // /api/train once the import is done.
  'POST /api/import/vote': async (url, req) => {
    const body = await readBody(req);
    const storyId = Number(body.story_id ?? body.id);
    const value = Number(body.value);
    const createdAt = Number(body.created_at);
    if (!Number.isInteger(storyId) || storyId <= 0) throw httpError(400, 'story_id required');
    if (!VOTE_VALUES.has(value)) throw httpError(400, 'value must be 1, -1 or 0');
    if (!Number.isInteger(createdAt) || createdAt <= 0) throw httpError(400, 'created_at required (unix seconds)');

    let fetched = false;
    if (!conn.prepare('SELECT 1 AS ok FROM stories WHERE id = ?').get(storyId)) {
      let hit;
      try {
        hit = await fetchStory(storyId);
      } catch (err) {
        throw httpError(502, `HN lookup failed for ${storyId}: ${err.message}`);
      }
      if (!hit) throw httpError(404, `story ${storyId} not found on HN`);
      upsertStory(conn, hit);
      fetched = true;
    }
    importVote(conn, storyId, value, createdAt);
    const story = conn.prepare(
      'SELECT id, title, url, domain, points, num_comments, created_at, day FROM stories WHERE id = ?'
    ).get(storyId);
    return { ok: true, fetched, story, votes: voteCounts(conn) };
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

if (process.env.NODE_ENV !== 'test') {
  server.listen(PORT, HOST, () => {
    console.log(`rekorderlig → http://${HOST}:${PORT}`);
    const s = stats(conn);
    console.log(`  ${s.stories} stories, ${s.votes.total} votes, model rev ${s.model?.rev ?? '—'}`);
    if (s.stories === 0) console.log('  no stories yet — run `npm run sync` or hit "Fetch stories" in the app');
  });
}

export { server, conn };
