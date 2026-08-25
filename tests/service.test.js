import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { openDb, upsertStory, recordVote, deleteVote } from '../src/db.js';
import { ingest, backfill, fetchDay, normalize, dayKey, dayBounds, recentDays, daysBetween } from '../src/hn.js';
import {
  trainAndScore, feed, trainingQueue, explain, stats, resetModelCache, scoreMissing, storiesPerDay, scoreDistribution, SCORE_BINS,
} from '../src/service.js';

const DB = new URL('./data/tmp-service.db', import.meta.url).pathname;
const now = Math.floor(Date.now() / 1000);

function seed(conn) {
  const rows = [
    [1, 'Rust borrow checker internals', 'https://rustblog.dev/a', 120],
    [2, 'Writing a compiler in Rust', 'https://rustblog.dev/b', 90],
    [3, 'Rust async runtime design', 'https://tokio.rs/c', 70],
    [4, 'Apple announces the new iPhone', 'https://apple.com/a', 300],
    [5, 'iPhone camera review', 'https://theverge.com/b', 250],
    [6, 'Apple Vision Pro sales slump', 'https://theverge.com/c', 200],
    [7, 'A tiny compiler for a toy language', 'https://compilers.dev/d', 40],
    [8, 'Apple stock hits a record high', 'https://cnbc.com/e', 500],
  ];
  for (const [id, title, url, comments] of rows) {
    upsertStory(conn, {
      id, title, url, domain: new URL(url).hostname, author: `u${id}`,
      points: comments, num_comments: comments,
      created_at: now - id * 3600, day: dayKey(now - id * 3600), fetched_at: now,
    });
  }
}

test('service: train, score, rank and explain', (t) => {
  rmSync(DB, { force: true });
  resetModelCache();
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); resetModelCache(); });

  seed(conn);

  // Not enough evidence yet.
  const cold = trainAndScore(conn);
  assert.equal(cold.trained, false);
  assert.equal(cold.reason, 'need_more_votes');

  // The queue falls back to the most discussed stories before any model exists.
  const coldQueue = trainingQueue(conn, { limit: 3 });
  assert.deepEqual(coldQueue.map((s) => s.id), [8, 4, 5]);
  assert.ok(coldQueue.every((s) => s.reason === 'popular'));

  for (const id of [1, 2, 3, 7]) recordVote(conn, id, 1);
  for (const id of [4, 5, 6, 8]) recordVote(conn, id, -1);

  const trained = trainAndScore(conn);
  assert.equal(trained.trained, true);
  assert.equal(trained.scored, 8);
  assert.ok(trained.metrics.accuracy >= 0.75, `accuracy ${trained.metrics.accuracy}`);

  // A brand new story is scored the way the votes imply.
  upsertStory(conn, {
    id: 9, title: 'Rust compiler plugins explained', url: 'https://rustblog.dev/f',
    domain: 'rustblog.dev', author: 'u9', points: 10, num_comments: 10,
    created_at: now - 600, day: dayKey(now - 600), fetched_at: now,
  });
  assert.equal(scoreMissing(conn), 1);
  const scored = conn.prepare('SELECT score FROM scores WHERE story_id = 9').get();
  assert.ok(scored.score > 0.55, `expected a warm score, got ${scored.score}`);

  const ranked = feed(conn, { mode: 'foryou', days: 0 });
  assert.equal(ranked.items[0].id, 9, 'the unvoted match should lead the feed');
  assert.ok(ranked.items.every((s) => !s.vote), 'judged stories are hidden by default');

  const withVoted = feed(conn, { mode: 'foryou', days: 0, includeVoted: true });
  assert.equal(withVoted.total, 9);

  const filtered = feed(conn, { mode: 'foryou', days: 0, minScore: 0.55, includeVoted: true });
  assert.ok(filtered.total < 9 && filtered.items.every((s) => s.score >= 0.55));

  const topMode = feed(conn, { mode: 'top', days: 0, includeVoted: true });
  assert.equal(topMode.items[0].id, 8, 'most-commented mode ignores taste');

  const searched = feed(conn, { days: 0, includeVoted: true, query: 'iphone' });
  assert.equal(searched.total, 2);

  const discussed = feed(conn, { days: 0, includeVoted: true, minComments: 100 });
  assert.ok(discussed.total > 0 && discussed.items.every((s) => s.num_comments >= 100));

  const why = explain(conn, 9);
  assert.ok(why.contributions.length > 0);
  assert.ok(why.contributions.some((c) => c.label.includes('rust') || c.label === 'rustblog.dev'),
    JSON.stringify(why.contributions.slice(0, 3)));

  const s = stats(conn);
  assert.equal(s.votes.up, 4);
  assert.equal(s.votes.down, 4);
  assert.ok(s.model.insights.likes.length > 0);

  // Score distribution: every scored story lands in exactly one bin, votes
  // are overlaid in the bin of the story they were cast on.
  const d = s.model.distribution;
  assert.equal(d.rev, s.model.rev);
  assert.equal(d.bins.length, SCORE_BINS);
  const nScored = conn.prepare("SELECT COUNT(*) AS n FROM scores WHERE model_rev = ?").get(d.rev).n;
  assert.equal(d.total, nScored);
  assert.equal(d.bins.reduce((n, b) => n + b.all, 0), nScored);
  assert.equal(d.unvoted, nScored - 8);
  assert.equal(d.bins.reduce((n, b) => n + b.unvoted, 0), nScored - 8);
  assert.equal(d.bins.reduce((n, b) => n + b.up, 0), 4);
  assert.equal(d.bins.reduce((n, b) => n + b.down, 0), 4);
  const top = conn.prepare('SELECT score FROM scores ORDER BY score DESC LIMIT 1').get().score;
  assert.ok(d.bins[Math.min(Math.floor(top * SCORE_BINS), SCORE_BINS - 1)].all > 0);
});

test('score distribution is null before the first model', (t) => {
  rmSync(DB, { force: true });
  resetModelCache();
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); resetModelCache(); });
  seed(conn);
  assert.equal(scoreDistribution(conn), null);
});

test('training queue prefers titles the model is unsure about', (t) => {
  rmSync(DB, { force: true });
  resetModelCache();
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); resetModelCache(); });

  seed(conn);
  for (const id of [1, 2, 3]) recordVote(conn, id, 1);
  for (const id of [4, 5, 6]) recordVote(conn, id, -1);
  trainAndScore(conn);

  // Two unjudged stories remain: a clear Rust match and a clear Apple mismatch.
  const queue = trainingQueue(conn, { limit: 2, explore: 0 });
  const scores = queue.map((s) => Math.abs(s.score - 0.5));
  assert.deepEqual([...scores].sort((a, b) => a - b), scores, 'least certain first');
  assert.equal(queue[0].reason, 'uncertain');
});

test('hn: day helpers and hit normalisation', () => {
  assert.equal(dayKey(1755993599), '2025-08-23');
  assert.deepEqual(dayBounds('2025-08-23'), { start: 1755907200, end: 1755993600 });
  assert.deepEqual(recentDays(3, new Date('2025-08-23T10:00:00Z')), ['2025-08-23', '2025-08-22', '2025-08-21']);

  const s = normalize({
    objectID: '42', title: '  Hello  ', url: 'https://Example.com/x',
    author: 'ada', points: 7, num_comments: 3, created_at_i: 1755993500,
  }, 999);
  assert.deepEqual(s, {
    id: 42, title: 'Hello', url: 'https://Example.com/x', domain: 'example.com',
    author: 'ada', points: 7, num_comments: 3, created_at: 1755993500,
    day: '2025-08-23', fetched_at: 999,
  });
  assert.equal(normalize({ objectID: '1' }), null, 'a hit without a title is dropped');
});

test('hn: ingest upserts and keeps the highest counts', async (t) => {
  rmSync(DB, { force: true });
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); });

  const hit = (over) => ({
    objectID: '100', title: 'Same story', url: 'https://a.dev/x',
    author: 'ada', points: 10, num_comments: 5, created_at_i: now, ...over,
  });

  const deps = {
    fetchDay: async () => [normalize(hit())],
    fetchFrontPage: async () => [normalize(hit({ points: 99, num_comments: 88 }))],
  };
  const result = await ingest(conn, { days: 2, deps });
  assert.equal(result.fetched, 3);
  assert.equal(result.inserted, 1, 'the same story id is upserted, not duplicated');

  const row = conn.prepare('SELECT points, num_comments FROM stories WHERE id = 100').get();
  assert.deepEqual({ ...row }, { points: 99, num_comments: 88 });
});

test('hn: a points floor is pushed down into the API query', async (t) => {
  const urls = [];
  const fetchJson = async (url) => { urls.push(url); return { hits: [], nbPages: 1 }; };

  await fetchDay('2026-01-05', { pages: 1, minPoints: 3, fetchJson });
  assert.match(urls[0], /numericFilters=created_at_i>=\d+,created_at_i<\d+,points>=3&/);

  await fetchDay('2026-01-05', { pages: 1, fetchJson });
  assert.ok(!urls[1].includes('points'), 'no floor, no filter');

  // ingest and backfill filter by default; --points 0 turns it off.
  rmSync(DB, { force: true });
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); });
  const seen = [];
  const deps = {
    fetchDay: async (day, opts) => { seen.push(opts.minPoints); return []; },
    fetchFrontPage: async () => [],
  };
  await ingest(conn, { days: 1, deps });
  await backfill(conn, { from: '2026-01-01', to: '2026-01-01', throttleMs: 0, deps });
  await backfill(conn, { from: '2026-01-01', to: '2026-01-01', throttleMs: 0, minPoints: 0, deps });
  assert.deepEqual(seen, [3, 3, 0]);
});

test('hn: daysBetween spans the range inclusively, oldest first', () => {
  assert.deepEqual(daysBetween('2026-01-30', '2026-02-02'),
    ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
  assert.deepEqual(daysBetween('2026-05-01', '2026-05-01'), ['2026-05-01']);
  assert.throws(() => daysBetween('2026-05-02', '2026-05-01'), /empty range/);
  assert.throws(() => daysBetween('not-a-day', '2026-05-01'), /bad day/);
});

test('hn: backfill skips covered days, survives failures, and resumes', async (t) => {
  rmSync(DB, { force: true });
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); });

  // 2026-01-02 is already densely covered — it must not be refetched.
  const covered = dayBounds('2026-01-02').start;
  for (let i = 0; i < 100; i++) {
    upsertStory(conn, {
      id: 1000 + i, title: `Old story ${i}`, url: `https://a.dev/${i}`, domain: 'a.dev',
      author: 'ada', points: i, num_comments: i,
      created_at: covered + i, day: '2026-01-02', fetched_at: now,
    });
  }

  const asked = [];
  const deps = {
    fetchDay: async (day) => {
      asked.push(day);
      if (day === '2026-01-03') throw new Error('HTTP 503');
      const { start } = dayBounds(day);
      return [normalize({
        objectID: String(start), title: `Top of ${day}`, url: `https://b.dev/${day}`,
        author: 'ada', points: 10, num_comments: 5, created_at_i: start,
      })];
    },
  };

  const run = await backfill(conn, { from: '2026-01-01', to: '2026-01-04', throttleMs: 0, deps });
  assert.deepEqual(asked, ['2026-01-01', '2026-01-03', '2026-01-04'], 'the covered day is never requested');
  assert.equal(run.days, 4);
  assert.equal(run.skipped, 1);
  assert.equal(run.fetchedDays, 2);
  assert.equal(run.inserted, 2);
  assert.deepEqual(run.failures.map((f) => f.day), ['2026-01-03'], 'a failing day is recorded, not fatal');

  // Rerunning the same range only retries the day that failed.
  asked.length = 0;
  deps.fetchDay = async (day) => {
    asked.push(day);
    const { start } = dayBounds(day);
    return Array.from({ length: 100 }, (_, i) => normalize({
      objectID: String(start + i), title: `Top ${i} of ${day}`, url: `https://b.dev/${day}/${i}`,
      author: 'ada', points: 10, num_comments: 5, created_at_i: start + i,
    }));
  };
  const rerun = await backfill(conn, { from: '2026-01-01', to: '2026-01-04', throttleMs: 0, deps });
  assert.deepEqual(asked, ['2026-01-01', '2026-01-03', '2026-01-04'],
    'days below the threshold are refetched, the failed gap is filled');
  assert.equal(rerun.failures.length, 0);
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM stories WHERE day = '2026-01-03'").get().n, 100);

  // A third run has nothing left to do.
  const done = await backfill(conn, { from: '2026-01-01', to: '2026-01-04', throttleMs: 0, deps });
  assert.equal(done.skipped, 4);
  assert.equal(done.fetched, 0);
});

test('HN reposts: same-URL twins share votes and never both appear', (t) => {
  rmSync(DB, { force: true });
  resetModelCache();
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); resetModelCache(); });

  seed(conn);
  const twin = (id, comments) => upsertStory(conn, {
    id, title: 'Making LEDs at Home [video]', url: 'https://youtube.com/watch?v=x',
    domain: 'youtube.com', author: `u${id}`, points: comments, num_comments: comments,
    created_at: now - 100, day: dayKey(now - 100), fetched_at: now,
  });
  twin(100, 50);
  twin(101, 5);
  upsertStory(conn, { // same normalized title, different URL — also a repost in practice
    id: 102, title: 'Making LEDs at home [video]', url: 'https://youtu.be/x',
    domain: 'youtu.be', author: 'u102', points: 1, num_comments: 1,
    created_at: now - 100, day: dayKey(now - 100), fetched_at: now,
  });

  const queue = trainingQueue(conn, { limit: 50 });
  const led = queue.filter((s) => s.title.toLowerCase().startsWith('making leds'));
  assert.equal(led.length, 1, 'only one of the three submissions is offered');
  assert.equal(led[0].id, 100, 'the most discussed twin wins');

  recordVote(conn, 100, -1);
  const votes = conn.prepare('SELECT story_id, value FROM votes ORDER BY story_id').all();
  assert.deepEqual(votes.map((v) => [v.story_id, v.value]), [[100, -1], [101, -1]],
    'the vote propagates to the same-URL twin (URL match only, not title)');

  const queueAfter = trainingQueue(conn, { limit: 50 });
  assert.ok(!queueAfter.some((s) => s.id === 100 || s.id === 101));

  deleteVote(conn, 101);
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 0,
    'undo clears the twin too, from either id');
});

test('stories-per-day window ignores stray ancient stories', (t) => {
  rmSync(DB, { force: true });
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); });

  seed(conn); // 8 stories within the last few hours
  // A repost carrying a created_at from ~200 days ago must not stretch the
  // chart into months of empty days — it is summarised, not drawn.
  const ancient = now - 200 * 86400;
  upsertStory(conn, {
    id: 300, title: 'A story from another era', url: 'https://old.dev/a',
    domain: 'old.dev', author: 'u300', points: 1, num_comments: 1,
    created_at: ancient, day: dayKey(ancient), fetched_at: now,
  });

  const { days, older } = storiesPerDay(conn);
  assert.ok(days.length <= 60, `window capped, got ${days.length} days`);
  assert.equal(days.reduce((sum, d) => sum + d.count, 0), 8, 'only in-window stories are drawn');
  assert.deepEqual(older, { days: 1, stories: 1, before: days[0].day });
  for (let i = 1; i < days.length; i++) {
    assert.equal(Date.parse(`${days[i].day}T00:00:00Z`) - Date.parse(`${days[i - 1].day}T00:00:00Z`), 86400_000);
  }
});

test('training set collapses identical titles to one example', (t) => {
  rmSync(DB, { force: true });
  resetModelCache();
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); resetModelCache(); });

  seed(conn);
  for (const id of [1, 2, 3]) recordVote(conn, id, 1);
  for (const id of [4, 5, 6]) recordVote(conn, id, -1);
  // a repost of story 1's title, judged separately
  upsertStory(conn, {
    id: 200, title: 'Rust borrow checker internals', url: 'https://mirror.dev/a',
    domain: 'mirror.dev', author: 'u200', points: 1, num_comments: 1,
    created_at: now - 50, day: dayKey(now - 50), fetched_at: now,
  });
  recordVote(conn, 200, 1);

  const result = trainAndScore(conn);
  assert.equal(result.trained, true);
  assert.equal(result.metrics.n, 6, 'seven votes, six unique titles');
});

test('feed counts and orders the whole corpus, not a fixed candidate window', (t) => {
  rmSync(DB, { force: true });
  resetModelCache();
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); resetModelCache(); });

  // Well past the old 6000-row cap. Like real HN, higher ids are newer, and
  // the very newest story is also the most discussed.
  const N = 6500;
  conn.exec('BEGIN');
  for (let i = 1; i <= N; i++) {
    const created = now - (N - i) * 30;
    upsertStory(conn, {
      id: i, title: `Story number ${i}`, url: `https://s.dev/${i}`, domain: 's.dev', author: 'ada',
      points: i === N ? 9999 : i % 100, num_comments: i === N ? 9999 : i % 100,
      created_at: created, day: dayKey(created), fetched_at: now,
    });
  }
  conn.exec('COMMIT');

  const newest = feed(conn, { mode: 'new', days: 0, limit: 3 });
  assert.equal(newest.total, N, 'total is the real count');
  assert.equal(newest.items[0].id, N, 'the newest story leads');

  const top = feed(conn, { mode: 'top', days: 0, limit: 1 });
  assert.equal(top.items[0].id, N);

  const page2 = feed(conn, { mode: 'new', days: 0, limit: 50, offset: 50 });
  assert.equal(page2.items.length, 50);
  assert.equal(page2.items[0].id, N - 50, 'offset pages continue the same order');

  const hybrid = feed(conn, { mode: 'hybrid', days: 0, limit: 1 });
  assert.equal(hybrid.total, N);
  assert.equal(hybrid.items[0].id, N, 'with no model, blend is driven by the crowd');

  const queue = trainingQueue(conn, { limit: 1, days: 365 });
  assert.equal(queue[0].id, N, 'the queue sees the newest stories');
});
