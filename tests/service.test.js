import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { openDb, upsertStory, recordVote, deleteVote, getMeta, setMeta } from '../src/db.js';
import { syncDays, fetchDay, fetchStory, normalize, dayKey, dayBounds, recentDays, daysBetween } from '../src/hn.js';
import {
  trainAndScore, sync, feed, trainingQueue, explain, stats, resetModelCache, scoreMissing, storiesPerDay, scoreDistribution, SCORE_BINS, voteLog,
  judge, modelHistory, dealRound, roundStatus, roundSummary, resetModels, ROUND_SIZE,
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
  const queue = trainingQueue(conn, { limit: 2 });
  assert.equal(queue.length, 2, 'both are offered');
  assert.ok(queue.every((s) => s.reason), 'every card says which stratum drew it');
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
  twin(101, 15);

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

  // The queue is no longer a newest-first window either: it samples strata
  // across the whole archive, so a 40-card deck reaches stories thousands of
  // rows behind the newest as well as the day's most discussed.
  const queue = trainingQueue(conn, { limit: 40 });
  assert.equal(queue.length, 40);
  assert.ok(queue.some((s) => s.id < N - 3000), 'the deck reaches deep into the archive');
  assert.ok(queue.some((s) => s.reason === 'recent'), 'and still shows the day');
  assert.ok(queue.every((s) => s.points >= 10), 'nothing below the points floor');
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

test('the training queue samples strata across a multi-year archive', (t) => {
  rmSync(DB, { force: true });
  resetModelCache();
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); resetModelCache(); });

  // Three years of history, ~8 stories a day, ids climbing with time like HN's.
  // Half the corpus sits under the points floor, so the floor has to bite.
  const DAYS = 1100;
  const PER_DAY = 8;
  const words = ['rust', 'compiler', 'apple', 'iphone', 'kernel', 'startup', 'physics', 'sqlite'];
  let id = 0;
  conn.exec('BEGIN');
  for (let d = DAYS; d > 0; d--) {
    for (let k = 0; k < PER_DAY; k++) {
      id++;
      const created = now - d * 86400 + k * 3600;
      upsertStory(conn, {
        id, title: `${words[id % words.length]} ${words[(id * 7) % words.length]} notes ${id}`,
        url: `https://s.dev/${id}`, domain: `d${id % 40}.dev`, author: `u${id % 50}`,
        points: id % 2 ? 40 : 2, num_comments: id % 37,
        created_at: created, day: dayKey(created), fetched_at: now,
      });
    }
  }
  // A handful of stories from the last three days, so `recent` has something.
  for (let k = 0; k < 20; k++) {
    id++;
    const created = now - 3600 * (k + 1);
    upsertStory(conn, {
      id, title: `rust today ${id}`, url: `https://s.dev/${id}`, domain: 'today.dev', author: 'ada',
      points: 80, num_comments: 200 + k, created_at: created, day: dayKey(created), fetched_at: now,
    });
  }
  conn.exec('COMMIT');

  for (let i = 1; i <= 11; i += 2) recordVote(conn, i, i % 3 ? 1 : -1);
  for (let i = 2; i <= 12; i += 2) recordVote(conn, i, -1);
  trainAndScore(conn);

  const deck = trainingQueue(conn, { limit: 40 });
  assert.equal(deck.length, 40, 'a full deck');
  assert.ok(deck.every((s) => s.points >= 10), 'the points floor holds');
  assert.equal(new Set(deck.map((s) => s.id)).size, 40, 'no story twice');

  // The complaint that started this: a deck that only ever shows the newest
  // days. Stratified sampling has to span years, not a trailing window.
  const spanDays = (Math.max(...deck.map((s) => s.created_at)) - Math.min(...deck.map((s) => s.created_at))) / 86400;
  assert.ok(spanDays > 365, `deck spans ${Math.round(spanDays)} days of history`);
  const perDay = new Map();
  for (const s of deck) perDay.set(s.day, (perDay.get(s.day) ?? 0) + 1);
  assert.ok(perDay.size >= 20, `${perDay.size} distinct days in a 40-card deck`);

  // Every stratum contributes, and `recent` really is recent.
  const mix = {};
  for (const s of deck) mix[s.reason] = (mix[s.reason] ?? 0) + 1;
  for (const reason of ['boundary', 'novel', 'recent', 'explore']) {
    assert.ok(mix[reason] > 0, `${reason} drew nothing (mix ${JSON.stringify(mix)})`);
  }
  assert.ok(
    deck.filter((s) => s.reason === 'recent').every((s) => s.created_at >= now - 4 * 86400),
    'the recent slots stay inside the recent window'
  );

  // Deterministic: the same revision and cursor must redraw the same deck, or
  // a refill would reshuffle the cards behind the one being judged.
  assert.deepEqual(
    trainingQueue(conn, { limit: 40 }).map((s) => s.id),
    deck.map((s) => s.id),
    'same rev, same cursor, same deck'
  );
  const next = trainingQueue(conn, { limit: 40, cursor: 1 });
  const overlap = next.filter((s) => deck.some((d) => d.id === s.id)).length;
  assert.ok(overlap < 20, `cursor 1 moves the deck on (${overlap}/40 repeated)`);
});

test('the queue seeks the score axis instead of scanning it', (t) => {
  rmSync(DB, { force: true });
  resetModelCache();
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); resetModelCache(); });

  // The whole multi-year claim rests on the boundary draw being an index seek.
  // A regression to a full scan of `scores` would still pass every other test
  // here and only show up as a slow app against a real archive.
  const RAW_OFFSET = '((sc.score - 0.5) / (0.3 + 0.7 * sc.confidence))';
  const plan = conn.prepare(`
    EXPLAIN QUERY PLAN
    SELECT s.id FROM scores sc
    JOIN stories s ON s.id = sc.story_id
    LEFT JOIN votes v ON v.story_id = s.id
    WHERE ${RAW_OFFSET} >= ? AND ${RAW_OFFSET} <= ? AND sc.confidence >= ? AND s.points >= ? AND v.value IS NULL
    ORDER BY ${RAW_OFFSET}
    LIMIT 1
  `).all(-0.15, 0.15, 0.4, 10).map((r) => r.detail).join(' | ');

  assert.match(plan, /idx_scores_raw_offset/, `plan was: ${plan}`);
  assert.doesNotMatch(plan, /SCAN scores/, `plan was: ${plan}`);
});

test('a vote is answered with the guess the model had already made', (t) => {
  rmSync(DB, { force: true });
  resetModelCache();
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); resetModelCache(); });

  seed(conn);
  for (const id of [1, 2, 3]) recordVote(conn, id, 1);   // Rust: yes
  for (const id of [4, 5, 6]) recordVote(conn, id, -1);  // Apple: no
  trainAndScore(conn);

  // 7 is the remaining compiler story, which the model should like.
  const predicted = conn.prepare('SELECT score FROM scores WHERE story_id = 7').get().score;
  const { prediction, taught } = judge(conn, 7, 1);
  assert.ok(prediction, 'a scored story comes back with its guess');
  assert.equal(prediction.score, predicted, 'the guess is the one made before the vote existed');
  assert.equal(prediction.agreed, predicted >= 0.5);
  assert.ok(taught, 'and with what the vote gives the model');

  // The retrain memorises this vote — the frozen prediction must not follow.
  trainAndScore(conn);
  const after = conn.prepare('SELECT score FROM scores WHERE story_id = 7').get().score;
  assert.notEqual(after, prediction.score, 'the live score is memorised after training');
  assert.equal(
    conn.prepare('SELECT score FROM vote_predictions WHERE story_id = 7').get().score,
    prediction.score,
    'the captured prediction is left alone'
  );

  // A skip is not a verdict, so there is nothing for a guess to be right about
  // and nothing taught.
  const skipped = judge(conn, 8, 0);
  assert.equal(skipped.prediction, null, 'a skip reveals no verdict');
  assert.equal(skipped.taught, null, 'and teaches the model nothing');

  // Undo clears the frozen prediction with the vote it belonged to.
  deleteVote(conn, 7);
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM vote_predictions WHERE story_id = 7').get().n, 0);
});

test('a skip changes nothing the model trains on', (t) => {
  rmSync(DB, { force: true });
  resetModelCache();
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); resetModelCache(); });

  seed(conn);
  for (const id of [1, 2, 3]) recordVote(conn, id, 1);
  for (const id of [4, 5, 6]) recordVote(conn, id, -1);
  const first = trainAndScore(conn);

  // This is what made "Learned · 64% accurate" appear after a skip: the skip
  // is not a training example, so retraining on it produces the same model
  // and claims something was learned. The client no longer triggers a retrain
  // for a skip; this pins the reason why.
  judge(conn, 7, 0);
  const second = trainAndScore(conn);
  assert.equal(second.counts.up, first.counts.up, 'no new labels');
  assert.equal(second.counts.down, first.counts.down);
  assert.equal(second.metrics.accuracy, first.metrics.accuracy, 'and so the same model');
});

test('the learning curve reports accuracy per retrain', (t) => {
  rmSync(DB, { force: true });
  resetModelCache();
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); resetModelCache(); });

  assert.deepEqual(modelHistory(conn), { points: [], runs: 0, revs: 0 }, 'nothing before the first model');

  seed(conn);
  for (const id of [1, 2, 3]) recordVote(conn, id, 1);
  for (const id of [4, 5, 6]) recordVote(conn, id, -1);
  trainAndScore(conn);
  recordVote(conn, 7, 1);
  trainAndScore(conn);

  const { points, runs, revs } = modelHistory(conn);
  assert.equal(revs, 2);
  assert.equal(runs, 2, 'both runs added votes');
  assert.equal(points.length, 2);
  assert.ok(points[0].accuracy > 0 && points[0].accuracy <= 1, 'metrics come out of the payload');
  assert.ok(points[0].baseline > 0, 'with the baseline to judge them against');
  assert.ok(points[1].votes > points[0].votes, 'and the vote count that produced them');
  assert.ok(points[1].features > 0, 'plus vocabulary size');
  assert.ok(points[1].noise > 0, 'and the band the accuracy wobbles inside');

  // A retrain that added no votes is the same model again. Before rounds
  // existed these were most of the table, and plotting them drew a wall of
  // repeats rather than a learning curve.
  trainAndScore(conn);
  const flat = modelHistory(conn);
  assert.equal(flat.revs, 3, 'the revision is still recorded');
  assert.equal(flat.runs, 2, 'but it is not a training run');
  assert.equal(flat.points.at(-1).rev, 3, 'and the newest model at that vote count wins');
});

test('a small deck keeps the strata shares it was asked for', (t) => {
  rmSync(DB, { force: true });
  resetModelCache();
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); resetModelCache(); });

  const now2 = Math.floor(Date.now() / 1000);
  const words = ['rust', 'compiler', 'apple', 'iphone', 'kernel', 'startup', 'physics', 'sqlite'];
  conn.exec('BEGIN');
  for (let id = 1; id <= 4000; id++) {
    const created = now2 - Math.floor(id / 6) * 86400;
    upsertStory(conn, {
      id, title: `${words[id % 8]} ${words[(id * 5) % 8]} piece ${id}`,
      url: `https://s.dev/${id}`, domain: `d${id % 30}.dev`, author: `u${id % 40}`,
      points: 20 + (id % 50), num_comments: id % 90,
      created_at: created, day: dayKey(created), fetched_at: now2,
    });
  }
  conn.exec('COMMIT');
  for (let i = 1; i <= 11; i += 2) recordVote(conn, i, 1);
  for (let i = 2; i <= 12; i += 2) recordVote(conn, i, -1);
  trainAndScore(conn);

  // Rounding each share on its own asked for 9 cards when 8 were wanted, and
  // the ninth was truncated off the end — turning 40/20/20/20 into an even
  // split. Small decks are the whole point now, so the split has to survive them.
  for (const limit of [8, 9, 12, 16]) {
    const deck = trainingQueue(conn, { limit });
    assert.equal(deck.length, limit, `deck of ${limit} is full`);
    assert.equal(new Set(deck.map((s) => s.id)).size, limit, 'without repeats');
    const boundary = deck.filter((s) => s.reason === 'boundary').length;
    assert.ok(boundary >= Math.floor(limit * 0.33), `${limit}: boundary got ${boundary}, the largest share`);
    for (const reason of ['novel', 'recent', 'explore']) {
      assert.ok(deck.some((s) => s.reason === reason), `${limit}: ${reason} still contributes`);
    }
  }
});

test('a vote reports the signals it gives the model', (t) => {
  rmSync(DB, { force: true });
  resetModelCache();
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); resetModelCache(); });

  seed(conn);
  for (const id of [1, 2, 3]) recordVote(conn, id, 1);
  for (const id of [4, 5, 6]) recordVote(conn, id, -1);
  trainAndScore(conn);

  // A title full of words the model has never read.
  upsertStory(conn, {
    id: 200, title: 'Kalman filters for underwater sonar drift',
    url: 'https://oceanography.example/k', domain: 'oceanography.example', author: 'nemo',
    points: 40, num_comments: 40, created_at: now - 60, day: dayKey(now - 60), fetched_at: now,
  });
  scoreMissing(conn);

  const { taught } = judge(conn, 200, 1);
  assert.ok(taught.count > 0, 'unseen words are counted');
  assert.ok(taught.labels.length > 0 && taught.labels.length <= 3, 'a few are named');
  assert.ok(taught.labels.some((l) => l.includes('kalman')), `expected kalman in ${taught.labels}`);
  // Style features match every title and were never news.
  assert.ok(!taught.labels.some((l) => l === 'a question' || l === 'has a number'), 'no style features');

  // Once the model has read those words, the same shape of title teaches less.
  trainAndScore(conn);
  upsertStory(conn, {
    id: 201, title: 'Kalman filters for sonar drift', url: 'https://oceanography.example/k2',
    domain: 'oceanography.example', author: 'nemo', points: 40, num_comments: 40,
    created_at: now - 50, day: dayKey(now - 50), fetched_at: now,
  });
  scoreMissing(conn);
  const second = judge(conn, 201, 1);
  assert.ok(second.taught.count < taught.count, 'the second time round it is mostly known');
});

test('a round is dealt, tracked against the votes, and replaced', (t) => {
  rmSync(DB, { force: true });
  resetModelCache();
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); resetModelCache(); });

  const now2 = Math.floor(Date.now() / 1000);
  const words = ['rust', 'compiler', 'apple', 'kernel', 'startup', 'physics', 'sqlite', 'ocean'];
  conn.exec('BEGIN');
  for (let id = 1; id <= 600; id++) {
    const created = now2 - id * 3600;
    upsertStory(conn, {
      id, title: `${words[id % 8]} ${words[(id * 3) % 8]} piece ${id}`,
      url: `https://s.dev/${id}`, domain: `d${id % 20}.dev`, author: `u${id % 25}`,
      points: 20 + (id % 40), num_comments: id % 60,
      created_at: created, day: dayKey(created), fetched_at: now2,
    });
  }
  conn.exec('COMMIT');
  for (let i = 1; i <= 9; i += 2) recordVote(conn, i, 1);
  for (let i = 2; i <= 10; i += 2) recordVote(conn, i, -1);
  trainAndScore(conn);

  assert.equal(roundStatus(conn), null, 'nothing in flight before the first deal');

  const dealt = dealRound(conn);
  assert.equal(dealt.cards.length, ROUND_SIZE, 'a dozen cards');
  assert.equal(dealt.seq, 1);
  assert.ok(dealt.cards.every((c) => c.reason), 'each card knows which stratum drew it');

  // Progress is a join against votes, not a counter, so it survives a reload
  // and picks up votes cast anywhere else.
  const ids = dealt.cards.map((c) => c.id);
  recordVote(conn, ids[0], 1);
  recordVote(conn, ids[1], 0);
  recordVote(conn, ids[2], -1);
  const mid = roundStatus(conn);
  assert.equal(mid.judged, 2, 'skips are not judgements');
  assert.equal(mid.skipped, 1);
  assert.equal(mid.cards.length, ROUND_SIZE - 3, 'and the judged cards are gone from the deck');
  assert.equal(mid.seq, 1, 'still the same round');
  assert.ok(!mid.cards.some((c) => ids.slice(0, 3).includes(c.id)));

  // A skip consumes its slot: the round is twelve cards, not twelve verdicts.
  for (const id of ids.slice(3)) recordVote(conn, id, 0);
  const done = roundStatus(conn);
  assert.equal(done.cards.length, 0, 'the round is spent');
  assert.equal(done.judged + done.skipped, ROUND_SIZE);

  // Dealing again replaces it, and never re-offers a card already judged.
  const second = dealRound(conn);
  assert.equal(second.seq, 2);
  assert.ok(second.cards.every((c) => !ids.includes(c.id)), 'judged cards do not come back');
  assert.equal(roundStatus(conn).seq, 2, 'the new round is the one in flight');
});

test('a stale round is not resumed', (t) => {
  rmSync(DB, { force: true });
  resetModelCache();
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); resetModelCache(); });

  seed(conn);
  for (const id of [1, 2, 3]) recordVote(conn, id, 1);
  for (const id of [4, 5, 6]) recordVote(conn, id, -1);
  trainAndScore(conn);
  dealRound(conn);
  assert.ok(roundStatus(conn), 'fresh round resumes');

  // Yesterday's half-finished round should not be waiting when you open the
  // app today. The votes it collected are already recorded and are not lost.
  const stale = JSON.parse(getMeta(conn, 'current_round'));
  stale.dealtAt -= 86400 * 2;
  setMeta(conn, 'current_round', JSON.stringify(stale));
  assert.equal(roundStatus(conn), null, 'a two-day-old deal is discarded');
});

test('a finished round reports what it changed', (t) => {
  rmSync(DB, { force: true });
  resetModelCache();
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); resetModelCache(); });

  const now2 = Math.floor(Date.now() / 1000);
  const topics = ['rust', 'sqlite', 'apple', 'crypto', 'kernel', 'funding'];
  conn.exec('BEGIN');
  for (let id = 1; id <= 400; id++) {
    const created = now2 - id * 3600;
    upsertStory(conn, {
      id, title: `${topics[id % 6]} ${topics[(id * 5) % 6]} report ${id}`,
      url: `https://s.dev/${id}`, domain: `d${id % 12}.dev`, author: `u${id % 20}`,
      points: 25 + (id % 30), num_comments: id % 50,
      created_at: created, day: dayKey(created), fetched_at: now2,
    });
  }
  conn.exec('COMMIT');
  for (let i = 1; i <= 20; i++) recordVote(conn, i, /rust|sqlite|kernel/.test(topics[i % 6]) ? 1 : -1);
  trainAndScore(conn);

  const dealt = dealRound(conn);
  // Judge with the frozen predictions in play, the way the app does.
  for (const card of dealt.cards) judge(conn, card.id, /rust|sqlite|kernel/.test(card.title) ? 1 : -1);
  trainAndScore(conn);

  const s = roundSummary(conn);
  assert.equal(s.seq, dealt.seq);
  assert.equal(s.judged, ROUND_SIZE);
  assert.equal(s.skipped, 0);
  assert.equal(s.trained, true);
  assert.ok(s.guessed.of > 0 && s.guessed.right <= s.guessed.of, 'a hit rate over the round');
  assert.ok(s.signals.gained > 0, 'signals gained');
  assert.ok(s.accuracy.band > 0, 'accuracy carries the band it must clear');
  assert.equal(typeof s.accuracy.significant, 'boolean');
  // The band is a two-measurement one — it gates the gap between two
  // revisions' accuracies — so a move no bigger than either revision's own
  // wobble can never clear it.
  const noises = conn.prepare(
    `SELECT json_extract(payload, '$.metrics.noise') AS noise FROM models ORDER BY rev DESC LIMIT 2`,
  ).all().map((r) => r.noise);
  const single = Math.max(...noises);
  assert.ok(single > 0, 'both revisions record their own band');
  assert.ok(s.accuracy.band > single, `band ${s.accuracy.band} must exceed the single ${single}`);

  // Delta and weight have to agree: a signal that moved towards no but is
  // still positive is not something the model dislikes.
  for (const l of s.learned.likes) { assert.ok(l.delta > 0 && l.weight > 0, `like ${l.label}`); }
  for (const d of s.learned.dislikes) { assert.ok(d.delta < 0 && d.weight < 0, `dislike ${d.label}`); }
  // Named signals must have evidence behind them, not a single sighting.
  for (const m of [...s.learned.likes, ...s.learned.dislikes]) assert.ok(m.support >= 2, `${m.label} support`);

  // Asking twice must not cost a second retrain of the same votes: the round
  // is marked spent, which is what a reload on a finished round relies on.
  assert.equal(roundStatus(conn).finished, true);
  const again = roundSummary(conn);
  assert.equal(again.signals.gained, s.signals.gained);
});

test('an accuracy move is tested paired, against the predictions that changed sides', (t) => {
  rmSync(DB, { force: true });
  resetModelCache();
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); resetModelCache(); });

  const start = Math.floor(Date.now() / 1000);
  const topics = ['rust', 'sqlite', 'apple', 'crypto', 'kernel', 'funding'];
  const liked = (title) => /rust|sqlite|kernel/.test(title);
  conn.exec('BEGIN');
  for (let id = 1; id <= 400; id++) {
    const created = start - id * 3600;
    upsertStory(conn, {
      id, title: `${topics[id % 6]} ${topics[(id * 5) % 6]} report ${id}`,
      url: `https://s.dev/${id}`, domain: `d${id % 12}.dev`, author: `u${id % 20}`,
      points: 25 + (id % 30), num_comments: id % 50,
      created_at: created, day: dayKey(created), fetched_at: start,
    });
  }
  conn.exec('COMMIT');
  for (let id = 1; id <= 60; id++) recordVote(conn, id, liked(topics[id % 6]) ? 1 : -1);
  trainAndScore(conn);

  const playRound = () => {
    const dealt = dealRound(conn);
    for (const card of dealt.cards) judge(conn, card.id, liked(card.title) ? 1 : -1);
    trainAndScore(conn);
    return roundSummary(conn);
  };

  playRound();
  const s = playRound();
  const f = s.accuracy.flips;

  assert.ok(f, 'the round has both revisions held out, so the move is paired');
  assert.equal(f.moved, f.gained + f.lost, 'moved is the discordant votes and nothing else');
  assert.equal(f.net, f.gained - f.lost);
  // The shared set is the earlier revision's votes: the later one has this
  // round on top of them, and a vote only the second scored is not a pair.
  assert.equal(f.shared, 60 + ROUND_SIZE);
  assert.equal(
    s.accuracy.significant,
    f.moved > 0 && Math.abs(f.net) > 1.96 * Math.sqrt(f.moved),
    'significance comes off the flips, not the two accuracies',
  );

  // One revision back, never a history: the previous train's rows and no more.
  const revs = conn.prepare('SELECT rev FROM models ORDER BY rev DESC LIMIT 2').all().map((r) => r.rev);
  const prevRev = conn.prepare('SELECT DISTINCT model_rev AS rev FROM oof_previous').all().map((r) => r.rev);
  assert.deepEqual(prevRev, [revs[1]], 'oof_previous holds exactly the train before last');

  // Now the gate itself, on a flip pattern built by hand rather than whatever
  // deck the queue happened to draw. Every shared vote's previous call is set
  // to agree with the current one, except `gained` of them, which are moved to
  // the wrong side: so that many flipped towards right, none the other way,
  // and McNemar's threshold (|net| > 1.96·√moved) falls between three flips
  // (3 < 3.4) and four (4 > 3.9).
  const stage = (gained) => {
    const shared = conn.prepare(`
      SELECT v.story_id AS id, v.value, cur.score
      FROM votes v
      JOIN oof_previous prev ON prev.story_id = v.story_id
      JOIN oof_scores   cur  ON cur.story_id  = v.story_id
      WHERE v.value != 0 ORDER BY v.story_id`).all();
    const set = conn.prepare('UPDATE oof_previous SET score = ? WHERE story_id = ?');
    let left = gained;
    for (const r of shared) {
      const isRight = (r.score >= 0.5) === (r.value > 0);
      const wasRight = isRight && left > 0 ? (left--, false) : isRight;
      const saidUp = wasRight === (r.value > 0);
      set.run(saidUp ? 0.9 : 0.1, r.id);
    }
    assert.equal(left, 0, 'the fixture must have that many votes called right');
  };
  // Re-reading a finished round is free and does not retrain; the flag it sets
  // is only there to stop a second retrain, so clearing it re-reads the same
  // two revisions.
  const reread = () => {
    setMeta(conn, 'current_round',
      JSON.stringify({ ...JSON.parse(getMeta(conn, 'current_round')), finishedAt: null }));
    return roundSummary(conn).accuracy;
  };

  stage(3);
  const three = reread();
  assert.deepEqual([three.flips.gained, three.flips.lost], [3, 0]);
  assert.equal(three.significant, false, 'three flips one way is not a move');

  stage(4);
  const four = reread();
  assert.deepEqual([four.flips.gained, four.flips.lost], [4, 0]);
  assert.equal(four.significant, true, 'four of them is');
  assert.equal(four.before, three.before, 'and the two accuracies never moved');

  // With nothing to pair against — the first round after this shipped, or a
  // revision gap — the unpaired band takes over.
  conn.exec('DELETE FROM oof_previous');
  const unpaired = reread();
  assert.equal(unpaired.flips, null, 'nothing to pair against');
  assert.equal(
    unpaired.significant,
    Math.abs(unpaired.after - unpaired.before) > unpaired.band,
    'so the band decides again',
  );
});

test('cross-validation reports how much its own number wobbles', (t) => {
  rmSync(DB, { force: true });
  resetModelCache();
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); resetModelCache(); });

  seed(conn);
  for (const id of [1, 2, 3, 7]) recordVote(conn, id, 1);
  for (const id of [4, 5, 6, 8]) recordVote(conn, id, -1);
  const trained = trainAndScore(conn);

  assert.ok(Array.isArray(trained.metrics.foldAccuracy), 'each fold keeps its own accuracy');
  assert.equal(trained.metrics.foldAccuracy.length, trained.metrics.folds);
  assert.ok(trained.metrics.noise > 0, 'and the spread becomes the noise band');
  // Eight votes separated perfectly is not certainty. The textbook binomial
  // error is exactly zero there, which would make every later move look
  // significant, so the band is Agresti-Coull and stays wide on small n.
  assert.equal(trained.metrics.accuracy, 1, 'this toy set separates cleanly');
  assert.ok(trained.metrics.noise > 0.05, `band was ±${trained.metrics.noise}`);
});

test('reset-models forgets the models and nothing else', (t) => {
  rmSync(DB, { force: true });
  resetModelCache();
  const conn = openDb(DB);
  t.after(() => { conn.close(); rmSync(DB, { force: true }); resetModelCache(); });

  seed(conn);
  for (const id of [1, 2, 3]) recordVote(conn, id, 1);
  for (const id of [4, 5, 6]) recordVote(conn, id, -1);
  trainAndScore(conn);
  judge(conn, 7, 1);          // leaves a frozen prediction behind
  trainAndScore(conn);
  dealRound(conn);

  const revsBefore = conn.prepare('SELECT COUNT(*) AS n FROM models').get().n;
  assert.ok(revsBefore >= 2);
  assert.ok(roundStatus(conn), 'a round is in flight');

  const { forgotten } = resetModels(conn);
  assert.equal(forgotten, revsBefore);
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM models').get().n, 0, 'every revision is gone');
  assert.equal(roundStatus(conn), null, 'and the round dealt by a vanished model with it');
  assert.equal(getMeta(conn, 'round_seq', null), null, 'round numbering restarts');

  // The record survives: votes are the source of truth, and the frozen guesses
  // are a statement about what the model believed at the time.
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 7);
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM vote_predictions').get().n, 1);

  // Numbering restarts at 1 — AUTOINCREMENT would otherwise carry on from the
  // old high-water mark, which is the whole point of clearing sqlite_sequence.
  const retrained = trainAndScore(conn);
  assert.equal(retrained.trained, true);
  assert.equal(retrained.rev, 1, 'the first model after a reset is rev 1');
  assert.equal(dealRound(conn).seq, 1, 'and the first round is round 1');
});
