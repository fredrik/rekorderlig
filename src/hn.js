/**
 * Fetch stories from the Algolia Hacker News search API (no key required).
 * Docs: https://hn.algolia.com/api
 */
import { domainOf } from './features.js';
import { upsertStory } from './db.js';

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
  // dayKey() on NaN throws a RangeError, which would abort the whole day's page.
  if (!Number.isFinite(created)) return null;
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
export async function fetchDay(day, { pages = 10, hitsPerPage = 100, minPoints = 0, fetchJson = getJson } = {}) {
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

/**
 * One story by its Hacker News id, or null if the id is unknown / not a story.
 * `tags=story,story_<id>` narrows the index to that submission itself (the
 * story_<id> tag alone would also match all of its comments), so this costs one
 * small search hit instead of the full comment tree that /items/<id> returns.
 */
export async function fetchStory(id, { fetchJson = getJson } = {}) {
  const data = await fetchJson(`${API}/search?tags=story,story_${Number(id)}&hitsPerPage=1`);
  const hit = (data.hits ?? [])[0];
  return hit ? normalize(hit) : null;
}

export async function fetchFrontPage({ fetchJson = getJson } = {}) {
  const data = await fetchJson(`${API}/search?tags=front_page&hitsPerPage=100`);
  return (data.hits ?? []).map((h) => normalize(h)).filter(Boolean);
}

/**
 * The one way stories enter the database: walk `days` (any list of
 * YYYY-MM-DD, in the order given), fetch the top stories of each and upsert
 * them. Used for both the rolling refresh and a year-long archive fill —
 * the only difference is the list of days handed in.
 *
 * Every day handed in is fetched. Nothing is skipped on the grounds that it
 * looks covered already: points and comment counts keep moving, and a day
 * that only partly landed is indistinguishable from a quiet one. Upserts make
 * a refetch cheap in the database — it costs requests, not correctness.
 *
 * Every day is committed in its own transaction, and a day that still fails
 * after retries is recorded and stepped over rather than aborting the run, so
 * any interrupted or partly failed run is resumed by running it again.
 *
 * @returns {{days:number, fetchedDays:number, fetched:number,
 *            inserted:number, failures:{day:string, error:string}[]}}
 */
export async function syncDays(conn, days, {
  // 10 pages of 100 hits covers a full HN day above the points floor; a quiet
  // day still costs fewer requests, since fetchDay stops at the last page.
  pagesPerDay = 10,
  minPoints = MIN_POINTS,
  throttleMs = 250,
  onProgress = () => {},
  deps = {},
} = {}) {
  const before = conn.prepare('SELECT COUNT(*) AS n FROM stories').get().n;
  let fetched = 0;
  let fetchedDays = 0;
  const failures = [];

  for (const day of days) {
    let stories;
    try {
      stories = await (deps.fetchDay ?? fetchDay)(day, { pages: pagesPerDay, minPoints });
    } catch (err) {
      failures.push({ day, error: err.message });
      onProgress({ day, count: 0, failed: true });
      continue;
    }
    upsertAll(conn, stories);
    fetchedDays++;
    fetched += stories.length;
    onProgress({ day, count: stories.length });
    if (throttleMs) await new Promise((r) => setTimeout(r, throttleMs));
  }

  const after = conn.prepare('SELECT COUNT(*) AS n FROM stories').get().n;
  return { days: days.length, fetchedDays, fetched, inserted: after - before, failures };
}

/** Upsert the current front page. Only worth doing when today is in scope. */
export async function syncFrontPage(conn, { deps = {} } = {}) {
  const stories = await (deps.fetchFrontPage ?? fetchFrontPage)();
  upsertAll(conn, stories);
  return stories.length;
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
