//! Reads: which stories a user has opened, and what the lists do about it.
//! The two-user case — one reader's mark hiding nothing from anyone else — is
//! in tests/users.rs with the rest of the isolation checks.

mod common;

use common::{seed, TempDb};
use rekorderlig::db::{
    mark_read, mark_read_at, mark_unread, read_state, record_vote, Db, ReadKind, ReadState, User,
};
use rekorderlig::model::FitOptions;
use rekorderlig::service::{
    feed, train_and_score, vote_log, FeedOptions, ModelCache, ReadFilter, StoryRow,
};

const OWNER: User = User::OWNER;

fn ids(rows: &[StoryRow]) -> Vec<i64> {
    rows.iter().map(|r| r.id).collect()
}

fn by_id(rows: &[StoryRow], id: i64) -> &StoryRow {
    rows.iter().find(|r| r.id == id).unwrap_or_else(|| panic!("story {id} not listed"))
}

/// The seed corpus with the owner liking Rust and disliking Apple, trained, so
/// the feed has scores to show. Stories 7 and 8 are the two left unvoted.
fn trained(name: &str) -> (Db, ModelCache, TempDb) {
    let db = TempDb::new(name);
    let conn = db.open();
    seed(&conn);
    for id in [1, 2, 3] {
        record_vote(&conn, OWNER, id, 1);
    }
    for id in [4, 5, 6] {
        record_vote(&conn, OWNER, id, -1);
    }
    let cache = ModelCache::default();
    assert!(train_and_score(&conn, &cache, OWNER, FitOptions::default()).trained());
    (conn, cache, db)
}

fn all_time(read: ReadFilter) -> FeedOptions {
    FeedOptions {
        days: 0,
        read,
        ..FeedOptions::default()
    }
}

#[test]
fn a_read_is_one_row_with_two_doors_and_the_first_opening_wins() {
    let db = TempDb::new("reads-row");
    let conn = db.open();
    seed(&conn);

    assert_eq!(read_state(&conn, OWNER, 7), None);
    assert_eq!(
        mark_read_at(&conn, OWNER, 7, ReadKind::Link, 100),
        ReadState {
            link_at: Some(100),
            thread_at: None,
        }
    );
    // The other door joins the same row.
    assert_eq!(
        mark_read_at(&conn, OWNER, 7, ReadKind::Thread, 200),
        ReadState {
            link_at: Some(100),
            thread_at: Some(200),
        }
    );
    // Opening the link again a while later is not news: "read on" stays put.
    assert_eq!(
        mark_read_at(&conn, OWNER, 7, ReadKind::Link, 300),
        ReadState {
            link_at: Some(100),
            thread_at: Some(200),
        },
        "a re-opening moved the first stamp"
    );
    assert_eq!(
        read_state(&conn, OWNER, 7),
        Some(ReadState {
            link_at: Some(100),
            thread_at: Some(200),
        })
    );

    // Forgetting is both doors at once, and idempotent.
    assert!(mark_unread(&conn, OWNER, 7));
    assert!(!mark_unread(&conn, OWNER, 7));
    assert_eq!(read_state(&conn, OWNER, 7), None);

    // The wire spelling is the two doors and nothing else.
    assert_eq!(ReadKind::parse("link"), Some(ReadKind::Link));
    assert_eq!(ReadKind::parse("thread"), Some(ReadKind::Thread));
    assert_eq!(ReadKind::parse("article"), None);
}

#[test]
fn the_feed_hides_what_you_opened_unless_asked_to_show_or_list_it() {
    let (conn, cache, _db) = trained("reads-feed");

    // Nothing read yet: every filter agrees, and no row carries a mark.
    let fresh = feed(&conn, &cache, OWNER, &all_time(ReadFilter::Hide));
    assert_eq!(ids(&fresh.items), vec![7, 8]);
    assert!(fresh
        .items
        .iter()
        .all(|r| r.link_at.is_none() && r.thread_at.is_none()));
    assert_eq!(
        feed(&conn, &cache, OWNER, &all_time(ReadFilter::Only)).total,
        0
    );

    mark_read(&conn, OWNER, 7, ReadKind::Link);

    // Hide is the default: a story you opened is not offered again.
    let hidden = feed(&conn, &cache, OWNER, &all_time(ReadFilter::Hide));
    assert_eq!(ids(&hidden.items), vec![8]);
    assert_eq!(hidden.total, 1, "the count is the list's");

    // Show keeps it in place and marks which door was opened.
    let shown = feed(&conn, &cache, OWNER, &all_time(ReadFilter::Show));
    assert_eq!(ids(&shown.items), vec![7, 8], "the ranking is untouched");
    assert_eq!(shown.total, 2);
    let seven = by_id(&shown.items, 7);
    assert!(seven.link_at.is_some());
    assert!(seven.thread_at.is_none(), "the thread was never opened");
    let eight = by_id(&shown.items, 8);
    assert!(eight.link_at.is_none() && eight.thread_at.is_none());

    // Only is the reading history — the list no other view has.
    let only = feed(&conn, &cache, OWNER, &all_time(ReadFilter::Only));
    assert_eq!(ids(&only.items), vec![7]);
    assert_eq!(only.total, 1);

    // The read filter intersects with the others like any filter: a voted
    // story you also opened is in the history once the vote filter lets it
    // through, and not before.
    mark_read(&conn, OWNER, 1, ReadKind::Thread);
    assert_eq!(
        ids(&feed(&conn, &cache, OWNER, &all_time(ReadFilter::Only)).items),
        vec![7]
    );
    let with_voted = feed(
        &conn,
        &cache,
        OWNER,
        &FeedOptions {
            include_voted: true,
            ..all_time(ReadFilter::Only)
        },
    );
    let mut listed = ids(&with_voted.items);
    listed.sort();
    assert_eq!(listed, vec![1, 7]);

    // Unread puts the story back where it was.
    mark_unread(&conn, OWNER, 7);
    assert_eq!(
        ids(&feed(&conn, &cache, OWNER, &all_time(ReadFilter::Hide)).items),
        vec![7, 8]
    );
}

#[test]
fn the_vote_log_carries_the_mark_too() {
    let (conn, _cache, _db) = trained("reads-votes");

    mark_read(&conn, OWNER, 1, ReadKind::Thread);
    mark_read(&conn, OWNER, 4, ReadKind::Link);
    mark_read(&conn, OWNER, 4, ReadKind::Thread);

    // Every vote stays listed — reading is not a verdict, so the log does not
    // filter on it — and each row says what was opened.
    let log = vote_log(&conn, OWNER, None, 50, 0);
    assert_eq!(log.total, 6);
    let one = by_id(&log.items, 1);
    assert!(one.link_at.is_none());
    assert!(one.thread_at.is_some());
    let four = by_id(&log.items, 4);
    assert!(four.link_at.is_some() && four.thread_at.is_some());
    let two = by_id(&log.items, 2);
    assert!(two.link_at.is_none() && two.thread_at.is_none());
    // The columns the log already carried are still where they were.
    assert!(log.items.iter().all(|r| r.voted_at.is_some()));
}
