import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

const DB = new URL('./data/tmp-api.db', import.meta.url).pathname;
rmSync(DB, { force: true });
process.env.REKORDERLIG_DB = DB;
process.env.NODE_ENV = 'test';

const { server, conn } = await import('../src/server.js');
const { trainingIdle } = await import('../src/trainer.js');
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
  for (const path of ['/train', '/explore', '/feed', '/votes', '/brain']) {
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

test('per-vote import rejects an incomplete payload', async () => {
  const noId = await post('/api/import/vote', { value: 1, created_at: 1787574980 });
  assert.equal(noId.status, 400);
  assert.match(noId.body.error, /story_id/);
  assert.equal((await post('/api/import/vote', { story_id: 1, value: 7, created_at: 1787574980 })).status, 400);
  // The whole point of the endpoint is the historical timestamp, so it is required.
  const noStamp = await post('/api/import/vote', { story_id: 1, value: 1 });
  assert.equal(noStamp.status, 400);
  assert.match(noStamp.body.error, /created_at/);
});

test('votes train a model that reranks the feed', async () => {
  for (const id of [1, 2, 3]) assert.equal((await post('/api/vote', { id, value: 1 })).status, 200);
  for (const id of [4, 5]) assert.equal((await post('/api/vote', { id, value: -1 })).status, 200);

  const last = await post('/api/vote', { id: 6, value: -1 });
  assert.equal(last.body.training, undefined, 'voting only records; training is a separate trigger');
  assert.deepEqual(last.body.votes, { up: 3, down: 3, skip: 0, total: 6 });
  assert.equal((await get('/api/feed?days=0')).body.hasModel, false);

  // The trigger answers at once and the work happens in a worker thread.
  const trigger = await post('/api/train');
  assert.equal(trigger.status, 202);
  assert.equal(trigger.body.status, 'started');
  assert.equal(trigger.body.running, true);
  // A second trigger mid-run is coalesced into one follow-up run, not dropped.
  assert.equal((await post('/api/train')).body.status, 'queued');

  await trainingIdle();
  const status = await get('/api/train');
  assert.equal(status.body.running, false);
  assert.equal(status.body.pending, false);
  assert.equal(status.body.runs, 2);
  assert.equal(status.body.last.trained, true);
  assert.equal(status.body.lastError, null);

  const { body } = await get('/api/feed?days=0&mode=foryou');
  assert.equal(body.hasModel, true);
  assert.equal(body.items[0].id, 7, 'the unseen Rust story should rank first');
  assert.ok(body.items[0].score > 0.55);

  const explained = await get('/api/explain?id=7');
  assert.ok(explained.body.contributions.length > 0);
});

test('explore serves a tiered deck of stories the crowd stopped on', async () => {
  const { status, body } = await get('/api/explore?days=0');
  assert.equal(status, 200);
  assert.equal(body.hasModel, true);
  // The client quotes these numbers in its empty state, so they travel with it.
  assert.ok(body.bar.minPoints > 0 && body.bar.minComments > 0);

  // 1-6 are judged; 7 is the loud unjudged one the model warmed to.
  assert.deepEqual(body.items.map((s) => s.id), [7]);
  const [story] = body.items;
  assert.equal(story.tier, story.score >= 0.6 ? 'probably' : 'possibly');
  assert.ok(story.points >= body.bar.minPoints || story.num_comments >= body.bar.minComments);

  // The traction bar is the whole point: a story nobody engaged with stays out.
  upsertStory(conn, {
    id: 42, title: 'Rust ownership, one more time', url: 'https://rustblog.dev/quiet',
    domain: 'rustblog.dev', author: 'u42', points: 2, num_comments: 1,
    created_at: now - 120, day: dayKey(now - 120), fetched_at: now,
  });
  assert.ok(!(await get('/api/explore?days=0')).body.items.some((s) => s.id === 42));
  // Later tests count the corpus, so put it back the way it was.
  conn.prepare('DELETE FROM stories WHERE id = 42').run();
});

test('the min-match filter drops weak stories', async () => {
  const all = await get('/api/feed?days=0&includeVoted=1');
  const strict = await get('/api/feed?days=0&includeVoted=1&minScore=0.55');
  assert.ok(strict.body.total < all.body.total);
  assert.ok(strict.body.items.every((s) => s.score >= 0.55));
});

test('sync reports its own status without blocking a request', async () => {
  // POST /api/sync would hit the real HN API, so this only pins the contract
  // the UI polls: a status document, idle until something starts a run.
  const { status, body } = await get('/api/sync');
  assert.equal(status, 200);
  assert.equal(body.running, false);
  assert.equal(body.runs, 0);
  assert.equal(body.last, null);
});

test('undo removes a vote without retraining', async () => {
  const before = (await get('/api/stats')).body.model.rev;
  const res = await post('/api/unvote', { id: 6 });
  assert.equal(res.body.votes.down, 2);
  const stats = await get('/api/stats');
  assert.equal(stats.body.votes.total, 5);
  assert.equal(stats.body.model.rev, before, 'the client decides when to retrain');
});

test('training reports need_more_votes instead of failing', async () => {
  // 3 up / 2 down after the undo above: below the minimum.
  assert.equal((await post('/api/train')).status, 202);
  await trainingIdle();
  const { body } = await get('/api/train');
  assert.equal(body.last.trained, false);
  assert.equal(body.last.reason, 'need_more_votes');
  assert.deepEqual(body.last.need, { up: 0, down: 1 });
});

test('an exported vote imports back one at a time, timestamp and all', async () => {
  const exported = await get('/api/export');
  assert.equal(exported.body.votes.length, 5);
  assert.ok(exported.body.votes[0].title);

  const one = exported.body.votes.find((v) => v.story_id === 1);
  await post('/api/unvote', { id: 1 });
  assert.equal((await get('/api/stats')).body.votes.total, 4);

  const back = await post('/api/import/vote', one);
  assert.equal(back.status, 200);
  assert.equal(back.body.fetched, false, 'story 1 is already in the corpus, so no HN lookup');
  assert.equal(back.body.story.title, one.title, 'the stored story comes back for eyeballing');
  assert.equal((await get('/api/stats')).body.votes.total, 5);
  assert.equal(
    conn.prepare('SELECT created_at FROM votes WHERE story_id = 1').get().created_at,
    one.created_at, 'the historical vote time is kept, not stamped with now',
  );

  // Re-running the import is idempotent, and the payload stays the authority
  // on when the vote was cast.
  const then = one.created_at - 86400;
  const again = await post('/api/import/vote', { ...one, created_at: then });
  assert.equal(again.status, 200);
  assert.equal((await get('/api/stats')).body.votes.total, 5);
  const row = conn.prepare('SELECT created_at, updated_at FROM votes WHERE story_id = 1').get();
  assert.equal(row.created_at, then);
  assert.equal(row.updated_at, then, 'a restored vote is the row as it was, not touched-just-now');

  // The Votes view reads updated_at, so a restored history must read as the day
  // it was cast, not as "a minute ago".
  const listed = (await get('/api/votes')).body.items.find((v) => v.id === 1);
  assert.equal(listed.voted_at, then);
});

test('the votes list shows every verdict, filterable and paged', async () => {
  // 1,2,3 up and 4,5 down survive the import round-trip above.
  const all = await get('/api/votes');
  assert.equal(all.body.total, 5);
  assert.deepEqual(all.body.counts, { up: 3, down: 2, skip: 0, total: 5 });
  assert.deepEqual(all.body.items.map((r) => r.id), [5, 4, 3, 2, 1], 'newest verdict first');
  assert.ok(all.body.items[0].title && all.body.items[0].voted_at);

  const up = await get('/api/votes?value=1');
  assert.equal(up.body.total, 3);
  assert.ok(up.body.items.every((r) => r.vote === 1));

  const page = await get('/api/votes?limit=2&offset=2');
  assert.equal(page.body.total, 5, 'total counts every match, not just the page');
  assert.deepEqual(page.body.items.map((r) => r.id), [3, 2]);

  const bad = await get('/api/votes?value=7');
  assert.equal(bad.status, 400);
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

