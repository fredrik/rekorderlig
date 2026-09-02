//! One binary, two jobs: `rekorderlig serve` runs the HTTP server; the other
//! subcommands are the command-line companion the Node version kept in cli.js
//! (`sync`, `backfill`, `train`, `stats`, `reset-models`), plus the
//! administration: `invite` (create, list, revoke) and `user` (link, list,
//! rename, email, revoke, remove). On the live
//! machine these run as `fly ssh console -C "/app/rekorderlig user list"`,
//! which has `DATABASE_URL` and needs nothing else.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use rekorderlig::dates::{day_key, now_seconds};
use rekorderlig::db::{
    create_invite, create_login_link, db_url, delete_user, find_user, list_invites, list_sessions,
    list_users, open_db, revoke_access, revoke_invite, set_display_name, set_email, Db,
    InviteRecord, User, UserError, UserRecord, LINK_TTL_SECS,
};
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

/// The bare words before the first `--flag`: `user rename 3 Alice` has two.
fn positionals(args: &[String]) -> Vec<&str> {
    args.iter()
        .take_while(|a| !a.starts_with("--"))
        .map(String::as_str)
        .collect()
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
        "train" => run_train(&flags),
        "reset-models" => run_reset_models(&flags),
        "stats" => run_stats(&flags),
        "user" => run_user(args.get(1..).unwrap_or(&[]), &flags),
        "invite" => run_invite(args.get(1..).unwrap_or(&[]), &flags),
        _ => {
            eprintln!(
                "unknown command: {command}\n\
                 {}\n\
                 usage: rekorderlig [serve|sync|sync-remote|backfill|train|stats|reset-models|invite|user]\n  \
                 serve                start the HTTP server\n  \
                 sync [--days N | --from YYYY-MM-DD [--to YYYY-MM-DD]] [--pages N] [--points N] [--throttle MS]\n  \
                 sync-remote [--url URL] [--days N]\n                       \
                 ask a running instance to sync and wait for it; the hourly\n                       \
                 trigger (REKORDERLIG_URL, REKORDERLIG_SYNC_DAYS, AUTH_TOKEN)\n  \
                 backfill --from YYYY-MM-DD [--to YYYY-MM-DD] [--dry-run] [--points N] [--concurrency N]\n                       \
                 recover stories Algolia's index missed, from the Firebase item API;\n                       \
                 --dry-run reports the gap without writing\n  \
                 train [--user ID|EMAIL | --all]\n  \
                 stats [--user ID|EMAIL | --all]\n  \
                 reset-models --yes [--user ID|EMAIL]\n                       \
                 forget one user's trained model revisions and retrain from their votes\n  \
                 invite create [--note N] [--url BASE]\n                       \
                 mint an invite and print its link (once); whoever opens it\n                       \
                 becomes a user\n  \
                 invite list           who has been invited, and who took it up\n  \
                 invite revoke ID      void an unspent invite\n  \
                 user link ID|EMAIL [--uses N] [--url BASE]\n                       \
                 a fresh link for an existing user — a new phone, a lost cookie\n  \
                 user list | user rename ID|EMAIL NAME | user email ID|EMAIL ADDRESS|-\n  \
                 user revoke ID|EMAIL  sign out every device and void unspent links\n  \
                 user remove ID|EMAIL --yes\n                       \
                 delete the user and every vote, model and session they own",
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
        let s = stats(&conn, &cache, User::OWNER);
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

/// Which user a CLI command acts on: `--user ID|EMAIL`, or the owner. `None`
/// when the handle names nobody, after saying so.
fn user_flag(conn: &Db, flags: &HashMap<String, String>) -> Option<User> {
    match flag_value(flags, "user") {
        None => Some(User::OWNER),
        Some(handle) => match find_user(conn, handle) {
            Some(u) => Some(u.id),
            None => {
                eprintln!("no user {handle:?} — `rekorderlig user list` shows who exists");
                None
            }
        },
    }
}

/// `--all` covers every user; otherwise `--user` or the owner.
fn users_flag(conn: &Db, flags: &HashMap<String, String>) -> Option<Vec<User>> {
    if flags.get("all").map(String::as_str) == Some("true") {
        return Some(list_users(conn).into_iter().map(|u| u.id).collect());
    }
    user_flag(conn, flags).map(|u| vec![u])
}

fn run_train(flags: &HashMap<String, String>) -> ExitCode {
    let conn = open_db(&db_url());
    let Some(users) = users_flag(&conn, flags) else {
        return ExitCode::FAILURE;
    };
    let cache = ModelCache::default();
    for user in users {
        if flags.contains_key("all") {
            println!("user {}:", user.0);
        }
        train_one(&conn, &cache, user);
    }
    ExitCode::SUCCESS
}

fn train_one(conn: &Db, cache: &ModelCache, user: User) {
    let result = train_and_score(conn, cache, user, FitOptions::default());
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
}

// Destructive and rare, so it insists on --yes. Run on the live machine with
// `fly ssh console -C "/app/rekorderlig reset-models --yes"` after a change
// that renames features: weights are keyed by feature name, so a history
// spanning a tokenizer change compares vocabularies rather than models.
//
// Per user, and deliberately without `--all`: a vocabulary change affects
// everyone, but forgetting every user's model with one --yes is a bigger
// accident than typing it once per user.
fn run_reset_models(flags: &HashMap<String, String>) -> ExitCode {
    if flags.get("yes").map(String::as_str) != Some("true") {
        eprintln!(
            "reset-models deletes every trained model revision of one user. Re-run with --yes to confirm."
        );
        eprintln!("Votes are not touched; the model is retrained from them immediately.");
        return ExitCode::FAILURE;
    }
    let conn = open_db(&db_url());
    let Some(user) = user_flag(&conn, flags) else {
        return ExitCode::FAILURE;
    };
    let cache = ModelCache::default();
    let forgotten = reset_models(&conn, &cache, user);
    println!(
        "forgot {forgotten} model revision{}",
        if forgotten == 1 { "" } else { "s" }
    );
    let result = train_and_score(&conn, &cache, user, FitOptions::default());
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

fn run_stats(flags: &HashMap<String, String>) -> ExitCode {
    let conn = open_db(&db_url());
    let Some(users) = users_flag(&conn, flags) else {
        return ExitCode::FAILURE;
    };
    let cache = ModelCache::default();
    for user in users {
        let s = stats(&conn, &cache, user);
        println!(
            "user {} ({}): {} stories across {} days",
            user.0,
            s["user"]["displayName"].as_str().unwrap_or("no name yet"),
            s["stories"],
            s["days"]
        );
        println!(
            "  votes: {} up, {} down, {} skipped",
            s["votes"]["up"], s["votes"]["down"], s["votes"]["skip"]
        );
        if s["model"].is_object() {
            println!(
                "  model rev {}: {} features, accuracy {}",
                s["model"]["rev"],
                s["model"]["features"],
                pct(s["model"]["metrics"]["accuracy"].as_f64())
            );
        } else {
            println!("  no model yet");
        }
    }
    ExitCode::SUCCESS
}

/* -------------------------------------------------------------------- user */

/// Where a printed link points. `--url`, else `REKORDERLIG_URL` (the hourly
/// machine's variable, so a Fly console has it), else the bare path — the
/// server does not know its own hostname, and guessing one prints a link
/// that goes nowhere.
fn link_base(flags: &HashMap<String, String>) -> Option<String> {
    flag_value(flags, "url")
        .map(str::to_string)
        .or_else(|| std::env::var("REKORDERLIG_URL").ok())
        .filter(|u| !u.is_empty())
        .map(|u| u.trim_end_matches('/').to_string())
}

fn describe_user(u: &UserRecord) -> String {
    format!(
        "user {} — {}{}",
        u.id.0,
        u.display_name.as_deref().unwrap_or("(no name yet)"),
        u.email
            .as_deref()
            .map(|e| format!(" <{e}>"))
            .unwrap_or_default()
    )
}

/// Mint and print a link. Printed once: the plaintext is not stored anywhere.
fn print_link(conn: &Db, user: User, flags: &HashMap<String, String>) {
    let uses = flags
        .get("uses")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(1);
    let link = create_login_link(conn, user, uses);
    let path = link.path();
    match link_base(flags) {
        Some(base) => println!("{base}{path}"),
        None => {
            println!("{path}");
            println!("  (set REKORDERLIG_URL or pass --url to print the full link)");
        }
    }
    println!(
        "  valid {} days, {} use{}; open it once on each device — it is shown only now",
        LINK_TTL_SECS / 86_400,
        link.max_uses,
        if link.max_uses == 1 { "" } else { "s" }
    );
}

/// `user <handle>` → the row, or a message and None.
fn user_arg(conn: &Db, handle: Option<&str>, what: &str) -> Option<UserRecord> {
    let Some(handle) = handle else {
        eprintln!("user {what} needs an id or an email — `rekorderlig user list` shows them");
        return None;
    };
    let found = find_user(conn, handle);
    if found.is_none() {
        eprintln!("no user {handle:?} — `rekorderlig user list` shows who exists");
    }
    found
}

/// Mint and print an invite. Printed once: the plaintext is not stored.
fn print_invite(conn: &Db, flags: &HashMap<String, String>) {
    let invite = create_invite(conn, flag_value(flags, "note"));
    let path = invite.path();
    match link_base(flags) {
        Some(base) => println!("{base}{path}"),
        None => {
            println!("{path}");
            println!("  (set REKORDERLIG_URL or pass --url to print the full link)");
        }
    }
    println!(
        "  invite {}, valid {} days, one person — it is shown only now",
        invite.id,
        LINK_TTL_SECS / 86_400,
    );
}

/// One line per invite: what it was for, and what became of it. Dates rather
/// than clock times — the question a ledger answers is "has it been a while",
/// not "at what minute".
fn describe_invite(i: &InviteRecord, now: i64) -> String {
    let what = match (&i.user, i.revoked_at, i.redeemed_at) {
        // Redeemed wins over revoked: the row cannot be voided once taken up,
        // so a stamp on both means the user was removed afterwards.
        (Some(u), _, Some(at)) => format!(
            "taken up {} by {}",
            day_key(at),
            u.display_name.as_deref().unwrap_or("(no name yet)"),
        ),
        (None, _, Some(at)) => format!("taken up {} — user since removed", day_key(at)),
        (_, Some(at), _) => format!("voided {}", day_key(at)),
        _ if i.expires_at <= now => format!("expired {}", day_key(i.expires_at)),
        _ => format!("unopened, expires {}", day_key(i.expires_at)),
    };
    let user = i
        .user
        .as_ref()
        .map(|u| format!(" (user {})", u.id.0))
        .unwrap_or_default();
    format!(
        "#{}  {}  sent {} · {what}{user}",
        i.id,
        i.note.as_deref().unwrap_or("—"),
        day_key(i.created_at),
    )
}

fn run_invite(args: &[String], flags: &HashMap<String, String>) -> ExitCode {
    let words = positionals(args);
    let conn = open_db(&db_url());
    match words.first().copied() {
        Some("create") => {
            print_invite(&conn, flags);
            ExitCode::SUCCESS
        }
        Some("list") => {
            let now = now_seconds();
            let invites = list_invites(&conn);
            if invites.is_empty() {
                println!("no invites yet — `rekorderlig invite create` mints one");
            }
            for i in &invites {
                println!("{}", describe_invite(i, now));
            }
            ExitCode::SUCCESS
        }
        Some("revoke") => {
            let Some(id) = words.get(1).and_then(|w| w.parse::<i64>().ok()) else {
                eprintln!("invite revoke needs an id — `rekorderlig invite list` shows them");
                return ExitCode::FAILURE;
            };
            if revoke_invite(&conn, id) {
                println!("invite {id} voided");
                ExitCode::SUCCESS
            } else {
                // Nothing to void is not always nothing to say: a taken-up
                // invite is history, and the door it opened is a session.
                eprintln!(
                    "no unspent invite {id} — if it has been taken up, \
                     `rekorderlig user revoke ID` ends that user's sessions"
                );
                ExitCode::FAILURE
            }
        }
        _ => {
            eprintln!(
                "usage: rekorderlig invite create [--note N] [--url BASE] | invite list | \
                 invite revoke ID"
            );
            ExitCode::FAILURE
        }
    }
}

fn run_user(args: &[String], flags: &HashMap<String, String>) -> ExitCode {
    let words = positionals(args);
    let conn = open_db(&db_url());
    match words.first().copied() {
        // `user invite` was how a user came into being before invites were
        // rows of their own; it made the user and hoped the link reached
        // them. Kept as a signpost rather than an "unknown command".
        Some("invite") => {
            eprintln!(
                "invites are their own thing now: `rekorderlig invite create [--note N]`\n\
                 mints a link, and whoever opens it becomes the user — no row is made\n\
                 until someone actually takes it up. `rekorderlig invite list` says who has."
            );
            ExitCode::FAILURE
        }
        Some("link") => {
            let Some(user) = user_arg(&conn, words.get(1).copied(), "link") else {
                return ExitCode::FAILURE;
            };
            println!("{}", describe_user(&user));
            print_link(&conn, user.id, flags);
            ExitCode::SUCCESS
        }
        Some("list") => {
            for u in list_users(&conn) {
                let sessions = list_sessions(&conn, u.id);
                println!(
                    "{} · {} device{} signed in",
                    describe_user(&u),
                    sessions.len(),
                    if sessions.len() == 1 { "" } else { "s" }
                );
            }
            ExitCode::SUCCESS
        }
        Some("rename") => {
            let Some(user) = user_arg(&conn, words.get(1).copied(), "rename") else {
                return ExitCode::FAILURE;
            };
            let Some(name) = words.get(2) else {
                eprintln!("user rename needs the new name");
                return ExitCode::FAILURE;
            };
            set_display_name(&conn, user.id, name);
            println!("user {} is now {name:?}", user.id.0);
            ExitCode::SUCCESS
        }
        Some("email") => {
            let Some(user) = user_arg(&conn, words.get(1).copied(), "email") else {
                return ExitCode::FAILURE;
            };
            let Some(address) = words.get(2).copied() else {
                eprintln!("user email needs an address, or - to clear it");
                return ExitCode::FAILURE;
            };
            let address = (address != "-").then_some(address);
            match set_email(&conn, user.id, address) {
                Ok(()) => {
                    println!(
                        "user {} email {}",
                        user.id.0,
                        address
                            .map(|a| format!("set to {a}"))
                            .unwrap_or_else(|| "cleared".into())
                    );
                    ExitCode::SUCCESS
                }
                Err(UserError::EmailTaken) => {
                    eprintln!("another user has that email");
                    ExitCode::FAILURE
                }
            }
        }
        Some("revoke") => {
            let Some(user) = user_arg(&conn, words.get(1).copied(), "revoke") else {
                return ExitCode::FAILURE;
            };
            let ended = revoke_access(&conn, user.id);
            println!(
                "user {}: {ended} session{} ended, unspent links voided",
                user.id.0,
                if ended == 1 { "" } else { "s" }
            );
            ExitCode::SUCCESS
        }
        Some("remove") => {
            let Some(user) = user_arg(&conn, words.get(1).copied(), "remove") else {
                return ExitCode::FAILURE;
            };
            if flags.get("yes").map(String::as_str) != Some("true") {
                eprintln!(
                    "user remove deletes {} and every vote, model and session they own. Re-run with --yes to confirm.",
                    describe_user(&user)
                );
                return ExitCode::FAILURE;
            }
            delete_user(&conn, user.id);
            println!("removed {}", describe_user(&user));
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!(
                "usage: rekorderlig user link|list|rename|email|revoke|remove … \
                 (run `rekorderlig help` for the flags)"
            );
            ExitCode::FAILURE
        }
    }
}
