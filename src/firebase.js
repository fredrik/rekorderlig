/**
 * The official Hacker News item API, used for exactly one thing: recovering
 * stories that Algolia's search index never got.
 *
 * This is a repair path, not a second sync. Algolia (`hn.js`) remains the only
 * way stories routinely enter the database — it can answer "the top stories of
 * a day" in ten requests, which this API cannot do at all. What it can do is
 * answer for *every* id, including the ones Algolia dropped, and that is the
 * only question it is asked here.
 *
 * The two sources are kept in separate files because they share no request or
 * response shape; what they do share (`getJson`, `upsertStory`, the story
 * object) is imported rather than forked.
 *
 * Docs: https://github.com/HackerNews/API
 */
import { domainOf } from './features.js';
import { upsertStory } from './db.js';
import { getJson } from './http.js';
import { dayBounds, dayKey, MIN_POINTS } from './hn.js';

const API = 'https://hacker-news.firebaseio.com/v0';

/**
 * Item time is only *nearly* monotonic in id — a submission can be stamped a
 * second either side of its neighbours — so a day's id range is widened at both
 * ends and each item's own timestamp decides which day it belongs to. Cheap
 * insurance: a few hundred extra ids on a day that already costs ten thousand.
 */
export const ID_PAD = 200;

/** How far past a null id to keep looking for one that carries a timestamp. */
const PROBE_WINDOW = 20;

/** How many ids to hold in flight. 32 ran clean over 22k ids; half that is polite. */
export const CONCURRENCY = 16;

/**
 * One Firebase item → the story shape `upsertStory` takes, or null if it is not
 * a live story. Everything the backfill must not train on is rejected here:
 * comments, jobs and polls (wrong type), items removed by their author
 * (`deleted`) and items killed by moderation or the flag threshold (`dead`).
 * Those are not losses — they are ~11% of every id range, on a normal day too.
 */
export function normalizeItem(item, fetchedAt = Math.floor(Date.now() / 1000)) {
  if (!item || item.deleted || item.dead || item.type !== 'story') return null;
  const id = Number(item.id);
  const title = (item.title ?? '').trim();
  if (!id || !title) return null;
  const created = item.time;
  if (!Number.isFinite(created)) return null;
  const url = item.url ?? null;
  return {
    id,
    title,
    url,
    domain: domainOf(url),
    author: item.by ?? null,
    points: item.score ?? 0,
    num_comments: item.descendants ?? 0,
    created_at: created,
    day: dayKey(created),
    fetched_at: fetchedAt,
  };
}

const itemUrl = (id) => `${API}/item/${id}.json`;

/** The first id at or after `id` that carries a timestamp, or null. */
async function datableAtOrAfter(id, cap, fetchJson) {
  for (let k = id; k <= Math.min(cap, id + PROBE_WINDOW); k++) {
    const item = await fetchJson(itemUrl(k));
    if (item && Number.isFinite(item.time)) return { id: k, time: item.time };
  }
  return null;
}

/**
 * The lowest id whose item was created at or after `t`, by bisection over the
 * whole id space. About log2(maxitem) ≈ 26 requests, which is why this asks
 * Firebase rather than reading the boundary off Algolia: the index whose gaps
 * we are repairing is the last thing that should define the range to repair.
 *
 * A null id (one that never existed) carries no timestamp and so cannot be
 * compared; the bisect steps forward to the next id that can, and on finding
 * none pulls the upper bound back. Either way the answer can only land a few
 * ids early, which `ID_PAD` already absorbs.
 */
async function firstIdAtOrAfter(t, cap, fetchJson) {
  let lo = 1;
  let hi = cap + 1; // cap + 1 means "no item that late", i.e. past the tip
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const probe = await datableAtOrAfter(mid, cap, fetchJson);
    if (!probe || probe.time >= t) hi = mid;
    else lo = probe.id + 1;
  }
  return lo;
}

/** The padded id range that covers one UTC day, clamped to the tip of the site. */
export async function idRangeForDay(day, { fetchJson = getJson, pad = ID_PAD } = {}) {
  const { start, end } = dayBounds(day);
  const cap = Number(await fetchJson(`${API}/maxitem.json`));
  const from = await firstIdAtOrAfter(start, cap, fetchJson);
  const until = await firstIdAtOrAfter(end, cap, fetchJson);
  return {
    lo: Math.max(1, from - pad),
    hi: Math.min(cap, until - 1 + pad),
  };
}

/** Run `fn` over `items` with at most `n` in flight, keeping the input order. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

/**
 * Walk every id in each day's range and upsert the live stories found there.
 *
 * There is no diff against Algolia first: an id has to be fetched to learn
 * whether it is a story at all, so asking Algolia as well would only add
 * requests and a dependency on the index we already know to be wrong.
 * `upsertStory` takes MAX() on points and comments, so a story Algolia *did*
 * index can only be improved by this, never walked back.
 *
 * One transaction per day, and an id that fails after retries is recorded and
 * stepped over rather than aborting the run — the same rule `syncDays` follows,
 * so an interrupted run is resumed by running it again.
 */
export async function backfillDays(conn, days, {
  minPoints = MIN_POINTS,
  concurrency = CONCURRENCY,
  dryRun = false,
  pad = ID_PAD,
  fetchJson = getJson,
  onProgress = () => {},
  now = Math.floor(Date.now() / 1000),
} = {}) {
  const list = [...new Set(days)].sort();
  const wanted = new Set(list);
  const totals = {
    days: list.length, scanned: 0, stories: 0, recovered: 0, updated: 0,
    failures: [], byDay: [], dryRun,
  };
  const exists = conn.prepare('SELECT 1 FROM stories WHERE id = ?');

  // Padded ranges overlap at the seams; the cursor makes sure a consecutive
  // range of days fetches each id once.
  let cursor = 0;

  for (const day of list) {
    const { lo, hi } = await idRangeForDay(day, { fetchJson, pad });
    const from = Math.max(lo, cursor + 1);
    const ids = [];
    for (let id = from; id <= hi; id++) ids.push(id);
    cursor = Math.max(cursor, hi);

    const fetched = await pool(ids, concurrency, async (id) => {
      try {
        return { id, item: await fetchJson(itemUrl(id)) };
      } catch (err) {
        return { id, error: err.message };
      }
    });

    const found = [];
    const failures = [];
    for (const r of fetched) {
      if (r.error) { failures.push({ day, id: r.id, error: r.error }); continue; }
      const story = normalizeItem(r.item, now);
      // The points floor is the same one the Algolia sync applies: below it a
      // submission is noise nobody engaged with. `wanted` drops the padding.
      if (!story || story.points < minPoints || !wanted.has(story.day)) continue;
      found.push(story);
    }

    const isNew = found.map((s) => exists.get(s.id) === undefined);
    if (!dryRun && found.length) {
      conn.exec('BEGIN');
      try {
        for (const story of found) upsertStory(conn, story);
        conn.exec('COMMIT');
      } catch (err) {
        conn.exec('ROLLBACK');
        throw err;
      }
    }

    const stat = {
      day,
      from,
      to: hi,
      scanned: ids.length,
      stories: found.length,
      recovered: isNew.filter(Boolean).length,
      updated: isNew.filter((n) => !n).length,
      failed: failures.length,
    };
    totals.scanned += stat.scanned;
    totals.stories += stat.stories;
    totals.recovered += stat.recovered;
    totals.updated += stat.updated;
    totals.failures.push(...failures);
    totals.byDay.push(stat);
    onProgress(stat);
  }

  return totals;
}
