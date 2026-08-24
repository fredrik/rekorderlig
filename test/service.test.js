import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { openDb, upsertStory, recordVote } from '../src/db.js';
import { ingest, normalize, dayKey, dayBounds, recentDays } from '../src/hn.js';
import { trainAndScore, feed, trainingQueue, explain, stats, resetModelCache, scoreMissing } from '../src/service.js';

const DB = new URL('./tmp-service.db', import.meta.url).pathname;
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

  const why = explain(conn, 9);
  assert.ok(why.contributions.length > 0);
  assert.ok(why.contributions.some((c) => c.label.includes('rust') || c.label === 'rustblog.dev'),
    JSON.stringify(why.contributions.slice(0, 3)));

  const s = stats(conn);
  assert.equal(s.votes.up, 4);
  assert.equal(s.votes.down, 4);
  assert.ok(s.model.insights.likes.length > 0);
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
