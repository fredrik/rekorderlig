import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { openDb, upsertStory, recordVote, deleteVote } from '../src/db.js';
import { syncDays, fetchDay, fetchStory, normalize, dayKey, dayBounds, recentDays, daysBetween } from '../src/hn.js';
import {
  trainAndScore, sync, feed, trainingQueue, explain, stats, resetModelCache, scoreMissing, storiesPerDay, scoreDistribution, SCORE_BINS, voteLog,
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

  // A score band, as the Brain histogram uses when a bar is clicked: [min, max).
  const band = feed(conn, { days: 0, includeVoted: true, minScore: 0.3, maxScore: 0.55 });
  assert.ok(band.items.every((s) => s.score >= 0.3 && s.score < 0.55), JSON.stringify(band.items.map((s) => s.score)));
  assert.equal(band.total + filtered.total + feed(conn, { days: 0, includeVoted: true, maxScore: 0.3 }).total,
    feed(conn, { days: 0, includeVoted: true }).total, 'bands partition the corpus');

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

  // Score distribution: every scored, unvoted story lands in exactly one bin.
  const d = s.model.distribution;
  assert.equal(d.rev, s.model.rev);
  assert.equal(d.bins.length, SCORE_BINS);
  const nScored = conn.prepare('SELECT COUNT(*) AS n FROM scores WHERE model_rev = ?').get(d.rev).n;
  assert.equal(d.total, nScored - 8, 'the 8 voted stories are excluded');
  assert.equal(d.bins.reduce((a, b) => a + b, 0), d.total);
  const top = conn.prepare('SELECT score FROM scores WHERE story_id NOT IN (SELECT story_id FROM votes) ORDER BY score DESC LIMIT 1').get().score;
  assert.ok(d.bins[Math.min(Math.floor(top * SCORE_BINS), SCORE_BINS - 1)] > 0);
});

test('the feed never shows unscored stories', (t) => {
  rmSync(DB, { force: true });
  resetModelCache();
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); resetModelCache(); });

  seed(conn);
  // Before any model nothing is scored, so the feed is empty.
  assert.equal(feed(conn, { days: 0 }).total, 0);

  for (const id of [1, 2, 3]) recordVote(conn, id, 1);
  for (const id of [4, 5, 6]) recordVote(conn, id, -1);
  trainAndScore(conn);

  // A story that arrives after training has no score row yet.
  upsertStory(conn, {
    id: 99, title: 'Freshly fetched, not yet scored', url: 'https://x.dev/z', domain: 'x.dev', author: 'u99',
    points: 10, num_comments: 10, created_at: now, day: dayKey(now), fetched_at: now,
  });
  for (const mode of ['foryou', 'hybrid', 'top', 'new']) {
    const ids = feed(conn, { mode, days: 0, includeVoted: true }).items.map((s) => s.id);
    assert.ok(!ids.includes(99), `${mode} leaked an unscored story`);
  }
  assert.ok(!feed(conn, { days: 0, minScore: 0.4, maxScore: 0.6 }).items.some((s) => s.id === 99));

  scoreMissing(conn);
  assert.ok(feed(conn, { mode: 'new', days: 0 }).items.some((s) => s.id === 99), 'shows once scored');
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

test('hn: sync upserts and keeps the highest counts', async (t) => {
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
  const result = await sync(conn, { days: 2, throttleMs: 0, deps });
  assert.equal(result.fetched, 3, 'two days plus the front page');
  assert.equal(result.frontPage, 1, 'today is in the window, so the front page is fetched');
  assert.equal(result.inserted, 1, 'the same story id is upserted, not duplicated');

  const row = conn.prepare('SELECT points, num_comments FROM stories WHERE id = 100').get();
  assert.deepEqual({ ...row }, { points: 99, num_comments: 88 });
  assert.ok(stats(conn).lastSyncAt > 0, 'a sync stamps when data was last fetched');
});

test('hn: sync only asks for the front page when today is in range', async (t) => {
  rmSync(DB, { force: true });
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); });

  let frontPages = 0;
  const deps = { fetchDay: async () => [], fetchFrontPage: async () => { frontPages++; return []; } };
  const past = await sync(conn, { from: '2026-01-01', to: '2026-01-02', throttleMs: 0, deps });
  assert.equal(past.frontPage, 0);
  assert.equal(frontPages, 0, 'an archive fill has nothing to learn from the current front page');

  await sync(conn, { days: 1, throttleMs: 0, deps });
  assert.equal(frontPages, 1);
});

test('hn: a points floor is pushed down into the API query', async (t) => {
  const urls = [];
  const fetchJson = async (url) => { urls.push(url); return { hits: [], nbPages: 1 }; };

  await fetchDay('2026-01-05', { pages: 1, minPoints: 3, fetchJson });
  assert.match(urls[0], /numericFilters=created_at_i>=\d+,created_at_i<\d+,points>=3&/);

  await fetchDay('2026-01-05', { pages: 1, fetchJson });
  assert.ok(!urls[1].includes('points'), 'no floor, no filter');

  // sync filters by default; --points 0 turns it off.
  rmSync(DB, { force: true });
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); });
  const seen = [];
  const deps = {
    fetchDay: async (day, opts) => { seen.push(opts.minPoints); return []; },
    fetchFrontPage: async () => [],
  };
  await sync(conn, { days: 1, throttleMs: 0, deps });
  await sync(conn, { from: '2026-01-01', to: '2026-01-01', throttleMs: 0, deps });
  await sync(conn, { from: '2026-01-01', to: '2026-01-01', throttleMs: 0, minPoints: 0, deps });
  assert.deepEqual(seen, [3, 3, 0]);
});

test('hn: daysBetween spans the range inclusively, oldest first', () => {
  assert.deepEqual(daysBetween('2026-01-30', '2026-02-02'),
    ['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
  assert.deepEqual(daysBetween('2026-05-01', '2026-05-01'), ['2026-05-01']);
  assert.throws(() => daysBetween('2026-05-02', '2026-05-01'), /empty range/);
  assert.throws(() => daysBetween('not-a-day', '2026-05-01'), /bad day/);
});

test('hn: syncDays records a failing day and fills the gap on a rerun', async (t) => {
  rmSync(DB, { force: true });
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); });

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

  const range = daysBetween('2026-01-01', '2026-01-04');
  const run = await syncDays(conn, range, { throttleMs: 0, deps });
  assert.deepEqual(asked, range, 'every day in the range is requested');
  assert.equal(run.days, 4);
  assert.equal(run.fetchedDays, 3);
  assert.equal(run.inserted, 3);
  assert.deepEqual(run.failures.map((f) => f.day), ['2026-01-03'], 'a failing day is recorded, not fatal');

  // Rerunning the same range retries the day that failed along with the rest.
  asked.length = 0;
  deps.fetchDay = async (day) => {
    asked.push(day);
    const { start } = dayBounds(day);
    return Array.from({ length: 100 }, (_, i) => normalize({
      objectID: String(start + i), title: `Top ${i} of ${day}`, url: `https://b.dev/${day}/${i}`,
      author: 'ada', points: 10, num_comments: 5, created_at_i: start + i,
    }));
  };
  const rerun = await syncDays(conn, range, { throttleMs: 0, deps });
  assert.deepEqual(asked, range, 'the failed gap is filled');
  assert.equal(rerun.failures.length, 0);
  assert.equal(conn.prepare("SELECT COUNT(*) AS n FROM stories WHERE day = '2026-01-03'").get().n, 100);
});

test('hn: a day already holding stories is refetched anyway', async (t) => {
  rmSync(DB, { force: true });
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); });

  // A densely covered day used to be skipped; now nothing is.
  const { start } = dayBounds('2026-01-02');
  for (let i = 0; i < 100; i++) {
    upsertStory(conn, {
      id: 1000 + i, title: `Old story ${i}`, url: `https://a.dev/${i}`, domain: 'a.dev',
      author: 'ada', points: i, num_comments: i,
      created_at: start + i, day: '2026-01-02', fetched_at: now,
    });
  }

  const asked = [];
  const deps = { fetchDay: async (day) => { asked.push(day); return []; } };
  const run = await syncDays(conn, ['2026-01-01', '2026-01-02'], { throttleMs: 0, deps });
  assert.deepEqual(asked, ['2026-01-01', '2026-01-02'], 'the covered day is requested too');
  assert.equal(run.fetchedDays, 2);
  assert.equal(run.failures.length, 0);
});

test('hn: syncDays asks for 10 pages a day by default', async (t) => {
  rmSync(DB, { force: true });
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); });

  const seen = [];
  const deps = { fetchDay: async (_day, opts) => { seen.push(opts); return []; } };
  await syncDays(conn, ['2026-01-01'], { throttleMs: 0, deps });
  assert.equal(seen[0].pages, 10);
  assert.equal(seen[0].minPoints, 3, 'the points floor is unchanged');

  // fetchDay stops at the last page, so a quiet day costs less than the ceiling.
  const urls = [];
  await fetchDay('2026-01-01', {
    fetchJson: async (url) => {
      urls.push(url);
      return { hits: [], nbPages: 1 };
    },
  });
  assert.equal(urls.length, 1);
});

test('HN reposts: a vote binds to the submission it was cast on', (t) => {
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

  recordVote(conn, 100, -1);
  assert.deepEqual(
    conn.prepare('SELECT story_id, value FROM votes ORDER BY story_id').all().map((v) => [v.story_id, v.value]),
    [[100, -1]],
    'the same-URL twin is not co-signed'
  );

  // 101 is still unjudged, so it stays in the deck — re-judging a repost is fine.
  const queue = trainingQueue(conn, { limit: 50 });
  assert.ok(!queue.some((s) => s.id === 100), 'the judged submission is gone');
  assert.ok(queue.some((s) => s.id === 101), 'the unjudged twin is still offered');

  deleteVote(conn, 100);
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 0, 'undo clears the vote');
});

test('fetching a repost after the vote writes no vote for it', (t) => {
  rmSync(DB, { force: true });
  resetModelCache();
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); resetModelCache(); });

  seed(conn);
  upsertStory(conn, {
    id: 400, title: 'Stop Making TUIs', url: 'https://sockpuppet.org/blog/tuis/',
    domain: 'sockpuppet.org', author: 'u400', points: 500, num_comments: 500,
    created_at: now - 200, day: dayKey(now - 200), fetched_at: now - 200,
  });
  recordVote(conn, 400, 1);

  // The twin lands on a later sync — the old propagation-at-vote-time never
  // caught this case, which is how unjudged duplicates piled up in prod.
  upsertStory(conn, {
    id: 401, title: 'Stop Making TUIs', url: 'https://sockpuppet.org/blog/tuis/',
    domain: 'sockpuppet.org', author: 'u401', points: 1, num_comments: 1,
    created_at: now - 100, day: dayKey(now - 100), fetched_at: now,
  });

  // The late twin may be offered again — re-judging a repost is accepted. What
  // must not happen is a vote appearing for it that was never cast.
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 1,
    'fetching a twin writes no phantom vote');
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM votes WHERE story_id = 401').get().n, 0);
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

test('a repost judged separately is its own training example', (t) => {
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
  assert.equal(result.metrics.n, 7, 'seven votes, seven examples — repeats are signal, not noise');
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

  // The feed only lists scored stories, so give it a model. Titles are all
  // alike, so every score sits near 0.5 and ordering stays crowd-driven.
  for (const id of [1, 2, 3]) recordVote(conn, id, 1);
  for (const id of [4, 5, 6]) recordVote(conn, id, -1);
  trainAndScore(conn);

  const newest = feed(conn, { mode: 'new', days: 0, includeVoted: true, limit: 3 });
  assert.equal(newest.total, N, 'total is the real count');
  assert.equal(newest.items[0].id, N, 'the newest story leads');

  const top = feed(conn, { mode: 'top', days: 0, limit: 1 });
  assert.equal(top.items[0].id, N);

  const page2 = feed(conn, { mode: 'new', days: 0, limit: 50, offset: 50 });
  assert.equal(page2.items.length, 50);
  assert.equal(page2.items[0].id, N - 50, 'offset pages continue the same order');

  const hybrid = feed(conn, { mode: 'hybrid', days: 0, includeVoted: true, limit: 1 });
  assert.equal(hybrid.total, N);
  assert.equal(hybrid.items[0].id, N, 'with flat scores, blend is driven by the crowd');

  const queue = trainingQueue(conn, { limit: 1, days: 365 });
  assert.equal(queue[0].id, N, 'the queue sees the newest stories');
});

test('hn: a single story is looked up by id, narrowed to the submission itself', async () => {
  const urls = [];
  const fetchJson = async (url) => {
    urls.push(url);
    return {
      hits: [{
        objectID: '49321298', title: 'Being ambitious and being a dad',
        url: 'https://nicholascharriere.com/blog/being-ambitious-and-being-a-dad/',
        author: 'nc', points: 42, num_comments: 7, created_at_i: 1787574000,
      }],
    };
  };

  const story = await fetchStory(49321298, { fetchJson });
  assert.match(urls[0], /tags=story,story_49321298&hitsPerPage=1$/);
  assert.equal(story.id, 49321298);
  assert.equal(story.domain, 'nicholascharriere.com');
  assert.equal(story.day, '2026-08-24');

  // A comment id (or a dead one) matches nothing under the `story` tag.
  assert.equal(await fetchStory(1, { fetchJson: async () => ({ hits: [] }) }), null);
});

test('held-out predictions are stored per vote, apart from the memorised score', (t) => {
  const path = new URL('./data/tmp-oof.db', import.meta.url).pathname;
  rmSync(path, { force: true });
  resetModelCache();
  const conn = openDb(path);
  t.after(() => { conn.close(); rmSync(path, { force: true }); resetModelCache(); });

  seed(conn);
  for (const id of [1, 2, 3, 7]) recordVote(conn, id, 1);
  for (const id of [4, 5, 6, 8]) recordVote(conn, id, -1);

  const trained = trainAndScore(conn);
  assert.equal(trained.trained, true);

  // One row per vote, and every one a real probability.
  const oof = conn.prepare('SELECT story_id, score, model_rev FROM oof_scores ORDER BY story_id').all();
  assert.equal(oof.length, 8);
  assert.ok(oof.every((r) => r.score >= 0 && r.score <= 1 && r.model_rev === trained.rev));

  // The point of the table: a held-out score is a different number from the
  // memorised one. Trained on its own examples the model is near-perfect, so
  // if these matched, the Votes view's flag could never fire.
  const stored = new Map(conn.prepare('SELECT story_id, score FROM scores').all().map((r) => [r.story_id, r.score]));
  assert.ok(oof.some((r) => Math.abs(r.score - stored.get(r.story_id)) > 0.01),
    'held-out scores should differ from the training-set scores');

  // The vote list serves it alongside the memorised score, not instead of it.
  const log = voteLog(conn);
  assert.equal(log.items.length, 8);
  assert.ok(log.items.every((i) => typeof i.oof_score === 'number'));

  // heldOut is one row per vote; it belongs in the table, not in every
  // serialised snapshot or in the stats payload.
  const payload = JSON.parse(conn.prepare('SELECT payload FROM models ORDER BY rev DESC LIMIT 1').get().payload);
  assert.equal(payload.metrics.heldOut, undefined);
  assert.equal(trained.metrics.heldOut, undefined);
  assert.equal(stats(conn).model.metrics.heldOut, undefined);

  // A removed vote must not leave a stale prediction behind.
  deleteVote(conn, 7);
  trainAndScore(conn);
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM oof_scores').get().n, 7);
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM oof_scores WHERE story_id = 7').get().n, 0);
});
