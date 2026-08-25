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

test('serves the app shell for section paths', async () => {
  for (const path of ['/train', '/feed', '/brain']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /rekorder/);
  }
});

test('unknown paths still 404', async () => {
  const res = await fetch(base + '/nonsense');
  assert.equal(res.status, 404);
});

test('refuses to escape the public directory', async () => {
  const res = await fetch(base + '/../package.json');
  assert.equal(res.status, 404);
});

test('rejects malformed votes', async () => {
  assert.equal((await post('/api/vote', { id: 1, value: 5 })).status, 400);
  assert.equal((await post('/api/vote', { value: 1 })).status, 400);
  assert.equal((await post('/api/vote', { id: 9999, value: 1 })).status, 404);
  assert.equal((await post('/api/unvote', {})).status, 400);
});

test('client errors are 4xx, not 500', async () => {
  const bad = await fetch(base + '/api/vote', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
  });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /invalid JSON/);
  const notObject = await post('/api/vote', 42);
  assert.equal(notObject.status, 400);
});

test('import ignores votes with out-of-range values', async () => {
  const res = await post('/api/import', { votes: [{ story_id: 1, value: 7 }, null, { story_id: 2 }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.applied, 0);
  assert.equal(res.body.skipped, 3);
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

test('per-day counts cover the whole corpus with no gaps', async () => {
  const { status, body } = await get('/api/days');
  assert.equal(status, 200);
  assert.equal(body.older, null, 'nothing in this corpus predates the window');
  assert.ok(body.days.length <= 60, 'the chart window is capped');
  assert.ok(body.days.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.day)));
  assert.equal(body.days.reduce((sum, d) => sum + d.count, 0), STORIES.length);
  // days are contiguous and sorted: each entry is exactly one day after the previous
  for (let i = 1; i < body.days.length; i++) {
    const prev = Date.parse(`${body.days[i - 1].day}T00:00:00Z`);
    assert.equal(Date.parse(`${body.days[i].day}T00:00:00Z`) - prev, 86400_000);
  }
});

test('unknown routes 404 as JSON', async () => {
  const res = await get('/api/nope');
  assert.equal(res.status, 404);
  assert.match(res.body.error, /no route/);
});

test('CSV export is well-formed and quoted', async () => {
  const res = await fetch(base + '/api/export?format=csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const lines = (await res.text()).trim().split('\n');
  assert.equal(lines[0], 'story_id,vote,value,voted_at,title,url,domain');
  assert.equal(lines.length, 1 + 5, 'header plus one row per vote');
  assert.ok(lines.some((l) => l.includes(',up,') || l.includes(',down,')));
});
