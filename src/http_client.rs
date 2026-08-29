//! The one JSON fetch helper, shared by the two Hacker News sources
//! (`hn.rs` over Algolia's search index, `firebase.rs` over the official item
//! API). Extracted so the second source does not fork a copy of the retry rule.
//!
//! Retries only what is worth retrying: 429 and 5xx are the remote having a bad
//! moment, while a 4xx is the request itself being wrong and will not improve by
//! being asked again. Transport errors (reset, timeout) are retried too.

use std::time::Duration;

use serde_json::Value;

const UA: &str = "rekorderlig/1.0 (personal HN recommender)";

#[derive(Debug, Clone)]
pub struct FetchError {
    pub message: String,
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for FetchError {}

/// What the sources depend on instead of a concrete HTTP stack, so tests can
/// hand in a fake Hacker News. `Sync` because the backfill fans requests out
/// over a small thread pool.
pub trait Fetch: Sync {
    fn get_json(&self, url: &str) -> Result<Value, FetchError>;
}

/// Closures double as fetchers in tests.
impl<F> Fetch for F
where
    F: Fn(&str) -> Result<Value, FetchError> + Sync,
{
    fn get_json(&self, url: &str) -> Result<Value, FetchError> {
        self(url)
    }
}

pub struct HttpFetcher {
    agent: ureq::Agent,
    retries: u32,
}

impl Default for HttpFetcher {
    fn default() -> Self {
        HttpFetcher {
            agent: ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(30))
                .build(),
            retries: 3,
        }
    }
}

impl Fetch for HttpFetcher {
    fn get_json(&self, url: &str) -> Result<Value, FetchError> {
        let mut last = FetchError {
            message: "no attempt made".to_string(),
        };
        for attempt in 0..=self.retries {
            let (retryable, err) = match self.agent.get(url).set("user-agent", UA).call() {
                Ok(res) => match res.into_json::<Value>() {
                    Ok(v) => return Ok(v),
                    Err(e) => (
                        true,
                        FetchError {
                            message: format!("bad JSON: {e}"),
                        },
                    ),
                },
                Err(ureq::Error::Status(code, _)) => (
                    code == 429 || code >= 500,
                    FetchError {
                        message: format!("HTTP {code}"),
                    },
                ),
                Err(e) => (
                    true,
                    FetchError {
                        message: e.to_string(),
                    },
                ),
            };
            last = err;
            if !retryable || attempt == self.retries {
                break;
            }
            std::thread::sleep(Duration::from_millis(500 * (1 << attempt)));
        }
        Err(last)
    }
}
