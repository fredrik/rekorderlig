//! The one thing the SQLite version never had to survive: a connection that is
//! dead when we next reach for it.
//!
//! The Fly app machine suspends to RAM when idle, so every socket held across
//! a suspend is gone on resume and the *first* statement of the first visit
//! meets it. Untested, that is a 500 on every wake — which would look like a
//! flaky app rather than a bug, since the reload always works.

mod common;

use common::{seed, TempDb};
use rekorderlig::db::{record_vote, vote_counts};

#[test]
fn a_dead_connection_is_reopened_and_the_statement_retried() {
    let db = TempDb::new("reconnect-retry");
    let conn = db.open();
    seed(&conn);
    record_vote(&conn, 1, 1);

    // What a suspend does, done deliberately: the server drops this session's
    // backend, and the client has no idea until it writes.
    conn.terminate_for_test();

    let counts = vote_counts(&conn);
    assert_eq!(
        counts.up, 1,
        "the read after a disconnect answers, not 500s"
    );

    // And the reopened connection is a working one, not a one-shot.
    record_vote(&conn, 2, -1);
    assert_eq!(vote_counts(&conn).total, 2);
}

#[test]
fn a_transaction_survives_the_connection_it_was_opened_on_being_reused() {
    let db = TempDb::new("reconnect-tx");
    let conn = db.open();
    seed(&conn);

    // A handler that panicked between BEGIN and COMMIT leaves the shared
    // connection mid-transaction. `lock_db` calls this before handing the
    // guard to the next request; without it every later statement on that
    // connection would fail with "current transaction is aborted".
    conn.begin();
    record_vote(&conn, 1, 1);
    conn.rollback_if_open();

    assert_eq!(
        vote_counts(&conn).total,
        0,
        "the abandoned transaction is rolled back, not committed"
    );
    record_vote(&conn, 2, 1);
    assert_eq!(
        vote_counts(&conn).total,
        1,
        "and the connection still works"
    );
}
