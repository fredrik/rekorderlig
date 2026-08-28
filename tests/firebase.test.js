import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { openDb, upsertStory } from '../src/db.js';
import { dayBounds, dayKey } from '../src/hn.js';
import { normalizeItem, idRangeForDay, backfillDays } from '../src/firebase.js';

const DB = new URL('./data/tmp-firebase.db', import.meta.url).pathname;
const DAY = '2026-08-23';
const { start } = dayBounds(DAY);

/**
 * A fake Hacker News, ids 1..1099 running two minutes apart, so id 1030 is the
 * first one at or after midnight — that number is what the bisect has to find,
 * and it is deliberately not a range boundary. The whole id space is served,
 * because the bisect starts from the site's first item.
 */
function world({ fail = new Set() } = {}) {
  const items = new Map();
  const timeOf = (id) => start - 3600 + (id - 1000) * 120;
  for (let id = 1; id <= 1099; id++) {
    items.set(id, { id, type: 'story', by: `u${id}`, time: timeOf(id), title: `Story ${id}`, url: `https://ex.dev/${id}`, score: 5, descendants: 2 });
  }
  // A spread of things a backfill must not treat as a story.
  items.set(1040, { id: 1040, type: 'comment', by: 'c', time: items.get(1040).time, text: 'a comment' });
  items.set(1041, { id: 1041, type: 'story', by: 'd', time: items.get(1041).time, title: 'Dead one', score: 9, dead: true });
  items.set(1042, { id: 1042, type: 'story', by: 'e', time: items.get(1042).time, deleted: true });
  items.set(1043, null); // never existed
  items.set(1044, { ...items.get(1044), score: 1 }); // below the points floor

  let calls = 0;
  const fetchJson = async (url) => {
    calls++;
    if (url.endsWith('/maxitem.json')) return 1099;
    const id = Number(url.match(/\/item\/(\d+)\.json$/)[1]);
    if (fail.has(id)) throw new Error(`HTTP 500`);
    return items.has(id) ? items.get(id) : null;
  };
  return { items, fetchJson, calls: () => calls };
}

test('firebase: normalizeItem maps an item onto the story shape', () => {
  const s = normalizeItem({
    id: 49410949, type: 'story', by: 'jsnell', time: start + 60,
    title: '  Predicting AI model release dates with stats  ',
    url: 'https://blog.nihilty.com/p/dates', score: 28, descendants: 3,
  }, 1234);

  assert.deepEqual(s, {
    id: 49410949,
    title: 'Predicting AI model release dates with stats',
    url: 'https://blog.nihilty.com/p/dates',
    domain: 'blog.nihilty.com',
    author: 'jsnell',
    points: 28,
    num_comments: 3,
    created_at: start + 60,
    day: dayKey(start + 60),
    fetched_at: 1234,
  });
});

test('firebase: normalizeItem defaults a self post to no url and zero counts', () => {
  const s = normalizeItem({ id: 7, type: 'story', by: 'a', time: start, title: 'Ask HN: anything?' });
  assert.equal(s.url, null);
  assert.equal(s.domain, null);
  assert.equal(s.points, 0);
  assert.equal(s.num_comments, 0);
});

test('firebase: normalizeItem rejects anything that is not a live story', () => {
  const base = { id: 1, type: 'story', by: 'a', time: start, title: 'T', score: 5 };
  assert.equal(normalizeItem(null), null);
  assert.equal(normalizeItem(undefined), null);
  assert.equal(normalizeItem({ ...base, deleted: true }), null);
  assert.equal(normalizeItem({ ...base, dead: true }), null);
  assert.equal(normalizeItem({ ...base, type: 'comment' }), null);
  assert.equal(normalizeItem({ ...base, type: 'job' }), null);
  assert.equal(normalizeItem({ ...base, type: 'poll' }), null);
  assert.equal(normalizeItem({ ...base, title: '   ' }), null);
  assert.equal(normalizeItem({ ...base, time: undefined }), null);
});

test('firebase: idRangeForDay bisects to the first id at or after midnight', async () => {
  const { fetchJson, calls } = world();
  const { lo, hi } = await idRangeForDay(DAY, { fetchJson, pad: 0 });

  // 1030 is the first item at or after midnight; nothing in the fake reaches
  // the next midnight, so the range runs to the tip of the site.
  assert.equal(lo, 1030);
  assert.equal(hi, 1099);
  // A bisect, not a scan: ~2 * log2(100) probes plus the maxitem lookup.
  assert.ok(calls() < 30, `${calls()} requests`);
});

test('firebase: idRangeForDay pads the range to absorb out-of-order ids', async () => {
  const { fetchJson } = world();
  const { lo, hi } = await idRangeForDay(DAY, { fetchJson, pad: 5 });
  assert.equal(lo, 1025);
  assert.equal(hi, 1099); // clamped to maxitem, never past the tip
});

test('firebase: backfillDays recovers the live stories a day is missing', async (t) => {
  rmSync(DB, { force: true });
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); });
  const { fetchJson } = world();

  const seen = [];
  const result = await backfillDays(conn, [DAY], {
    fetchJson, pad: 0, concurrency: 4, onProgress: (p) => seen.push(p),
  });

  // Ids 1030..1099 is 70 items: 1040 is a comment, 1041 dead, 1042 deleted,
  // 1043 absent and 1044 below the floor, leaving 65 recoverable stories.
  assert.equal(result.scanned, 70);
  assert.equal(result.stories, 65);
  assert.equal(result.recovered, 65);
  assert.equal(result.updated, 0);
  assert.deepEqual(result.failures, []);

  const rows = conn.prepare('SELECT COUNT(*) AS n FROM stories').get();
  assert.equal(rows.n, 65);
  const one = conn.prepare('SELECT * FROM stories WHERE id = 1050').get();
  assert.equal(one.title, 'Story 1050');
  assert.equal(one.domain, 'ex.dev');
  assert.equal(one.day, DAY);
  assert.equal(conn.prepare('SELECT * FROM stories WHERE id = 1040').get(), undefined);
  assert.equal(conn.prepare('SELECT * FROM stories WHERE id = 1044').get(), undefined);

  // Progress is reported once per day, so a long run is legible.
  assert.equal(seen.length, 1);
  assert.equal(seen[0].day, DAY);
  assert.equal(seen[0].recovered, 65);
});

test('firebase: backfillDays records a failing id and steps over it', async (t) => {
  rmSync(DB, { force: true });
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); });
  const { fetchJson } = world({ fail: new Set([1050, 1051]) });

  const result = await backfillDays(conn, [DAY], { fetchJson, pad: 0, concurrency: 4 });

  assert.equal(result.recovered, 63);
  assert.deepEqual(result.failures.map((f) => f.id), [1050, 1051]);
  assert.match(result.failures[0].error, /500/);
  // The rest of the day still landed.
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM stories').get().n, 63);
});

test('firebase: backfillDays is idempotent and never lowers a story it already has', async (t) => {
  rmSync(DB, { force: true });
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); });
  const { fetchJson } = world();

  // A story Algolia did index, with a higher points count than the fake serves.
  upsertStory(conn, {
    id: 1050, title: 'Story 1050', url: 'https://ex.dev/1050', domain: 'ex.dev',
    author: 'u1050', points: 400, num_comments: 99,
    created_at: start, day: DAY, fetched_at: 1,
  });

  const first = await backfillDays(conn, [DAY], { fetchJson, pad: 0, concurrency: 4 });
  assert.equal(first.recovered, 64);
  assert.equal(first.updated, 1);

  const kept = conn.prepare('SELECT points, num_comments FROM stories WHERE id = 1050').get();
  assert.equal(kept.points, 400, 'a backfill must not undo a higher points count');
  assert.equal(kept.num_comments, 99);

  // Re-running is safe: everything is already there, so nothing is new.
  const again = await backfillDays(conn, [DAY], { fetchJson, pad: 0, concurrency: 4 });
  assert.equal(again.recovered, 0);
  assert.equal(again.updated, 65);
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM stories').get().n, 65);
});

test('firebase: backfillDays dry run reports the gap without writing', async (t) => {
  rmSync(DB, { force: true });
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); });
  const { fetchJson } = world();

  const result = await backfillDays(conn, [DAY], { fetchJson, pad: 0, concurrency: 4, dryRun: true });

  assert.equal(result.dryRun, true);
  assert.equal(result.stories, 65);
  assert.equal(result.recovered, 65);
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM stories').get().n, 0);
});

test('firebase: backfillDays respects the points floor', async (t) => {
  rmSync(DB, { force: true });
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); });
  const { fetchJson } = world();

  // Dropping the floor to zero lets id 1044 (1 point) through.
  const result = await backfillDays(conn, [DAY], { fetchJson, pad: 0, concurrency: 4, minPoints: 0 });
  assert.equal(result.stories, 66);
  assert.ok(conn.prepare('SELECT * FROM stories WHERE id = 1044').get());
});
