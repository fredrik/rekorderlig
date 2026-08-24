#!/usr/bin/env node
/** Command line companion: `npm run ingest -- --days 14`, `npm run train`, `npm run stats`. */
import { db } from './db.js';
import { ingest } from './hn.js';
import { trainAndScore, scoreMissing, stats } from './service.js';

const [, , command = 'stats', ...rest] = process.argv;
const flags = Object.fromEntries(
  rest.join(' ').split('--').filter(Boolean).map((s) => {
    const [k, ...v] = s.trim().split(/\s+/);
    return [k, v.length ? v.join(' ') : 'true'];
  })
);

const conn = db();
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);

switch (command) {
  case 'ingest': {
    const days = Number(flags.days ?? 7);
    console.log(`fetching the last ${days} day(s) of Hacker News…`);
    const result = await ingest(conn, {
      days,
      pagesPerDay: Number(flags.pages ?? 3),
      onProgress: ({ day, count }) => console.log(`  ${day}: ${count} stories`),
    });
    console.log(`${result.fetched} fetched, ${result.inserted} new`);
    console.log(`${scoreMissing(conn)} stories scored`);
    break;
  }
  case 'train': {
    const result = trainAndScore(conn);
    if (!result.trained) {
      console.log(`not trained: ${result.reason} (need ${result.need.up} more up, ${result.need.down} more down)`);
      break;
    }
    console.log(`model rev ${result.rev} on ${result.counts.up + result.counts.down} votes, ${result.scored} stories scored`);
    if (result.metrics) {
      console.log(`  accuracy ${pct(result.metrics.accuracy)} (baseline ${pct(result.metrics.baseline)}), AUC ${result.metrics.auc?.toFixed(3)}`);
    }
    console.log('  likes:   ', result.insights.likes.slice(0, 8).map((r) => r.label).join(', ') || '—');
    console.log('  dislikes:', result.insights.dislikes.slice(0, 8).map((r) => r.label).join(', ') || '—');
    break;
  }
  case 'stats': {
    const s = stats(conn);
    console.log(`${s.stories} stories across ${s.days} days`);
    console.log(`votes: ${s.votes.up} up, ${s.votes.down} down, ${s.votes.skip} skipped`);
    if (s.model) {
      console.log(`model rev ${s.model.rev}: ${s.model.features} features, accuracy ${pct(s.model.metrics?.accuracy)}`);
    } else {
      console.log('no model yet');
    }
    break;
  }
  default:
    console.error(`unknown command: ${command}\nusage: cli.js [ingest|train|stats] [--days N] [--pages N]`);
    process.exit(1);
}
