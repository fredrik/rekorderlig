import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const DB = new URL('./tmp-api.db', import.meta.url).pathname;
rmSync(DB, { force: true });
process.env.REKORDERLIG_DB = DB;
process.env.NODE_ENV = 'test';

const { server, conn } = await import('../src/server.js');
const { upsertStory } = await import('../src/db.js');
const { dayKey } = await import('../src/hn.js');

const now = Math.floor(Date.now() / 1000);
const STORIES = [
  [1, 'Rust borrow checker internals', 'https://rustblog.dev/a'],
  [2, 'Writing a compiler in Rust', 'https://rustblog.dev/b'],
  [3, 'Rust async runtime design', 'https://tokio.rs/c'],
  [4, 'Apple announces the new iPhone', 'https://apple.com/a'],
  [5, 'iPhone camera review', 'https://theverge.com/b'],
  [6, 'Apple Vision Pro sales slump', 'https://theverge.com/c'],
  [7, 'Rust compiler plugins explained', 'https://rustblog.dev/d'],
];
for (const [id, title, url] of STORIES) {
  upsertStory(conn, {
    id, title, url, domain: new URL(url).hostname, author: `u${id}`,
    points: 100 - id, num_comments: 100 - id,
    created_at: now - id * 60, day: dayKey(now - id * 60), fetched_at: now,
  });
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => { server.close(); conn.close(); rmSync(DB, { force: true }); });

const get = async (path) => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
};
const post = async (path, body) => {
  const res = await fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
};

test('serves the web app', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(await res.text(), /rekorder/);
});

test('refuses to escape the public directory', async () => {
  const res = await fetch(base + '/../package.json');
  assert.equal(res.status, 404);
});

test('rejects malformed votes', async () => {
  assert.equal((await post('/api/vote', { id: 1, value: 5 })).status, 400);
  assert.equal((await post('/api/vote', { value: 1 })).status, 400);
  assert.equal((await post('/api/vote', { id: 9999, value: 1 })).status, 404);
});

test('votes train a model that reranks the feed', async () => {
  for (const id of [1, 2, 3]) assert.equal((await post('/api/vote', { id, value: 1 })).status, 200);
  for (const id of [4, 5]) assert.equal((await post('/api/vote', { id, value: -1 })).status, 200);

  const last = await post('/api/vote', { id: 6, value: -1 });
  assert.equal(last.body.training.trained, true);
  assert.deepEqual(last.body.votes, { up: 3, down: 3, skip: 0, total: 6 });

  const { body } = await get('/api/feed?days=0&mode=foryou');
  assert.equal(body.hasModel, true);
  assert.equal(body.items[0].id, 7, 'the unseen Rust story should rank first');
  assert.ok(body.items[0].score > 0.55);

  const explained = await get('/api/explain?id=7');
  assert.ok(explained.body.contributions.length > 0);
});

test('the min-match filter drops weak stories', async () => {
  const all = await get('/api/feed?days=0&includeVoted=1');
  const strict = await get('/api/feed?days=0&includeVoted=1&minScore=0.55');
  assert.ok(strict.body.total < all.body.total);
  assert.ok(strict.body.items.every((s) => s.score >= 0.55));
});

test('undo removes a vote and retrains', async () => {
  const res = await post('/api/unvote', { id: 6 });
  assert.equal(res.body.votes.down, 2);
  const stats = await get('/api/stats');
  assert.equal(stats.body.votes.total, 5);
});

test('export and import round-trip the vote history', async () => {
  const exported = await get('/api/export');
  assert.equal(exported.body.votes.length, 5);
  assert.ok(exported.body.votes[0].title);

  await post('/api/unvote', { id: 1 });
  const reimported = await post('/api/import', { votes: exported.body.votes });
  assert.equal(reimported.body.applied, 5);
  assert.equal((await get('/api/stats')).body.votes.total, 5);
});

test('unknown routes 404 as JSON', async () => {
  const res = await get('/api/nope');
  assert.equal(res.status, 404);
  assert.match(res.body.error, /no route/);
});
