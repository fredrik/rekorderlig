//! What code this is: `APP`, `COMMIT`, and `built_at()`, baked in at compile
//! time so the running binary can say which commit it was built from and
//! when. `info()` is the `version` object on `/api/stats`; `describe()` is
//! the CLI/boot-log line — together they let a preview and production be
//! told apart by looking.
//!
//! `GIT_SHA` and `BUILD_TIME` (unix seconds) arrive as Docker build args that
//! the deploy workflows pass to `flyctl deploy`; the Dockerfile hands them to
//! `cargo build` as environment. A plain `cargo build` has neither, and
//! `option_env!` makes that a dev build rather than a compile error.

use serde_json::{json, Value};

/// Cargo's version. Static across commits today, so the commit is the number
/// that actually identifies the code; this is here because it is free.
pub const APP: &str = env!("CARGO_PKG_VERSION");

/// The full commit hash the image was built from, if the build said.
pub const COMMIT: Option<&str> = option_env!("GIT_SHA");

/// When the image was built, as unix seconds, if the build said. Within a
/// minute of the deploy in this pipeline, which is why the UI calls it "built".
pub fn built_at() -> Option<i64> {
    option_env!("BUILD_TIME").and_then(|s| s.trim().parse().ok())
}

/// The `version` object on `/api/stats`. The two build-time fields are
/// present-and-null on a dev build rather than missing, so a client can tell
/// "dev build" from "a server too old to say".
pub fn info() -> Value {
    json!({
        "app": APP,
        "commit": COMMIT,
        "builtAt": built_at(),
    })
}

/// One line for the terminal: `rekorderlig 1.0.0 (763071c, built 2026-09-01)`
/// or `rekorderlig 1.0.0 (dev build)`.
pub fn describe() -> String {
    match (COMMIT, built_at()) {
        (Some(sha), Some(ts)) => format!(
            "rekorderlig {APP} ({}, built {})",
            short(sha),
            crate::dates::day_key(ts)
        ),
        (Some(sha), None) => format!("rekorderlig {APP} ({})", short(sha)),
        _ => format!("rekorderlig {APP} (dev build)"),
    }
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(7)]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn info_has_every_key_even_on_a_dev_build() {
        let v = info();
        assert_eq!(v["app"], APP);
        assert!(v.get("commit").is_some());
        assert!(v.get("builtAt").is_some());
    }

    #[test]
    fn describe_names_the_app_whatever_the_build_knows() {
        assert!(describe().starts_with(&format!("rekorderlig {APP} (")));
    }

    #[test]
    fn short_does_not_panic_on_a_short_sha() {
        assert_eq!(short("abc"), "abc");
        assert_eq!(short("abc1234def5678"), "abc1234");
    }
}
