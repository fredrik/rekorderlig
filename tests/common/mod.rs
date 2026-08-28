//! Shared fixtures for the integration tests: a self-cleaning temp database
//! next to the test files (the same convention the Node suite used) and the
//! seed corpus most service tests start from.

#![allow(dead_code)]

use std::path::PathBuf;

use rekorderlig::dates::{day_key, now_seconds};
use rekorderlig::db::{open_db, upsert_story, Story};
use rekorderlig::hn::HnSource;
use rekorderlig::http_client::FetchError;
use rekorderlig::rusqlite::Connection;

/// A temp database that removes itself (and its WAL sidecars) on drop. Every
/// test gets its own file: unlike `node --test`, `cargo test` runs tests in
/// parallel, so a shared path would race.
pub struct TempDb {
    pub path: PathBuf,
}

impl TempDb {
    pub fn new(name: &str) -> TempDb {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("data")
            .join(format!("tmp-{name}.db"));
        let db = TempDb { path };
        db.remove();
        db
    }

    pub fn open(&self) -> Connection {
        open_db(&self.path)
    }

    fn remove(&self) {
        for suffix in ["", "-wal", "-shm"] {
            let mut p = self.path.clone().into_os_string();
            p.push(suffix);
            let _ = std::fs::remove_file(PathBuf::from(p));
        }
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        self.remove();
    }
}

pub fn story(
    id: i64,
    title: &str,
    url: Option<&str>,
    domain: Option<&str>,
    author: &str,
    points: i64,
    num_comments: i64,
    created_at: i64,
) -> Story {
    Story {
        id,
        title: title.to_string(),
        url: url.map(str::to_string),
        domain: domain.map(str::to_string),
        author: Some(author.to_string()),
        points,
        num_comments,
        created_at,
        day: day_key(created_at),
        fetched_at: now_seconds(),
    }
}

fn host_of(u: &str) -> String {
    url::Url::parse(u).expect("fixture url").host_str().expect("fixture host").to_string()
}

/// The eight-story corpus most service tests start from: three Rust titles,
/// one compiler title, four Apple titles, comment counts doubling as points.
pub fn seed(conn: &Connection) {
    let now = now_seconds();
    let rows: [(i64, &str, &str, i64); 8] = [
        (1, "Rust borrow checker internals", "https://rustblog.dev/a", 120),
        (2, "Writing a compiler in Rust", "https://rustblog.dev/b", 90),
        (3, "Rust async runtime design", "https://tokio.rs/c", 70),
        (4, "Apple announces the new iPhone", "https://apple.com/a", 300),
        (5, "iPhone camera review", "https://theverge.com/b", 250),
        (6, "Apple Vision Pro sales slump", "https://theverge.com/c", 200),
        (7, "A tiny compiler for a toy language", "https://compilers.dev/d", 40),
        (8, "Apple stock hits a record high", "https://cnbc.com/e", 500),
    ];
    for (id, title, url, comments) in rows {
        upsert_story(
            conn,
            &story(
                id,
                title,
                Some(url),
                Some(&host_of(url)),
                &format!("u{id}"),
                comments,
                comments,
                now - id * 3600,
            ),
        );
    }
}

/// A fake Algolia for `sync_days`, the `deps` object of the Node tests.
pub struct FakeSource<FD, FP>
where
    FD: Fn(&str, u32, i64) -> Result<Vec<Story>, FetchError> + Sync,
    FP: Fn() -> Result<Vec<Story>, FetchError> + Sync,
{
    pub day: FD,
    pub front_page: FP,
}

impl<FD, FP> HnSource for FakeSource<FD, FP>
where
    FD: Fn(&str, u32, i64) -> Result<Vec<Story>, FetchError> + Sync,
    FP: Fn() -> Result<Vec<Story>, FetchError> + Sync,
{
    fn fetch_day(&self, day: &str, pages: u32, min_points: i64) -> Result<Vec<Story>, FetchError> {
        (self.day)(day, pages, min_points)
    }
    fn fetch_front_page(&self) -> Result<Vec<Story>, FetchError> {
        (self.front_page)()
    }
}
