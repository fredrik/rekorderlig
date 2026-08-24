/**
 * Ingest from the Algolia Hacker News search API (no key required).
 * Docs: https://hn.algolia.com/api
 */
import { domainOf } from './features.js';
import { upsertStory, setMeta } from './db.js';

const API = 'https://hn.algolia.com/api/v1';
const FIREBASE = 'https://hacker-news.firebaseio.com/v0';
const UA = 'rekorderlig/1.0 (personal HN recommender)';

/** How far behind "now" the corpus may fall before ingest distrusts Algolia. */
export const STALE_AFTER_S = 2 * 3600;

export const dayKey = (unixSeconds) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

export function dayBounds(day) {
  const start = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
  if (Number.isNaN(start)) throw new Error(`bad day: ${day}`);
  return { start, end: start + 86400 };
}

/** Last `n` days as YYYY-MM-DD, most recent first. */
export function recentDays(n, from = new Date()) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(new Date(from.getTime() - i * 86400000).toISOString().slice(0, 10));
  }
  return out;
}

async function getJson(url, { retries = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30_000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      return await res.json();
    } catch (err) {
      lastError = err;
      if (err.fatal || attempt === retries) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}

export function normalize(hit, fetchedAt = Math.floor(Date.now() / 1000)) {
  const id = Number(hit.objectID);
  const title = (hit.title ?? hit.story_title ?? '').trim();
  if (!id || !title) return null;
  const url = hit.url ?? hit.story_url ?? null;
  const created = hit.created_at_i ?? Math.floor(Date.parse(hit.created_at) / 1000);
  return {
    id,
    title,
    url,
    domain: domainOf(url),
    author: hit.author ?? null,
    points: hit.points ?? 0,
    num_comments: hit.num_comments ?? 0,
    created_at: created,
    day: dayKey(created),
    fetched_at: fetchedAt,
  };
}

/** Top stories for one UTC day, ranked by points by the API. */
export async function fetchDay(day, { pages = 3, hitsPerPage = 100, fetchJson = getJson } = {}) {
  const { start, end } = dayBounds(day);
  const stories = [];
  for (let page = 0; page < pages; page++) {
    const url = `${API}/search?tags=story&numericFilters=created_at_i>=${start},created_at_i<${end}`
      + `&hitsPerPage=${hitsPerPage}&page=${page}`;
    const data = await fetchJson(url);
    for (const hit of data.hits ?? []) {
      const s = normalize(hit);
      if (s) stories.push(s);
    }
    if (!data.hits?.length || page + 1 >= (data.nbPages ?? 0)) break;
  }
  return stories;
}

export async function fetchFrontPage({ fetchJson = getJson } = {}) {
  const data = await fetchJson(`${API}/search?tags=front_page&hitsPerPage=100`);
  return (data.hits ?? []).map((h) => normalize(h)).filter(Boolean);
}

/** A story item from the official (Firebase) API, in the same shape `normalize` produces. */
export function normalizeItem(item, fetchedAt = Math.floor(Date.now() / 1000)) {
  if (!item || item.type !== 'story' || item.dead || item.deleted) return null;
  const title = (item.title ?? '').trim();
  if (!item.id || !title || !item.time) return null;
  const url = item.url ?? null;
  return {
    id: item.id,
    title,
    url,
    domain: domainOf(url),
    author: item.by ?? null,
    points: item.score ?? 0,
    num_comments: item.descendants ?? 0,
    created_at: item.time,
    day: dayKey(item.time),
    fetched_at: fetchedAt,
  };
}

async function mapConcurrent(items, limit, fn) {
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

/**
 * Stories newer than `since` from the official (Firebase) API — live, but one
 * request per item, so only used when the Algolia index has stopped keeping up.
 */
export async function fetchLive({ since = 0, concurrency = 16, fetchJson = getJson } = {}) {
  const [fresh, top] = await Promise.all([
    fetchJson(`${FIREBASE}/newstories.json`),
    fetchJson(`${FIREBASE}/topstories.json`),
  ]);
  const ids = [...new Set([...(fresh ?? []), ...(top ?? [])])];
  const fetchedAt = Math.floor(Date.now() / 1000);
  const items = await mapConcurrent(ids, concurrency, (id) =>
    fetchJson(`${FIREBASE}/item/${id}.json`).catch(() => null));
  return items.map((it) => normalizeItem(it, fetchedAt)).filter((s) => s && s.created_at >= since);
}

function upsertAll(conn, stories) {
  conn.exec('BEGIN');
  try {
    for (const s of stories) upsertStory(conn, s);
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Pull the last `days` days plus the current front page into the database.
 * If the corpus still ends more than `staleAfter` seconds ago afterwards —
 * the Algolia index stops updating for hours at a time — the gap is filled
 * from the official (Firebase) API instead.
 * @returns {{fetched:number, inserted:number, live:number, days:string[]}}
 */
export async function ingest(conn, {
  days = 7, pagesPerDay = 3, staleAfter = STALE_AFTER_S, onProgress = () => {}, deps = {},
} = {}) {
  const list = recentDays(days);
  const before = conn.prepare('SELECT COUNT(*) AS n FROM stories').get().n;
  let fetched = 0;

  for (const day of list) {
    const stories = await (deps.fetchDay ?? fetchDay)(day, { pages: pagesPerDay });
    upsertAll(conn, stories);
    fetched += stories.length;
    onProgress({ day, count: stories.length });
  }

  const front = await (deps.fetchFrontPage ?? fetchFrontPage)();
  upsertAll(conn, front);
  fetched += front.length;
  onProgress({ day: 'front page', count: front.length });

  const now = Math.floor(Date.now() / 1000);
  const newest = conn.prepare('SELECT MAX(created_at) AS t FROM stories').get().t ?? 0;
  let live = 0;
  if (now - newest > staleAfter) {
    const since = Math.max(newest, now - days * 86400);
    const stories = await (deps.fetchLive ?? fetchLive)({ since });
    upsertAll(conn, stories);
    live = stories.length;
    fetched += live;
    onProgress({ day: 'live API (search index is behind)', count: live });
  }

  const after = conn.prepare('SELECT COUNT(*) AS n FROM stories').get().n;
  setMeta(conn, 'last_ingest_at', Math.floor(Date.now() / 1000));
  return { fetched, inserted: after - before, live, days: list };
}
