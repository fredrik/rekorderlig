//! Port of the Node auth test suite: the optional AUTH_TOKEN gate.

mod common;

use std::path::PathBuf;
use std::sync::Arc;

use common::TempDb;
use rekorderlig::server::{serve, App};

fn status_of(result: Result<ureq::Response, ureq::Error>) -> (u16, Option<ureq::Response>) {
    match result {
        Ok(res) => (res.status(), Some(res)),
        Err(ureq::Error::Status(status, res)) => (status, Some(res)),
        Err(e) => panic!("transport error: {e}"),
    }
}

#[test]
fn auth_token_gates_every_request() {
    let db = TempDb::new("auth");
    let public = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("public");
    let app = App::new(db.path.clone(), public, Some("sesam".to_string()));
    let handle = serve(Arc::clone(&app), "127.0.0.1:0");
    let base = format!("http://127.0.0.1:{}", handle.port);

    // requests without the token are rejected
    assert_eq!(status_of(ureq::get(&format!("{base}/")).call()).0, 401);
    assert_eq!(
        status_of(ureq::get(&format!("{base}/api/stats")).call()).0,
        401
    );
    assert_eq!(
        status_of(ureq::get(&format!("{base}/api/stats?token=wrong")).call()).0,
        401
    );

    // a malformed cookie is a 401, not a crash
    let malformed = ureq::get(&format!("{base}/api/stats"))
        .set("cookie", "rk_token=%E0; junk; a=b=c")
        .call();
    assert_eq!(status_of(malformed).0, 401);
    // the server is still alive
    assert_eq!(
        status_of(
            ureq::get(&format!("{base}/api/stats"))
                .set("authorization", "Bearer sesam")
                .call()
        )
        .0,
        200
    );

    // a bearer header is accepted
    assert_eq!(
        status_of(
            ureq::get(&format!("{base}/api/stats"))
                .set("authorization", "Bearer sesam")
                .call()
        )
        .0,
        200
    );

    // ?token=… works once and sets a cookie for the rest
    let (status, first) = status_of(ureq::get(&format!("{base}/?token=sesam")).call());
    assert_eq!(status, 200);
    let cookie = first.unwrap().header("set-cookie").unwrap().to_string();
    assert!(cookie.contains("rk_token=sesam"), "{cookie}");
    assert!(cookie.contains("HttpOnly"), "{cookie}");
    assert!(
        !cookie.contains("Secure"),
        "plain http must be able to store the cookie: {cookie}"
    );

    let (status, via_proxy) = status_of(
        ureq::get(&format!("{base}/?token=sesam"))
            .set("x-forwarded-proto", "https")
            .call(),
    );
    assert_eq!(status, 200);
    assert!(via_proxy
        .unwrap()
        .header("set-cookie")
        .unwrap()
        .contains("Secure"));

    let next = ureq::get(&format!("{base}/api/stats"))
        .set("cookie", "rk_token=sesam")
        .call();
    assert_eq!(status_of(next).0, 200);

    handle.stop();
}
