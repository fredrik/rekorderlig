#!/usr/bin/env node
/** Command line companion: `npm run sync -- --days 7`, `npm run sync -- --from 2026-01-01`, `npm run train`, `npm run stats`. */
import { db } from './db.js';
import { trainAndScore, sync, stats, resetHistory } from './service.js';

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
  // One command for both the rolling refresh and an archive fill: --days N
  // walks the last N days, --from/--to an explicit range. Every day in the
  // list is fetched — nothing is skipped for looking covered already.
  case 'sync': {
    const opts = {
      pagesPerDay: Number(flags.pages ?? 10),
      ...(flags.points ? { minPoints: Number(flags.points) } : {}),
      onProgress: ({ day, count, failed }) => console.log(
        `  ${day}: ${failed ? 'FAILED' : `${count} stories`}`
      ),
    };
    if (flags.from && flags.from !== 'true') opts.from = flags.from;
    if (flags.to && flags.to !== 'true') opts.to = flags.to;
    if (!opts.from) opts.days = Number(flags.days ?? 2);
    if (flags.throttle) opts.throttleMs = Number(flags.throttle);
    console.log(opts.from
      ? `syncing top stories ${opts.from} → ${opts.to ?? 'today'}…`
      : `syncing the last ${opts.days} day(s) of Hacker News…`);
    const result = await sync(conn, opts);
    console.log(`${result.days} day(s): ${result.fetchedDays} fetched`
      + ` (${result.fetched} stories, ${result.inserted} new, ${result.scored} scored)`);
    if (result.failures.length) {
      console.log(`  ${result.failures.length} day(s) failed — rerun the same command to retry just those:`);
      for (const f of result.failures) console.log(`    ${f.day}: ${f.error}`);
      process.exit(1);
    }
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
  // Destructive and rare, so it insists on --yes. Run on the live machine with
  // `fly ssh console -C "node src/cli.js reset-history --yes"` after a change
  // that renames features: weights are keyed by feature name, so a history
  // spanning a tokenizer change compares vocabularies rather than models.
  case 'reset-history': {
    if (flags.yes !== 'true') {
      console.error('reset-history deletes every trained model. Re-run with --yes to confirm.');
      console.error('Votes are not touched; the model is retrained from them immediately.');
      process.exit(1);
    }
    const { forgotten } = resetHistory(conn);
    console.log(`forgot ${forgotten} model revision${forgotten === 1 ? '' : 's'}`);
    const result = trainAndScore(conn);
    if (!result.trained) {
      console.log(`not retrained: ${result.reason} — the model is empty until there are votes on both sides`);
      break;
    }
    console.log(`model rev ${result.rev} on ${result.counts.up + result.counts.down} votes, ${result.scored} stories scored`);
    console.log(`  accuracy ${pct(result.metrics?.accuracy)} (baseline ${pct(result.metrics?.baseline)})`);
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
    console.error(`unknown command: ${command}\nusage: cli.js [sync|train|stats|reset-history]`
      + `\n  sync [--days N | --from YYYY-MM-DD [--to YYYY-MM-DD]] [--pages N] [--points N] [--throttle MS]`
      + `\n  reset-history --yes   forget every trained model and retrain from the votes`);
    process.exit(1);
}
