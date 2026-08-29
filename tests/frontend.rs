//! Tripwires over the front end's source, ported from the Node suite:
//! `app.js` touches `document` at load, so there is nothing to import in a test
//! run with no browser in it. These read the file as text and check the parts
//! two files have to agree on.

use regex::Regex;

fn read(path: &str) -> String {
    std::fs::read_to_string(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("public")
            .join(path),
    )
    .expect("frontend file")
}

struct Band {
    at: f64,
    name: String,
}

/// The CERTAINTY table, parsed out of certainty.js.
fn bands(js: &str) -> Vec<Band> {
    let table = Regex::new(r"(?s)const CERTAINTY = \[(.*?)\];")
        .unwrap()
        .captures(js)
        .expect("CERTAINTY table missing");
    Regex::new(r"at: ([\d.]+), name: '(\w+)', label: '([^']+)'")
        .unwrap()
        .captures_iter(&table[1])
        .map(|c| Band {
            at: c[1].parse().unwrap(),
            name: c[2].to_string(),
        })
        .collect()
}

#[test]
fn every_certainty_band_has_a_colour_of_its_own() {
    // The band names are the contract between the reveal and the stylesheet:
    // `sure-${band.name}` is written as a class in app.js and coloured here.
    // Miss one and that band silently inherits the line's grey, which is exactly
    // the signal the bottom band uses to mean "no opinion".
    //
    // This one stays a source tripwire when the rest of the CERTAINTY checks
    // became real tests, because it is the half no test can run: nothing at
    // runtime notices a missing colour, and the two files are a stylesheet and
    // a module with no import between them.
    let css = read("styles.css");
    for band in bands(&read("certainty.js")) {
        let rule = Regex::new(&format!(r"\.verdict\.sure-{} \{{[^}}]*color:", band.name)).unwrap();
        assert!(rule.is_match(&css), "sure-{} is uncoloured", band.name);
    }
    // The hue comes from hit/miss and is mixed by the band; setting it through a
    // variable is what makes that possible (`currentColor` in `color` resolves to
    // the inherited value, so mixing against it would use the line's grey).
    assert!(
        Regex::new(r"\.verdict\.hit \{[^}]*--verdict-hue:\s*var\(--up\)")
            .unwrap()
            .is_match(&css)
    );
    assert!(
        Regex::new(r"\.verdict\.miss \{[^}]*--verdict-hue:\s*var\(--down\)")
            .unwrap()
            .is_match(&css)
    );
}

#[test]
fn the_reveal_names_its_certainty_in_words_not_just_a_percentage() {
    // "51% certain" was the bug: the one word the line had for confidence was
    // true at 96% and a lie at 51%.
    let js = read("app.js");
    assert!(
        !js.contains("certain)"),
        "the reveal still calls a percentage \"certain\""
    );
    assert!(
        js.contains("Brain guessed ${guessedYes ? 'yes' : 'no'} (${sure.label}, ${pct(strength)})")
    );
}

#[test]
fn the_deck_grids_have_a_zero_floor_so_no_card_is_sized_by_its_content() {
    // `#view-train`'s track was `auto`, which takes its minimum from the item's
    // min-content — and the judged title under the buttons is `nowrap`. One long
    // title therefore sized the whole view to that title: 527px of card, vote row
    // and status inside a 380px phone, scrolling sideways. Explore is the same
    // cluster over a different queue, so the floor has to cover it too.
    let css = read("styles.css");
    // Anchored at line start: "#view-train" also appears inside a comment.
    let rule = Regex::new(r"(?ms)^#view-train[^{]*\{[^}]*\}")
        .unwrap()
        .find(&css)
        .expect("#view-train rule missing")
        .as_str();
    assert!(Regex::new(r"grid-template-columns:\s*minmax\(0,\s*1fr\)")
        .unwrap()
        .is_match(rule));
    assert!(
        rule.contains("#view-explore"),
        "Explore is missing the zero floor"
    );
    assert!(Regex::new(r"(?s)\.train-main \{[^}]*min-width:\s*0")
        .unwrap()
        .is_match(&css));
    assert!(Regex::new(r"(?s)\.explore-main \{[^}]*min-width:\s*0")
        .unwrap()
        .is_match(&css));
}

#[test]
fn the_curve_readout_and_the_highlighted_dot_name_the_same_run() {
    // Hovering the learning curve swaps the readout, so the chart has to say
    // *which* dot the readout describes: app.js toggles `hot` on that run's
    // dot and hangs the hover on an invisible `curve-hit` twin (the visible
    // dot is 2px — not a hit area). Lose either stylesheet rule and hovering
    // still rewrites the numbers while nothing on the chart moves, which is
    // the bug this pair exists to prevent. The pointerleave reset is what
    // keeps the readout from sticking forever to an old hover.
    let js = read("app.js");
    let css = read("styles.css");
    assert!(
        js.contains("classList.toggle('hot'"),
        "app.js no longer highlights the run the readout describes"
    );
    assert!(
        js.contains("class: 'curve-hit'"),
        "app.js no longer draws hover targets over the dots"
    );
    assert!(
        js.contains("addEventListener('pointerleave'"),
        "leaving a chart no longer restores its readout"
    );
    assert!(
        Regex::new(r"(?s)\.curve-dot\.hot \{[^}]*stroke")
            .unwrap()
            .is_match(&css),
        "the highlighted dot has no visible treatment"
    );
    assert!(
        Regex::new(r"(?s)\.curve-hit \{[^}]*pointer-events:\s*all")
            .unwrap()
            .is_match(&css),
        "the hover targets are not hit-testable"
    );
}

#[test]
fn titles_break_inside_an_unbreakable_token_rather_than_out_of_the_page() {
    // A raw URL or a scoped package name in an HN title is wider than a phone at
    // the trainer card's 32px, and a domain has no spaces at all: a real one,
    // `observationalepidemiology.blogspot.com`, overflowed the card at 320px.
    let css = read("styles.css");
    for selector in [
        ".trainer-title",
        ".trainer-meta",
        ".story-title",
        ".term-chip",
    ] {
        let rule = Regex::new(&format!(r"(?s)\{} \{{[^}}]*\}}", selector))
            .unwrap()
            .find(&css)
            .unwrap_or_else(|| panic!("{selector} rule missing"))
            .as_str();
        assert!(
            Regex::new(r"overflow-wrap:\s*anywhere")
                .unwrap()
                .is_match(rule),
            "{selector} may overflow"
        );
    }
}

#[test]
fn the_boot_rewrite_strips_the_token_from_the_address_bar() {
    // ?token=… is a bootstrap: `authorize()` answers the first tokened request
    // with a year-long `rk_token` cookie and everything after it rides on that.
    // The front end used to append `location.search` to every history entry,
    // which kept the shared secret in the address bar for the whole session and
    // stamped it into every bookmark and copied link. Boot must delete it.
    let js = read("app.js");
    assert!(
        js.contains("searchParams.delete('token')"),
        "boot no longer strips ?token= from the URL"
    );
    // And nothing may put it back: every history write has to go through a
    // search string the strip has already been through, never `location.href`
    // or a hand-built `token=`.
    for call in Regex::new(r"history\.(replaceState|pushState)\([^;]*?\);")
        .unwrap()
        .find_iter(&js)
    {
        assert!(
            !call.as_str().contains("token"),
            "a history write carries the token: {}",
            call.as_str()
        );
    }
}

#[test]
fn the_token_is_stripped_only_after_the_cookie_is_proven() {
    // The strip is safe because it happens *after* an authorized fetch that
    // carried no token of its own: `refreshStats()` calls /api/stats with no
    // param and no Bearer header, so reaching the rewrite proves the cookie
    // took. A 401 throws out of `api()` and the rewrite never runs, leaving the
    // tokened URL intact for a reload. Reordering these two silently removes
    // the only recovery path a browser that refuses the cookie has.
    let js = read("app.js");
    let stats = js
        .rfind("await refreshStats();")
        .expect("boot no longer awaits refreshStats()");
    let strip = js
        .find("searchParams.delete('token')")
        .expect("boot no longer strips the token");
    assert!(
        stats < strip,
        "the token is stripped before the cookie is proven to work"
    );
}

/// The body of a top-level `function name(...) { ... }`, by brace matching.
fn body_of<'a>(js: &'a str, name: &str) -> &'a str {
    let start = js
        .find(&format!("function {name}("))
        .unwrap_or_else(|| panic!("{name} missing"));
    // The brace after the parameter list, not the first one in the signature:
    // every function here destructures its options (`{ reset = false } = {}`),
    // so the first `{` belongs to a parameter and the body would come back as
    // the default value — with every assertion below it silently passing.
    let open = js[start..].find(") {").expect("no body") + start + 2;
    let mut depth = 0;
    for (i, c) in js[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return &js[open..open + i];
                }
            }
            _ => {}
        }
    }
    panic!("{name} body never closes");
}

/// The keys of a top-level `const NAME = { ... }` object literal.
fn keys_of(js: &str, name: &str) -> Vec<String> {
    let start = js
        .find(&format!("const {name} = {{"))
        .unwrap_or_else(|| panic!("{name} missing"));
    let open = js[start..].find('{').expect("no literal") + start;
    let mut depth = 0;
    let mut end = open;
    for (i, c) in js[open..].char_indices() {
        match c {
            '{' | '(' | '[' => depth += 1,
            '}' | ')' | ']' => {
                depth -= 1;
                if depth == 0 {
                    end = open + i;
                    break;
                }
            }
            _ => {}
        }
    }
    // Only keys at the literal's own depth, so a nested object contributes none.
    let mut depth = 0;
    let mut keys = Vec::new();
    for line in js[open..end].lines() {
        let trimmed = line.trim();
        if depth == 1 {
            if let Some(key) = Regex::new(r"^(\w+):").unwrap().captures(trimmed) {
                keys.push(key[1].to_string());
            }
        }
        depth += trimmed.matches(['{', '(', '[']).count() as i32;
        depth -= trimmed.matches(['}', ')', ']']).count() as i32;
    }
    keys.sort();
    keys
}

/// The `key: 'v'` values of a top-level `const NAME = { ... }` object literal.
fn values_of(js: &str, name: &str) -> Vec<String> {
    let start = js
        .find(&format!("const {name} = {{"))
        .unwrap_or_else(|| panic!("{name} missing"));
    let end = js[start..].find("\n};").expect("literal never closes") + start;
    Regex::new(r"(?m)^\s+\w+: '([^']*)',")
        .unwrap()
        .captures_iter(&js[start..end])
        .map(|c| c[1].to_string())
        .collect()
}

#[test]
fn every_feed_filter_reaches_the_feed_request() {
    // The one half of this that no test can run: FEED_DEFAULTS lives in
    // feed-params.js and `loadFeed()` lives in app.js, and a filter the request
    // never sends is a URL that changes nothing at all — it survives a chip
    // click and does nothing on a reload. The key set and the letters are
    // checked for real in tests/feed-params.test.mjs.
    let params = read("feed-params.js");
    let defaults = keys_of(&params, "FEED_DEFAULTS");
    assert!(defaults.len() >= 5, "FEED_DEFAULTS looks empty: {defaults:?}");
    let app = read("app.js");
    let sent = body_of(&app, "loadFeed");
    for key in &defaults {
        assert!(
            sent.contains(&format!("{key}:")) || sent.contains(&format!("'{key}'")),
            "{key} is a filter the feed request never sends"
        );
    }
}

#[test]
fn the_histogram_drill_down_does_not_mirror_the_panel_by_hand() {
    // `showScoreBand()` used to set six widgets itself so the closed filter
    // panel wouldn't lie when it was next opened — the symptom that the filters
    // had no single source of truth. It sets state and calls `paintFilters()`
    // now; touching the DOM here again would fork the panel from the URL.
    let js = read("app.js");
    let body = body_of(&js, "showScoreBand");
    assert!(
        body.contains("paintFilters()"),
        "showScoreBand no longer repaints from state"
    );
    for hand in ["classList", ".value =", ".textContent ="] {
        assert!(
            !body.contains(hand),
            "showScoreBand paints `{hand}` by hand instead of via paintFilters()"
        );
    }
}

#[test]
fn only_the_histogram_drill_down_pushes_a_history_entry() {
    // Dragging the slider or typing in the search box must not stack history
    // entries — the back button would then walk out of a search one keystroke
    // at a time instead of leaving the feed. `setFeed()` replaces by default
    // and pushes only when asked, and the drill-down is what asks: arriving at
    // a bucket from Brain is a navigation, and back should reach the chart.
    let js = read("app.js");
    let body = body_of(&js, "setFeed");
    assert!(
        body.contains("if (push) history.pushState") && body.contains("else history.replaceState"),
        "setFeed no longer chooses between pushing and replacing"
    );
    assert!(
        Regex::new(r"function setFeed\(patch, \{ push = false \}")
            .unwrap()
            .is_match(&js),
        "setFeed must default to replacing, so the panel's controls don't stack history"
    );
}
