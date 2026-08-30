//! rekorderlig: a personal Hacker News recommender. Library crate so the
//! integration tests can drive the same code the binary runs.

// Re-exported so the integration tests speak the same types (Connection,
// Value) without pinning their own copies of these crates.
pub use rusqlite;
pub use serde_json;

pub mod dates;
pub mod db;
pub mod features;
pub mod firebase;
pub mod hn;
pub mod http_client;
pub mod model;
pub mod server;
pub mod service;
pub mod sync_remote;
pub mod syncer;
pub mod trainer;
