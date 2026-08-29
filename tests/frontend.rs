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

/// The CERTAINTY table, parsed out of the source.
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
fn the_certainty_bands_run_high_to_low_and_bottom_out_at_a_floor() {
    // `certainty()` takes the first band the strength clears, so an out-of-order
    // table would label a 96% call by whichever loose band happened to sit first,
    // and a floor above 0 would return undefined for the calls that most need a
    // name — the ones near 0.5.
    let js = read("app.js");
    let table = bands(&js);
    assert!(table.len() >= 3, "too few bands to say anything");
    for pair in table.windows(2) {
        assert!(
            pair[1].at < pair[0].at,
            "{} is not below {}",
            pair[1].name,
            pair[0].name
        );
    }
    assert_eq!(
        table.last().unwrap().at,
        0.0,
        "the last band must be the floor"
    );
    // A call is at least 0.5 sure by construction (it is the strength of the
    // verdict it reached), so a band above 0.5 would never be the floor.
    assert!(
        table[table.len() - 2].at > 0.5,
        "the band above the floor must sit above a coin flip"
    );
}

#[test]
fn every_certainty_band_has_a_colour_of_its_own() {
    // The band names are the contract between the reveal and the stylesheet:
    // `sure-${band.name}` is written as a class in app.js and coloured here.
    // Miss one and that band silently inherits the line's grey, which is exactly
    // the signal the bottom band uses to mean "no opinion".
    let js = read("app.js");
    let css = read("styles.css");
    for band in bands(&js) {
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
