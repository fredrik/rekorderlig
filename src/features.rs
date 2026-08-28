//! Feature extraction: a story becomes a sparse map of `feature name -> weight`.
//!
//! Everything is a readable string ("w:rust", "dom:github.com") rather than a hash
//! bucket, so the trained weights can be shown back to the user as "you like X".

use std::collections::HashMap;
use unicode_normalization::UnicodeNormalization;

// Words that carry no taste signal. Deliberately short: on titles, most words matter.
// "I" is a pronoun, not a topic: 112 titles in a 3.3k corpus, none of them about the
// same thing. The shape it signals — "Show HN: I built…" — is already carried by
// `t:narrative` and `t:showhn`.
const STOP: &[&str] = &[
    "a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "is", "are", "was",
    "be", "by", "it", "its", "as", "at", "from", "that", "this", "with", "you", "your",
    "i",
];

fn is_stop(word: &str) -> bool {
    STOP.contains(&word)
}

const SUFFIXES: &[&str] = &["ing", "ers", "er", "ed", "es", "s"];

/// Light stemmer: collapses plurals/gerunds so "compiler"/"compilers" share a weight.
pub fn stem(word: &str) -> String {
    if word.len() <= 4 {
        return word.to_string();
    }
    for suf in SUFFIXES {
        if word.len() >= suf.len() + 4 && word.ends_with(suf) {
            return word[..word.len() - suf.len()].to_string();
        }
    }
    word.to_string()
}

pub fn tokenize(title: &str) -> Vec<String> {
    let mut cleaned = String::with_capacity(title.len());
    // Lowercase, then NFKD so accented letters shed their diacritics below.
    for c in title.to_lowercase().nfkd() {
        // combining diacritics left over from NFKD
        if ('\u{0300}'..='\u{036f}').contains(&c) {
            continue;
        }
        // Apostrophes vanish rather than split: “isn't” -> “isnt”, “musk's” -> “musks”
        // (then stemmed to “musk”), instead of shedding junk “t”/“s” tokens.
        if matches!(c, '\u{2019}' | '\u{2018}' | '\'' | '`') {
            continue;
        }
        // `&` and `/` survive *inside* a word (they are trimmed off the ends
        // below), because as separators they shred things that mean something:
        // "S&P 500" became "s" + "p" + "500", and "278 tok/s" left a bare "s"
        // behind — which is exactly the junk signal that showed up as a learned
        // term. AT&T, R&D, M&A and km/h have the same shape.
        if c.is_ascii_lowercase()
            || c.is_ascii_digit()
            || matches!(c, '+' | '#' | '.' | '-' | '&' | '/')
            || c.is_whitespace()
        {
            cleaned.push(c);
        } else {
            cleaned.push(' ');
        }
    }
    // keep "c++", "c#", "asp.net", "gpt-4", "s&p", "tok/s". Punctuation on the
    // ends goes, so a bare ".net" arrives as "net" — inside a word it stays.
    cleaned
        .split_whitespace()
        .map(|t| t.trim_matches(|c| matches!(c, '.' | '-' | '&' | '/')))
        .filter(|t| !t.is_empty() && t.len() < 30)
        .map(str::to_string)
        .collect()
}

pub fn domain_of(url: Option<&str>) -> Option<String> {
    let raw = url?;
    let parsed = url::Url::parse(raw).ok()?;
    let host = parsed.host_str()?.to_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

/// A sparse feature vector that keeps insertion order, the way a JS Map does.
/// Order matters twice: the model indexes features in first-seen order (which
/// keeps training deterministic), and `newSignals` names them in title order.
#[derive(Debug, Clone, Default)]
pub struct Features {
    entries: Vec<(String, f64)>,
    index: HashMap<String, usize>,
}

impl Features {
    pub fn add(&mut self, name: &str, weight: f64) {
        if let Some(&i) = self.index.get(name) {
            self.entries[i].1 += weight;
        } else {
            self.index.insert(name.to_string(), self.entries.len());
            self.entries.push((name.to_string(), weight));
        }
    }

    pub fn get(&self, name: &str) -> Option<f64> {
        self.index.get(name).map(|&i| self.entries[i].1)
    }

    pub fn has(&self, name: &str) -> bool {
        self.index.contains_key(name)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, f64)> {
        self.entries.iter().map(|(n, v)| (n.as_str(), *v))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// github.com -> ["dom:github.com"]; blog.acme.co.uk -> also "dom:acme.co.uk"
fn domain_features(domain: &str, f: &mut Features) {
    f.add(&format!("dom:{domain}"), 1.0);
    let parts: Vec<&str> = domain.split('.').collect();
    if parts.len() > 2 {
        let keep = if parts.len() > 3 { 3 } else { 2 };
        let registrable = parts[parts.len() - keep..].join(".");
        if registrable != domain {
            f.add(&format!("dom:{registrable}"), 0.5);
        }
    }
    if let Some(tld) = parts.last().filter(|t| !t.is_empty()) {
        f.add(&format!("tld:{tld}"), 0.3);
    }
}

/// What `featurize` reads off a story: only what the model is allowed to see.
/// Points, comments and age are deliberately absent — see CLAUDE.md.
#[derive(Debug, Clone, Copy, Default)]
pub struct StoryText<'a> {
    pub title: &'a str,
    pub url: Option<&'a str>,
    pub domain: Option<&'a str>,
    pub author: Option<&'a str>,
}

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `\b(19|20)\d{2}\b`, by hand: a four-digit 19xx/20xx run with no word
/// character on either side.
fn has_year(title: &str) -> bool {
    let cs: Vec<char> = title.chars().collect();
    if cs.len() < 4 {
        return false;
    }
    for i in 0..=cs.len() - 4 {
        let century = (cs[i] == '1' && cs[i + 1] == '9') || (cs[i] == '2' && cs[i + 1] == '0');
        if !century || !cs[i + 2].is_ascii_digit() || !cs[i + 3].is_ascii_digit() {
            continue;
        }
        let word_before = i > 0 && is_word_char(cs[i - 1]);
        let word_after = i + 4 < cs.len() && is_word_char(cs[i + 4]);
        if !word_before && !word_after {
            return true;
        }
    }
    false
}

/// Case-insensitive prefix test. `prefix` is one of the lowercase literals below.
fn starts_with_ci(title: &str, prefix: &str) -> bool {
    let mut t = title.chars().flat_map(char::to_lowercase);
    prefix.chars().all(|p| t.next() == Some(p))
}

pub fn featurize(story: StoryText<'_>) -> Features {
    let mut f = Features::default();

    f.add("__bias__", 1.0);

    let raw = tokenize(story.title);
    let words: Vec<String> = raw
        .iter()
        .filter(|w| !is_stop(w))
        .map(|w| stem(w))
        .collect();

    for w in &words {
        f.add(&format!("w:{w}"), 1.0);
        // "llm-assisted" also votes for "llm" and "assist", so related titles share signal.
        if w.contains('-') || w.contains('.') {
            for part in w.split(['-', '.']) {
                if part.len() > 1 && part != w && !is_stop(part) {
                    f.add(&format!("w:{}", stem(part)), 0.5);
                }
            }
        }
    }
    for pair in words.windows(2) {
        f.add(&format!("b:{}_{}", pair[0], pair[1]), 0.7);
    }

    // Shape of the title, independent of vocabulary. Deliberately weak: these fire
    // on almost every story, so at full strength they drown out the actual topic.
    let title = story.title;
    let style = 0.6;
    if title.trim_end().ends_with('?') {
        f.add("t:question", style);
    }
    if starts_with_ci(title, "show hn") {
        f.add("t:showhn", style);
    }
    if starts_with_ci(title, "ask hn") {
        f.add("t:askhn", style);
    }
    if starts_with_ci(title, "tell hn") {
        f.add("t:tellhn", style);
    }
    if has_year(title) {
        f.add("t:has_year", style);
    }
    if title.chars().any(|c| c.is_ascii_digit()) {
        f.add("t:has_number", style);
    }
    if ["how", "why", "what", "when", "the case for", "i "]
        .iter()
        .any(|p| starts_with_ci(title, p))
    {
        f.add("t:narrative", style);
    }
    // Title length correlates with taste far less than it appears to at 20 votes.
    f.add(&format!("t:len{}", (raw.len() / 3).min(6)), 0.3);

    let domain = story
        .domain
        .map(str::to_string)
        .or_else(|| domain_of(story.url));
    match &domain {
        Some(d) => domain_features(d, &mut f),
        None => f.add("t:selfpost", 1.0),
    }

    if let Some(author) = story.author {
        f.add(&format!("by:{}", author.to_lowercase()), 0.6);
    }

    f
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct FeatureDesc {
    pub kind: String,
    pub label: String,
}

/// Human-readable label for a feature name, for the "what it learned" panel.
pub fn describe_feature(name: &str) -> FeatureDesc {
    let (kind, body) = match name.split_once(':') {
        Some((k, b)) => (k, b),
        None => (name, ""),
    };
    let desc = |kind: &str, label: String| FeatureDesc {
        kind: kind.to_string(),
        label,
    };
    match kind {
        "__bias__" => desc("baseline", "baseline".to_string()),
        "w" => desc("word", body.to_string()),
        "b" => desc("phrase", body.replace('_', " ")),
        "dom" => desc("site", body.to_string()),
        "tld" => desc("site", format!(".{body}")),
        "by" => desc("author", format!("@{body}")),
        "t" => desc(
            "style",
            style_label(body)
                .map(str::to_string)
                .unwrap_or_else(|| body.to_string()),
        ),
        _ => desc(
            kind,
            if body.is_empty() {
                name.to_string()
            } else {
                body.to_string()
            },
        ),
    }
}

fn style_label(body: &str) -> Option<&'static str> {
    Some(match body {
        "question" => "titles that ask a question",
        "showhn" => "Show HN posts",
        "askhn" => "Ask HN posts",
        "tellhn" => "Tell HN posts",
        "has_year" => "titles containing a year",
        "has_number" => "titles containing a number",
        "narrative" => "first-person / explainer titles",
        "selfpost" => "text posts (no link)",
        "len0" => "very short titles",
        "len1" => "short titles",
        "len2" => "medium titles",
        "len3" => "longer titles",
        "len4" => "long titles",
        "len5" => "very long titles",
        "len6" => "extremely long titles",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn title(t: &str) -> StoryText<'_> {
        StoryText {
            title: t,
            ..Default::default()
        }
    }

    #[test]
    fn tokenize_keeps_technical_tokens_intact() {
        assert_eq!(
            tokenize("Rust 1.80: C++ interop, .NET and GPT-4"),
            vec!["rust", "1.80", "c++", "interop", "net", "and", "gpt-4"]
        );
    }

    #[test]
    fn apostrophes_vanish_instead_of_splitting_off_junk_tokens() {
        assert_eq!(tokenize("Isn\u{2019}t Musk\u{2019}s X"), vec!["isnt", "musks", "x"]);
        assert_eq!(tokenize("What's Apple's plan"), vec!["whats", "apples", "plan"]);
    }

    #[test]
    fn stem_collapses_common_suffixes_but_leaves_short_words_alone() {
        assert_eq!(stem("compilers"), "compil");
        assert_eq!(stem("rust"), "rust");
        assert_eq!(stem("news"), "news");
    }

    #[test]
    fn domain_of_strips_www_and_lowercases() {
        assert_eq!(
            domain_of(Some("https://WWW.Example.com/a/b?c=1")),
            Some("example.com".to_string())
        );
        assert_eq!(domain_of(None), None);
        assert_eq!(domain_of(Some("not a url")), None);
    }

    #[test]
    fn featurize_captures_words_phrases_site_and_style() {
        let f = featurize(StoryText {
            title: "Show HN: A tiny compiler",
            url: Some("https://blog.example.co.uk/x"),
            author: Some("ada"),
            ..Default::default()
        });
        assert_eq!(f.get("__bias__"), Some(1.0));
        assert!(f.has("w:compil"));
        assert!(f.has("b:show_hn"));
        assert!(f.has("t:showhn"));
        assert_eq!(f.get("dom:blog.example.co.uk"), Some(1.0));
        // registrable domain is a separate, weaker signal
        assert!(f.has("dom:example.co.uk"));
        assert!(f.has("by:ada"));
    }

    #[test]
    fn featurize_marks_text_posts_and_questions() {
        let f = featurize(title("Ask HN: Is Kubernetes worth it?"));
        assert!(f.has("t:selfpost"));
        assert!(f.has("t:question"));
        assert!(f.has("t:askhn"));
    }

    #[test]
    fn hyphenated_words_also_emit_their_parts() {
        let f = featurize(title("LLM-assisted refactoring"));
        assert!(f.has("w:llm-assist"));
        assert_eq!(f.get("w:llm"), Some(0.5));
    }

    #[test]
    fn describe_feature_produces_readable_labels() {
        assert_eq!(
            describe_feature("dom:github.com"),
            FeatureDesc { kind: "site".into(), label: "github.com".into() }
        );
        assert_eq!(
            describe_feature("b:borrow_checker"),
            FeatureDesc { kind: "phrase".into(), label: "borrow checker".into() }
        );
        assert_eq!(describe_feature("t:showhn").label, "Show HN posts");
    }

    #[test]
    fn ampersand_and_slash_hold_words_together_instead_of_shredding_them() {
        // These characters used to fall into the separator class, which turned
        // "S&P 500" into "s" + "p" + "500" and left a bare "s" behind from "tok/s".
        // A stray "s" then showed up as something the model had learned.
        assert_eq!(
            tokenize("Reddit will join the S&P 500 index"),
            vec!["reddit", "will", "join", "the", "s&p", "500", "index"]
        );
        assert_eq!(tokenize("DeepSeek at 278 tok/s"), vec!["deepseek", "at", "278", "tok/s"]);
        assert_eq!(
            tokenize("AT&T and R&D at 100 km/h"),
            vec!["at&t", "and", "r&d", "at", "100", "km/h"]
        );

        // Still trimmed off the ends, so a lone separator is not a token.
        assert_eq!(tokenize("this & that"), vec!["this", "that"]);
        assert_eq!(tokenize("rust / go"), vec!["rust", "go"]);

        // The technical tokens that already worked keep working.
        assert_eq!(tokenize("gpt-4 vs c++ and c#"), vec!["gpt-4", "vs", "c++", "and", "c#"]);
    }

    #[test]
    fn i_is_a_pronoun_not_a_topic() {
        let f = featurize(title("Show HN: I rewrote my cert generator"));
        assert!(!f.has("w:i"), "dropped as a stop word");
        assert!(f.has("w:rewrote"), "the rest of the title survives");
        // Single letters that mean something are untouched.
        assert!(featurize(title("I built a C compiler")).has("w:c"));
    }
}
