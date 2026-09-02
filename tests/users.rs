//! Two users. Every bug specific to multi-user is invisible with one: a LEFT
//! JOIN that forgets its user still returns rows, an anti-join that forgets
//! its user still hides judged stories, a trainer whose status means anyone's
//! run still says `running`. These cases exist to have a second user in the
//! room while each of those is checked.

mod common;

use std::sync::Arc;

use common::{seed, story, FakeSource, TempDb};
use rekorderlig::db::{create_user, record_vote, Db, User, SCHEMA_LOCK};
use rekorderlig::model::FitOptions;
use rekorderlig::service::{
    deal_round, explore_queue, feed, model_history, reset_models, round_status, stats, sync,
    train_and_score, training_queue, vote_log, ExploreBar, FeedOptions, ModelCache, SyncRequest,
    QUEUE_MIN_POINTS, ROUND_SIZE,
};
use rekorderlig::trainer::Trainer;

const OWNER: User = User::OWNER;

fn train(conn: &Db, cache: &ModelCache, user: User) -> rekorderlig::service::TrainOutcome {
    train_and_score(conn, cache, user, FitOptions::default())
}

/// The seed corpus, the owner liking Rust and disliking Apple, and Bob
/// holding exactly the opposite opinion on the same six stories. Stories 7
/// (a compiler) and 8 (Apple stock) are left for both to be shown.
fn two_users(name: &str) -> (Db, ModelCache, User, TempDb) {
    let db = TempDb::new(name);
    let conn = db.open();
    seed(&conn);
    let bob = create_user(&conn, "bob");
    assert_ne!(bob, OWNER);
    for id in [1, 2, 3] {
        record_vote(&conn, OWNER, id, 1);
        record_vote(&conn, bob, id, -1);
    }
    for id in [4, 5, 6] {
        record_vote(&conn, OWNER, id, -1);
        record_vote(&conn, bob, id, 1);
    }
    let cache = ModelCache::default();
    assert!(train(&conn, &cache, OWNER).trained());
    assert!(train(&conn, &cache, bob).trained());
    (conn, cache, bob, db)
}

fn everything() -> FeedOptions {
    FeedOptions {
        days: 0,
        ..FeedOptions::default()
    }
}

fn ids(rows: &[rekorderlig::service::StoryRow]) -> Vec<i64> {
    rows.iter().map(|r| r.id).collect()
}

#[test]
fn each_feed_is_ranked_by_its_own_taste_and_lists_nothing_twice() {
    let (conn, cache, bob, _db) = two_users("users-feed");

    let mine = feed(&conn, &cache, OWNER, &everything());
    let theirs = feed(&conn, &cache, bob, &everything());
    // Two unvoted stories, once each. A LEFT JOIN on `scores` without the user
    // in its ON clause would list each of them twice, ranked by both tastes.
    assert_eq!(mine.total, 2);
    assert_eq!(mine.items.len(), 2);
    assert_eq!(theirs.total, 2);
    assert_eq!(theirs.items.len(), 2);
    assert_eq!(
        ids(&mine.items),
        vec![7, 8],
        "the compiler first for the Rust fan"
    );
    assert_eq!(ids(&theirs.items), vec![8, 7], "Apple first for Bob");

    // With voted stories in, `vote` is the caller's verdict, not anyone's.
    let with_voted = FeedOptions {
        include_voted: true,
        ..everything()
    };
    let mine = feed(&conn, &cache, OWNER, &with_voted);
    let theirs = feed(&conn, &cache, bob, &with_voted);
    assert_eq!(mine.total, 8);
    assert_eq!(theirs.total, 8);
    let vote_on =
        |f: &rekorderlig::service::Feed, id: i64| f.items.iter().find(|r| r.id == id).unwrap().vote;
    assert_eq!(vote_on(&mine, 1), Some(1));
    assert_eq!(vote_on(&theirs, 1), Some(-1));
    assert_eq!(vote_on(&mine, 4), Some(-1));
    assert_eq!(vote_on(&theirs, 4), Some(1));
}

#[test]
fn one_users_skip_hides_nothing_from_anyone_elses_deck() {
    let (conn, cache, bob, _db) = two_users("users-queue");

    // Bob skips the compiler story. A skip is a judgement — for Bob.
    record_vote(&conn, bob, 7, 0);

    let mine = training_queue(&conn, &cache, OWNER, ROUND_SIZE, 1, QUEUE_MIN_POINTS);
    let theirs = training_queue(&conn, &cache, bob, ROUND_SIZE, 1, QUEUE_MIN_POINTS);
    let mut mine_ids = ids(&mine);
    mine_ids.sort();
    assert_eq!(
        mine_ids,
        vec![7, 8],
        "the owner still gets both unjudged stories"
    );
    assert_eq!(ids(&theirs), vec![8], "Bob does not see what Bob skipped");

    // Explore, same rule: a second judging deck, the same votes table.
    let bar = ExploreBar {
        min_points: 1,
        min_comments: 1,
        probably_score: 0.6,
        possibly_score: 0.0,
    };
    let mut mine = ids(&explore_queue(&conn, &cache, OWNER, 10, 0, &bar));
    mine.sort();
    assert_eq!(mine, vec![7, 8]);
    assert_eq!(
        ids(&explore_queue(&conn, &cache, bob, 10, 0, &bar)),
        vec![8]
    );

    // And the cold deck (no model yet) is per user too.
    let newcomer = create_user(&conn, "carol");
    record_vote(&conn, newcomer, 8, 0);
    let mut cold = ids(&training_queue(
        &conn,
        &cache,
        newcomer,
        ROUND_SIZE,
        0,
        QUEUE_MIN_POINTS,
    ));
    cold.sort();
    assert_eq!(
        cold,
        vec![1, 2, 3, 4, 5, 6, 7],
        "everyone else's votes are not Carol's"
    );
}

#[test]
fn votes_and_stats_are_the_callers() {
    let (conn, cache, bob, _db) = two_users("users-votes");
    record_vote(&conn, bob, 7, 0);

    let mine = vote_log(&conn, OWNER, None, 50, 0);
    let theirs = vote_log(&conn, bob, None, 50, 0);
    assert_eq!(mine.total, 6);
    assert_eq!(theirs.total, 7);
    assert_eq!(mine.counts.skip, 0);
    assert_eq!(theirs.counts.skip, 1);
    let verdict = |log: &rekorderlig::service::VoteLog, id: i64| {
        log.items.iter().find(|r| r.id == id).unwrap().vote
    };
    assert_eq!(verdict(&mine, 1), Some(1));
    assert_eq!(verdict(&theirs, 1), Some(-1));
    // The held-out score beside a vote is the caller's model's, so the two
    // logs carry different numbers for the same story.
    let oof = |log: &rekorderlig::service::VoteLog, id: i64| {
        log.items.iter().find(|r| r.id == id).unwrap().oof_score
    };
    assert!(oof(&mine, 1).is_some() && oof(&theirs, 1).is_some());
    assert_ne!(oof(&mine, 1), oof(&theirs, 1));

    // Only skips separate the two stats; the corpus numbers are shared.
    let s_mine = stats(&conn, &cache, OWNER);
    let s_theirs = stats(&conn, &cache, bob);
    assert_eq!(s_mine["votes"]["skip"], 0);
    assert_eq!(s_theirs["votes"]["skip"], 1);
    assert_eq!(s_mine["stories"], s_theirs["stories"]);
    assert_eq!(s_mine["model"]["rev"], 1);
    assert_eq!(s_theirs["model"]["rev"], 1);
    // The distribution is over the caller's scores: the same corpus, two
    // different pictures of it.
    assert_ne!(
        s_mine["model"]["distribution"]["bins"],
        s_theirs["model"]["distribution"]["bins"]
    );
}

#[test]
fn two_rounds_can_be_in_flight_at_once() {
    let (conn, cache, bob, _db) = two_users("users-rounds");

    assert!(round_status(&conn, OWNER).is_none());
    let mine = deal_round(&conn, &cache, OWNER, ROUND_SIZE);
    assert!(
        round_status(&conn, bob).is_none(),
        "the owner's deal is not Bob's"
    );
    let theirs = deal_round(&conn, &cache, bob, ROUND_SIZE);
    assert_eq!(mine["seq"], 1);
    assert_eq!(theirs["seq"], 1, "round numbering is per user");

    // The owner judges a card; only the owner's progress moves.
    let card = mine["cards"][0]["id"].as_i64().unwrap();
    record_vote(&conn, OWNER, card, 1);
    assert_eq!(round_status(&conn, OWNER).unwrap()["judged"], 1);
    assert_eq!(round_status(&conn, bob).unwrap()["judged"], 0);

    // A second deal for Bob does not touch the owner's round.
    let again = deal_round(&conn, &cache, bob, ROUND_SIZE);
    assert_eq!(again["seq"], 2);
    assert_eq!(round_status(&conn, OWNER).unwrap()["seq"], 1);
}

#[test]
fn revisions_are_numbered_per_user_and_a_reset_forgets_only_one_brain() {
    let (conn, cache, bob, _db) = two_users("users-reset");

    // A second train for the owner is the owner's rev 2; Bob stays at 1.
    record_vote(&conn, OWNER, 7, 1);
    assert_eq!(train(&conn, &cache, OWNER).rev(), Some(2));
    assert_eq!(model_history(&conn, OWNER, 60)["revs"], 2);
    assert_eq!(model_history(&conn, bob, 60)["revs"], 1);

    // Reset the owner: Bob's revision survives, the owner's numbering restarts.
    assert_eq!(reset_models(&conn, &cache, OWNER), 2);
    let left: Vec<(i64, i64)> = conn
        .query("SELECT user_id, rev FROM models ORDER BY user_id, rev", &[])
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    assert_eq!(left, vec![(bob.0, 1)]);
    assert_eq!(train(&conn, &cache, OWNER).rev(), Some(1));
    assert_eq!(train(&conn, &cache, bob).rev(), Some(2));
    // And Bob's feed kept working through all of it, off Bob's model.
    assert!(feed(&conn, &cache, bob, &everything()).has_model);
}

#[test]
fn a_sync_scores_the_new_stories_for_every_user_with_a_model() {
    let (conn, cache, bob, _db) = two_users("users-sync");
    // Carol has no model: nothing to score her stories with, and no error.
    let _carol = create_user(&conn, "carol");

    let fresh = story(
        9,
        "Rust compiler speedups",
        Some("https://rustblog.dev/z"),
        Some("rustblog.dev"),
        "u9",
        60,
        60,
        rekorderlig::dates::now_seconds(),
    );
    let source = FakeSource {
        day: move |_: &str, _: u32, _: i64| Ok(vec![fresh.clone()]),
        front_page: || Ok(vec![]),
    };
    let req = SyncRequest {
        days: Some(1),
        front_page: Some(false),
        ..SyncRequest::default()
    };
    let result = sync(&conn, &cache, &req, &source, &mut |_| {}).unwrap();
    assert_eq!(result.inserted, 1);
    assert_eq!(
        result.scored,
        Some(2),
        "one new story, scored once per model"
    );

    let scored: Vec<(i64, f64)> = conn
        .query(
            "SELECT user_id, score FROM scores WHERE story_id = 9 ORDER BY user_id",
            &[],
        )
        .unwrap()
        .iter()
        .map(|r| (r.get(0), r.get(1)))
        .collect();
    assert_eq!(scored.len(), 2);
    assert_eq!(scored[0].0, OWNER.0);
    assert_eq!(scored[1].0, bob.0);
    assert!(
        scored[0].1 > scored[1].1,
        "a Rust title: the owner's yes, Bob's no"
    );
    // Both feeds received it.
    assert!(ids(&feed(&conn, &cache, OWNER, &everything()).items).contains(&9));
    assert!(ids(&feed(&conn, &cache, bob, &everything()).items).contains(&9));
}

#[test]
fn the_trainer_queues_users_and_reports_each_their_own_run() {
    let (conn, _cache, bob, db) = two_users("users-trainer");
    let cache = Arc::new(ModelCache::default());
    let trainer = Trainer::new(db.url.clone(), Arc::clone(&cache));

    // Park the worker: it opens its own connection, and `open_db` takes the
    // schema lock, so holding that lock here freezes the run before it starts
    // and makes the ordering below deterministic rather than a race against a
    // fit that takes a few milliseconds.
    conn.begin();
    conn.execute_batch(&format!("SELECT pg_advisory_xact_lock({SCHEMA_LOCK})"))
        .unwrap();

    let first = trainer.request(OWNER);
    assert_eq!(first["status"], "started");
    assert_eq!(first["running"], true);
    let second = trainer.request(bob);
    assert_eq!(second["status"], "queued");
    assert_eq!(second["pending"], true);
    // The same user again mid-run coalesces into the one follow-up already
    // owed — the owner, whose run is in flight, is queued once...
    assert_eq!(trainer.request(OWNER)["pending"], true);
    assert_eq!(trainer.request(OWNER)["pending"], true);
    // ...and Bob asking twice is still one Bob.
    assert_eq!(trainer.request(bob)["pending"], true);

    // Status is the asker's. Bob's poll must not read the owner's run as its
    // own: `train.js` waits for `running` and `pending` to clear and then asks
    // for a round summary, and the wrong answer here marks a round spent
    // against the old model.
    let bobs = trainer.status(bob);
    assert_eq!(bobs["running"], false);
    assert_eq!(bobs["pending"], true);
    assert!(bobs["startedAt"].is_null());
    let owners = trainer.status(OWNER);
    assert_eq!(owners["running"], true);
    assert!(owners["startedAt"].is_number());

    conn.commit();
    trainer.wait_idle();

    let owners = trainer.status(OWNER);
    let bobs = trainer.status(bob);
    assert_eq!(owners["runs"], 2, "started once, coalesced follow-up once");
    assert_eq!(bobs["runs"], 1, "queued twice, ran once");
    assert_eq!(owners["running"], false);
    assert_eq!(bobs["pending"], false);
    // Each `last` is that user's own outcome: two runs took the owner to rev 3
    // (rev 1 came from the setup), one took Bob to rev 2.
    assert_eq!(owners["last"]["trained"], true);
    assert_eq!(owners["last"]["rev"], 3);
    assert_eq!(bobs["last"]["trained"], true);
    assert_eq!(bobs["last"]["rev"], 2);
    assert!(owners["lastError"].is_null() && bobs["lastError"].is_null());
}
