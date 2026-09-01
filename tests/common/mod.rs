//! Shared fixtures for the integration tests: a self-cleaning temp database
//! on the local Postgres server, and the seed corpus most service tests start
//! from.

#![allow(dead_code)]

use postgres::{Client, NoTls};

use rekorderlig::dates::{day_key, now_seconds};
use rekorderlig::db::{open_db, upsert_story, Db, Story};
use rekorderlig::hn::HnSource;
use rekorderlig::http_client::FetchError;

/// Where the test server lives. Host and port only — every test appends its
/// own database name. `docker compose up -d` brings up the one CI uses.
fn server_url() -> String {
    let raw = std::env::var("REKORDERLIG_TEST_PG")
        .unwrap_or_else(|_| "postgres://postgres@localhost:5432".to_string());
    raw.trim_end_matches('/').to_string()
}

fn admin() -> Client {
    let url = format!("{}/postgres", server_url());
    Client::connect(&url, NoTls).unwrap_or_else(|e| {
        panic!(
            "no Postgres at {url}: {e}\n\
             The Rust tests need a server. Run `docker compose up -d`, or point \
             REKORDERLIG_TEST_PG at one (host and port only, no database)."
        )
    })
}

/// A temp database that drops itself on drop. Every test gets its own, for the
/// same reason every test used to get its own file: unlike `node --test`,
/// `cargo test` runs tests in parallel, and one shared database would race.
pub struct TempDb {
    pub name: String,
    pub url: String,
}

impl TempDb {
    pub fn new(name: &str) -> TempDb {
        // Test names carry dashes; database names would need quoting for them.
        let name = format!("tmp_{}", name.replace('-', "_"));
        let db = TempDb {
            url: format!("{}/{name}", server_url()),
            name,
        };
        db.drop_database();
        admin()
            .batch_execute(&format!("CREATE DATABASE {}", db.name))
            .expect("create test database");
        db
    }

    pub fn open(&self) -> Db {
        open_db(&self.url)
    }

    fn drop_database(&self) {
        // FORCE, because a test that panicked mid-request can leave the
        // server's side of a connection open for a moment after the client is
        // gone, and a plain DROP would fail on it.
        let _ = admin().batch_execute(&format!(
            "DROP DATABASE IF EXISTS {} WITH (FORCE)",
            self.name
        ));
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        self.drop_database();
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
    url::Url::parse(u)
        .expect("fixture url")
        .host_str()
        .expect("fixture host")
        .to_string()
}

/// The eight-story corpus most service tests start from: three Rust titles,
/// one compiler title, four Apple titles, comment counts doubling as points.
pub fn seed(db: &Db) {
    let now = now_seconds();
    let rows: [(i64, &str, &str, i64); 8] = [
        (
            1,
            "Rust borrow checker internals",
            "https://rustblog.dev/a",
            120,
        ),
        (
            2,
            "Writing a compiler in Rust",
            "https://rustblog.dev/b",
            90,
        ),
        (3, "Rust async runtime design", "https://tokio.rs/c", 70),
        (
            4,
            "Apple announces the new iPhone",
            "https://apple.com/a",
            300,
        ),
        (5, "iPhone camera review", "https://theverge.com/b", 250),
        (
            6,
            "Apple Vision Pro sales slump",
            "https://theverge.com/c",
            200,
        ),
        (
            7,
            "A tiny compiler for a toy language",
            "https://compilers.dev/d",
            40,
        ),
        (
            8,
            "Apple stock hits a record high",
            "https://cnbc.com/e",
            500,
        ),
    ];
    for (id, title, url, comments) in rows {
        upsert_story(
            db,
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
