/**
 * Ingest from the Algolia Hacker News search API (no key required).
 * Docs: https://hn.algolia.com/api
 */
import { domainOf } from './features.js';
import { upsertStory, setMeta } from './db.js';

const API = 'https://hn.algolia.com/api/v1';
const UA = 'rekorderlig/1.0 (personal HN recommender)';

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

/** Every day from `from` to `to` (both YYYY-MM-DD, inclusive), oldest first. */
export function daysBetween(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start)) throw new Error(`bad day: ${from}`);
  if (Number.isNaN(end)) throw new Error(`bad day: ${to}`);
  if (start > end) throw new Error(`empty range: ${from} is after ${to}`);
  const out = [];
  for (let t = start; t <= end; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
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

/** Below this, a submission is noise: nobody engaged, and the model learns nothing from it. */
export const MIN_POINTS = 3;

/** Top stories for one UTC day, ranked by points by the API. */
export async function fetchDay(day, { pages = 3, hitsPerPage = 100, minPoints = 0, fetchJson = getJson } = {}) {
  const { start, end } = dayBounds(day);
  const pointsFilter = minPoints > 0 ? `,points>=${minPoints}` : '';
  const stories = [];
  for (let page = 0; page < pages; page++) {
    const url = `${API}/search?tags=story&numericFilters=created_at_i>=${start},created_at_i<${end}${pointsFilter}`
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

/**
 * Pull the last `days` days plus the current front page into the database.
 * @returns {{fetched:number, inserted:number, days:string[]}}
 */
export async function ingest(conn, { days = 7, pagesPerDay = 3, minPoints = MIN_POINTS, onProgress = () => {}, deps = {} } = {}) {
  const list = recentDays(days);
  const before = conn.prepare('SELECT COUNT(*) AS n FROM stories').get().n;
  let fetched = 0;

  for (const day of list) {
    const stories = await (deps.fetchDay ?? fetchDay)(day, { pages: pagesPerDay, minPoints });
    conn.exec('BEGIN');
    try {
      for (const s of stories) upsertStory(conn, s);
      conn.exec('COMMIT');
    } catch (err) {
      conn.exec('ROLLBACK');
      throw err;
    }
    fetched += stories.length;
    onProgress({ day, count: stories.length });
  }

  const front = await (deps.fetchFrontPage ?? fetchFrontPage)();
  conn.exec('BEGIN');
  try {
    for (const s of front) upsertStory(conn, s);
    conn.exec('COMMIT');
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
  fetched += front.length;
  onProgress({ day: 'front page', count: front.length });

  const after = conn.prepare('SELECT COUNT(*) AS n FROM stories').get().n;
  setMeta(conn, 'last_ingest_at', Math.floor(Date.now() / 1000));
  return { fetched, inserted: after - before, days: list };
}

/**
 * Batch-fill the archive: fetch the top stories of every day from `from` to
 * `to` (inclusive, UTC), oldest first. Days the database already covers with
 * at least `minStories` stories are skipped, each fetched day is committed in
 * its own transaction, and a day that still fails after retries is recorded
 * and stepped over rather than aborting the run — so an interrupted or partly
 * failed run is resumed by simply running it again with the same range.
 *
 * `minStories` works because a typical day of HN has well over 100 stories
 * clearing the `minPoints` bar, so any fetched day passes it, while days that
 * only hold strays from old front-page fetches don't. A genuinely quiet day
 * that fetches fewer than `minStories` is merely refetched on a rerun — a
 * wasted request or two, never wrong data.
 *
 * @returns {{days:number, skipped:number, fetchedDays:number, fetched:number,
 *            inserted:number, failures:{day:string, error:string}[]}}
 */
export async function backfill(conn, {
  from,
  to = dayKey(Math.floor(Date.now() / 1000) - 86400),
  pagesPerDay = 3,
  minPoints = MIN_POINTS,
  minStories = 100,
  throttleMs = 250,
  onProgress = () => {},
  deps = {},
} = {}) {
  const days = daysBetween(from, to);
  const have = new Map(
    conn.prepare('SELECT day, COUNT(*) AS n FROM stories GROUP BY day').all().map((r) => [r.day, r.n])
  );
  const before = conn.prepare('SELECT COUNT(*) AS n FROM stories').get().n;
  let fetched = 0;
  let fetchedDays = 0;
  let skipped = 0;
  const failures = [];

  for (const day of days) {
    if ((have.get(day) ?? 0) >= minStories) {
      skipped++;
      onProgress({ day, count: have.get(day), skipped: true });
      continue;
    }
    let stories;
    try {
      stories = await (deps.fetchDay ?? fetchDay)(day, { pages: pagesPerDay, minPoints });
    } catch (err) {
      failures.push({ day, error: err.message });
      onProgress({ day, count: 0, failed: true });
      continue;
    }
    conn.exec('BEGIN');
    try {
      for (const s of stories) upsertStory(conn, s);
      conn.exec('COMMIT');
    } catch (err) {
      conn.exec('ROLLBACK');
      throw err;
    }
    fetchedDays++;
    fetched += stories.length;
    onProgress({ day, count: stories.length });
    if (throttleMs) await new Promise((r) => setTimeout(r, throttleMs));
  }

  const after = conn.prepare('SELECT COUNT(*) AS n FROM stories').get().n;
  return { days: days.length, skipped, fetchedDays, fetched, inserted: after - before, failures };
}
