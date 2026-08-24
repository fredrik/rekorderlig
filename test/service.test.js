import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { openDb, upsertStory, recordVote, deleteVote } from '../src/db.js';
import { ingest, normalize, normalizeItem, fetchLive, dayKey, dayBounds, recentDays } from '../src/hn.js';
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

test('hn: firebase item normalisation', () => {
  const s = normalizeItem({
    id: 7, type: 'story', title: ' Hi ', url: 'https://Example.com/y',
    by: 'ada', score: 4, descendants: 2, time: 1755993500,
  }, 999);
  assert.deepEqual(s, {
    id: 7, title: 'Hi', url: 'https://Example.com/y', domain: 'example.com',
    author: 'ada', points: 4, num_comments: 2, created_at: 1755993500,
    day: '2025-08-23', fetched_at: 999,
  });
  assert.equal(normalizeItem(null), null);
  assert.equal(normalizeItem({ id: 8, type: 'comment', title: 'x', time: 1 }), null);
  assert.equal(normalizeItem({ id: 9, type: 'story', title: 'x', time: 1, dead: true }), null);
});

test('hn: fetchLive pulls items newer than `since` from both id lists', async () => {
  const item = (id, time) => ({ id, type: 'story', title: `t${id}`, time, by: 'ada' });
  const pages = {
    'https://hacker-news.firebaseio.com/v0/newstories.json': [1, 2],
    'https://hacker-news.firebaseio.com/v0/topstories.json': [2, 3, 4],
    'https://hacker-news.firebaseio.com/v0/item/1.json': item(1, 1000),
    'https://hacker-news.firebaseio.com/v0/item/2.json': item(2, 500),
    'https://hacker-news.firebaseio.com/v0/item/3.json': item(3, 2000),
    'https://hacker-news.firebaseio.com/v0/item/4.json': null, // not yet readable
  };
  const stories = await fetchLive({ since: 900, fetchJson: async (url) => pages[url] });
  assert.deepEqual(stories.map((s) => s.id).sort(), [1, 3], 'old and unreadable items are dropped');
});

test('hn: ingest falls back to the live API only when the corpus is stale', async (t) => {
  rmSync(DB, { force: true });
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); });

  const story = (id, age, over = {}) => normalize({
    objectID: String(id), title: `Story ${id}`, url: `https://a.dev/${id}`,
    author: 'ada', points: 1, num_comments: 1, created_at_i: now - age, ...over,
  });

  // Algolia serves nothing newer than 27h, as during an indexing outage.
  const liveCalls = [];
  const deps = {
    fetchDay: async () => [story(1, 27 * 3600)],
    fetchFrontPage: async () => [story(2, 30 * 3600)],
    fetchLive: async ({ since }) => { liveCalls.push(since); return [story(3, 60)]; },
  };
  const stale = await ingest(conn, { days: 2, deps });
  assert.equal(liveCalls.length, 1);
  assert.equal(liveCalls[0], now - 27 * 3600, 'asks for the gap since the newest known story');
  assert.equal(stale.live, 1);
  assert.equal(stale.fetched, 4, 'two day pages, the front page and one live story');
  assert.ok(conn.prepare('SELECT 1 FROM stories WHERE id = 3').get(), 'the fresh story landed');

  // Now the corpus ends a minute ago, so a second ingest must not touch the live API.
  const fresh = await ingest(conn, { days: 2, deps });
  assert.equal(liveCalls.length, 1, 'no fallback when the corpus is fresh');
  assert.equal(fresh.live, 0);
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
