//! One binary, two jobs: `rekorderlig serve` runs the HTTP server; the other
//! subcommands are the command-line companion the Node version kept in cli.js
//! (`sync`, `backfill`, `train`, `stats`, `reset-models`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use rekorderlig::db::{db_url, open_db};
use rekorderlig::firebase::BackfillOptions;
use rekorderlig::hn::{Algolia, SyncOptions};
use rekorderlig::http_client::HttpFetcher;
use rekorderlig::model::FitOptions;
use rekorderlig::server::{serve, App};
use rekorderlig::service::{
    backfill, reset_models, stats, sync, train_and_score, ModelCache, SyncRequest, TrainOutcome,
};
use rekorderlig::sync_remote::{trigger, RemoteSync};
use rekorderlig::version;

fn parse_flags(args: &[String]) -> HashMap<String, String> {
    let mut flags = HashMap::new();
    let mut i = 0;
    while i < args.len() {
        if let Some(key) = args[i].strip_prefix("--") {
            let mut values = Vec::new();
            while i + 1 < args.len() && !args[i + 1].starts_with("--") {
                i += 1;
                values.push(args[i].clone());
            }
            flags.insert(
                key.to_string(),
                if values.is_empty() {
                    "true".to_string()
                } else {
                    values.join(" ")
                },
            );
        }
        i += 1;
    }
    flags
}

fn pct(x: Option<f64>) -> String {
    match x {
        Some(x) => format!("{:.1}%", x * 100.0),
        None => "—".to_string(),
    }
}

fn flag_value<'a>(flags: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    flags.get(key).map(String::as_str).filter(|v| *v != "true")
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("stats");
    let flags = parse_flags(args.get(1..).unwrap_or(&[]));

    match command {
        "serve" => run_server(),
        "sync" => run_sync(&flags),
        "sync-remote" => run_sync_remote(&flags),
        "backfill" => run_backfill(&flags),
        "train" => run_train(),
        "reset-models" => run_reset_models(&flags),
        "stats" => run_stats(),
        _ => {
            eprintln!(
                "unknown command: {command}\n\
                 {}\n\
                 usage: rekorderlig [serve|sync|sync-remote|backfill|train|stats|reset-models]\n  \
                 serve                start the HTTP server\n  \
                 sync [--days N | --from YYYY-MM-DD [--to YYYY-MM-DD]] [--pages N] [--points N] [--throttle MS]\n  \
                 sync-remote [--url URL] [--days N]\n                       \
                 ask a running instance to sync and wait for it; the hourly\n                       \
                 trigger (REKORDERLIG_URL, REKORDERLIG_SYNC_DAYS, AUTH_TOKEN)\n  \
                 backfill --from YYYY-MM-DD [--to YYYY-MM-DD] [--dry-run] [--points N] [--concurrency N]\n                       \
                 recover stories Algolia's index missed, from the Firebase item API;\n                       \
                 --dry-run reports the gap without writing\n  \
                 reset-models --yes   forget every trained model revision and retrain from the votes",
                version::describe()
            );
            ExitCode::FAILURE
        }
    }
}

fn public_dir() -> PathBuf {
    match std::env::var("REKORDERLIG_PUBLIC") {
        Ok(p) if !p.is_empty() => PathBuf::from(p),
        _ => std::env::current_dir().expect("cwd").join("public"),
    }
}

fn run_server() -> ExitCode {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(4173);
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let auth_token = std::env::var("AUTH_TOKEN").ok().filter(|t| !t.is_empty());
    let app = App::new(db_url(), public_dir(), auth_token);
    let cache = Arc::clone(&app.cache);
    let handle = serve(Arc::clone(&app), &format!("{host}:{port}"));

    // The build identity goes first in the boot log, so `fly logs` after a
    // deploy answers "which commit is running" without opening the app.
    println!("{} → http://{host}:{}", version::describe(), handle.port);
    {
        let conn = app.lock_db();
        let s = stats(&conn, &cache);
        let rev = s["model"]["rev"]
            .as_i64()
            .map(|r| r.to_string())
            .unwrap_or_else(|| "—".into());
        println!(
            "  {} stories, {} votes, model rev {rev}",
            s["stories"], s["votes"]["total"]
        );
        if s["stories"] == 0 {
            println!(
                "  no stories yet — run `rekorderlig sync` or hit \"Fetch stories\" in the app"
            );
        }
    }
    // The worker threads carry the server; this thread only has to stay alive.
    loop {
        std::thread::park();
    }
}

// One command for both the rolling refresh and an archive fill: --days N
// walks the last N days, --from/--to an explicit range. Every day in the
// list is fetched — nothing is skipped for looking covered already.
fn run_sync(flags: &HashMap<String, String>) -> ExitCode {
    let conn = open_db(&db_url());
    let cache = ModelCache::default();
    let mut options = SyncOptions {
        pages_per_day: flags
            .get("pages")
            .and_then(|v| v.parse().ok())
            .unwrap_or(10),
        ..SyncOptions::default()
    };
    if let Some(points) = flags.get("points").and_then(|v| v.parse().ok()) {
        options.min_points = points;
    }
    if let Some(throttle) = flags.get("throttle").and_then(|v| v.parse().ok()) {
        options.throttle_ms = throttle;
    }
    let req = SyncRequest {
        from: flag_value(flags, "from").map(str::to_string),
        to: flag_value(flags, "to").map(str::to_string),
        days: if flag_value(flags, "from").is_none() {
            Some(flags.get("days").and_then(|v| v.parse().ok()).unwrap_or(2))
        } else {
            None
        },
        front_page: None,
        options: Some(options),
    };
    match &req.from {
        Some(from) => println!(
            "syncing top stories {from} → {}…",
            req.to.as_deref().unwrap_or("today")
        ),
        None => println!(
            "syncing the last {} day(s) of Hacker News…",
            req.days.unwrap_or(2)
        ),
    }

    let fetcher = HttpFetcher::default();
    let source = Algolia { fetch: &fetcher };
    let result = sync(&conn, &cache, &req, &source, &mut |p| {
        println!(
            "  {}: {}",
            p.day,
            if p.failed {
                "FAILED".to_string()
            } else {
                format!("{} stories", p.count)
            }
        );
    });
    let result = match result {
        Ok(r) => r,
        Err(e) => {
            eprintln!("sync failed: {e}");
            return ExitCode::FAILURE;
        }
    };
    println!(
        "{} day(s): {} fetched ({} stories, {} new, {} scored)",
        result.days,
        result.fetched_days,
        result.fetched,
        result.inserted,
        result.scored.unwrap_or(0)
    );
    if !result.failures.is_empty() {
        println!(
            "  {} day(s) failed — rerun the same command to retry just those:",
            result.failures.len()
        );
        for f in &result.failures {
            println!("    {}: {}", f.day, f.error);
        }
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

// The counterpart to `sync` for a machine that has no database: poke a running
// instance over HTTP and wait for its run to finish. This is what the hourly
// Fly scheduled machine executes (scripts/fly-sync-machine.sh), so the defaults
// are that machine's — the app's own URL from REKORDERLIG_URL, its AUTH_TOKEN
// out of the Fly secret every machine in the app already carries, and today.
fn run_sync_remote(flags: &HashMap<String, String>) -> ExitCode {
    let default = RemoteSync::default();
    let opts = RemoteSync {
        url: flag_value(flags, "url")
            .map(str::to_string)
            .or_else(|| {
                std::env::var("REKORDERLIG_URL")
                    .ok()
                    .filter(|u| !u.is_empty())
            })
            .unwrap_or(default.url),
        token: std::env::var("AUTH_TOKEN").ok().filter(|t| !t.is_empty()),
        days: flags
            .get("days")
            .and_then(|v| v.parse().ok())
            .or_else(|| {
                std::env::var("REKORDERLIG_SYNC_DAYS")
                    .ok()
                    .and_then(|v| v.parse().ok())
            })
            .unwrap_or(default.days),
        ..default
    };
    println!("poking {} …", opts.url);
    match trigger(&opts, &mut |note| println!("{note}")) {
        Ok(last) => {
            println!(
                "fetched {} stories ({} new, {} scored) for {}..{}",
                last["fetched"],
                last["inserted"],
                last["scored"],
                last["from"].as_str().unwrap_or("?"),
                last["to"].as_str().unwrap_or("?")
            );
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("sync-remote failed: {e}");
            ExitCode::FAILURE
        }
    }
}

// Repair a gap in Algolia's index from Firebase — see service::backfill().
// Rare and expensive (about one request per Hacker News item, so ~11k per
// day), which is why it is a command and not part of sync. --dry-run makes
// it the audit instead of the repair: it reports how many live stories a day
// actually had against how many the corpus holds, writing nothing.
fn run_backfill(flags: &HashMap<String, String>) -> ExitCode {
    let Some(from) = flag_value(flags, "from") else {
        eprintln!("backfill needs a day range: --from YYYY-MM-DD [--to YYYY-MM-DD]");
        return ExitCode::FAILURE;
    };
    let dry_run = flags.get("dry-run").map(String::as_str) == Some("true");
    let to = flag_value(flags, "to").unwrap_or(from).to_string();
    let mut options = BackfillOptions {
        dry_run,
        ..BackfillOptions::default()
    };
    if let Some(points) = flags.get("points").and_then(|v| v.parse().ok()) {
        options.min_points = points;
    }
    if let Some(concurrency) = flags.get("concurrency").and_then(|v| v.parse().ok()) {
        options.concurrency = concurrency;
    }

    let conn = open_db(&db_url());
    let cache = ModelCache::default();
    let fetcher = HttpFetcher::default();
    println!(
        "{} {from} → {to} from the Firebase item API…",
        if dry_run { "auditing" } else { "backfilling" }
    );
    let result = backfill(
        &conn,
        &cache,
        from,
        Some(&to),
        &options,
        &fetcher,
        &mut |stat| {
            println!(
                "  {}: {} ids scanned, {} live stories — {} {}, {} already held{}",
                stat.day,
                stat.scanned,
                stat.stories,
                stat.recovered,
                if dry_run { "missing" } else { "recovered" },
                stat.updated,
                if stat.failed > 0 {
                    format!(", {} failed", stat.failed)
                } else {
                    String::new()
                }
            );
        },
    );
    let result = match result {
        Ok(r) => r,
        Err(e) => {
            eprintln!("backfill failed: {e}");
            return ExitCode::FAILURE;
        }
    };
    println!(
        "{} day(s): {} ids scanned, {} live stories, {} {}{}",
        result.days,
        result.scanned,
        result.stories,
        result.recovered,
        if dry_run {
            "missing from the corpus"
        } else {
            "recovered"
        },
        if dry_run {
            String::new()
        } else {
            format!(" ({} scored)", result.scored.unwrap_or(0))
        }
    );
    if !result.failures.is_empty() {
        println!(
            "  {} id(s) failed after retries — rerun to pick them up:",
            result.failures.len()
        );
        for f in result.failures.iter().take(10) {
            println!("    {}: {}", f.id, f.error);
        }
        if result.failures.len() > 10 {
            println!("    …and {} more", result.failures.len() - 10);
        }
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

fn print_trained(result: &TrainOutcome) {
    if let TrainOutcome::Trained {
        rev,
        scored,
        metrics,
        counts,
        ..
    } = result
    {
        println!(
            "model rev {rev} on {} votes, {scored} stories scored",
            counts.up + counts.down
        );
        if let Some(m) = metrics {
            println!(
                "  accuracy {} (baseline {}), AUC {}",
                pct(Some(m.accuracy)),
                pct(Some(m.baseline)),
                m.auc
                    .map(|a| format!("{a:.3}"))
                    .unwrap_or_else(|| "—".into())
            );
        }
    }
}

fn run_train() -> ExitCode {
    let conn = open_db(&db_url());
    let cache = ModelCache::default();
    let result = train_and_score(&conn, &cache, FitOptions::default());
    match &result {
        TrainOutcome::NotTrained { reason, need, .. } => {
            println!(
                "not trained: {reason} (need {} more up, {} more down)",
                need.up, need.down
            );
        }
        TrainOutcome::Trained { insights, .. } => {
            print_trained(&result);
            let labels = |rows: &[rekorderlig::model::Insight]| {
                let joined = rows
                    .iter()
                    .take(8)
                    .map(|r| r.label.clone())
                    .collect::<Vec<_>>()
                    .join(", ");
                if joined.is_empty() {
                    "—".to_string()
                } else {
                    joined
                }
            };
            println!("  likes:    {}", labels(&insights.likes));
            println!("  dislikes: {}", labels(&insights.dislikes));
        }
    }
    ExitCode::SUCCESS
}

// Destructive and rare, so it insists on --yes. Run on the live machine with
// `fly ssh console -C "/app/rekorderlig reset-models --yes"` after a change
// that renames features: weights are keyed by feature name, so a history
// spanning a tokenizer change compares vocabularies rather than models.
fn run_reset_models(flags: &HashMap<String, String>) -> ExitCode {
    if flags.get("yes").map(String::as_str) != Some("true") {
        eprintln!(
            "reset-models deletes every trained model revision. Re-run with --yes to confirm."
        );
        eprintln!("Votes are not touched; the model is retrained from them immediately.");
        return ExitCode::FAILURE;
    }
    let conn = open_db(&db_url());
    let cache = ModelCache::default();
    let forgotten = reset_models(&conn, &cache);
    println!(
        "forgot {forgotten} model revision{}",
        if forgotten == 1 { "" } else { "s" }
    );
    let result = train_and_score(&conn, &cache, FitOptions::default());
    match &result {
        TrainOutcome::NotTrained { reason, .. } => {
            println!(
                "not retrained: {reason} — the model is empty until there are votes on both sides"
            );
        }
        TrainOutcome::Trained { .. } => print_trained(&result),
    }
    ExitCode::SUCCESS
}

fn run_stats() -> ExitCode {
    let conn = open_db(&db_url());
    let cache = ModelCache::default();
    let s = stats(&conn, &cache);
    println!("{} stories across {} days", s["stories"], s["days"]);
    println!(
        "votes: {} up, {} down, {} skipped",
        s["votes"]["up"], s["votes"]["down"], s["votes"]["skip"]
    );
    if s["model"].is_object() {
        println!(
            "model rev {}: {} features, accuracy {}",
            s["model"]["rev"],
            s["model"]["features"],
            pct(s["model"]["metrics"]["accuracy"].as_f64())
        );
    } else {
        println!("no model yet");
    }
    ExitCode::SUCCESS
}
