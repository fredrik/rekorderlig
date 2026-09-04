//! A small L2-regularised, class-balanced logistic regression over the sparse
//! title features, trained with AdaGrad SGD, with score shrinkage toward 0.5
//! and a 5-fold cross-validation (`heldOut`, `noise`) feeding `accuracyMove()`.
//! Everything is deterministic: the same votes always produce the same model
//! (same votes → same weights), which keeps the "why did it score this?"
//! panel honest.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::features::{describe_feature, featurize, FeatureDesc, Features, StoryText};

// `serde(default)`: a payload written before an option existed still parses,
// with today's default filling the gap — a production database carries model
// snapshots from every era of the app.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(default)]
pub struct FitOptions {
    pub epochs: u32,
    pub lr: f64,
    pub l2: f64,
    /// features seen in fewer training titles than this are dropped
    #[serde(rename = "minCount")]
    pub min_count: u32,
    pub seed: u32,
}

impl Default for FitOptions {
    fn default() -> Self {
        FitOptions {
            epochs: 60,
            lr: 0.35,
            l2: 2e-4,
            min_count: 1,
            seed: 20260824,
        }
    }
}

/// The same generator the Node backend used, bit for bit, so anything seeded
/// (the training shuffle, the queue's probes) stays reproducible across the
/// rewrite. `Math.imul` is a wrapping 32-bit multiply; `>>>` is a u32 shift.
pub fn mulberry32(seed: u32) -> impl FnMut() -> f64 {
    let mut a = seed;
    move || {
        a = a.wrapping_add(0x6d2b_79f5);
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

fn sigmoid(z: f64) -> f64 {
    if z >= 0.0 {
        1.0 / (1.0 + (-z).exp())
    } else {
        z.exp() / (1.0 + z.exp())
    }
}

/// One training example: the featurized story and its verdict (1 = up, 0 = down).
/// `id` is whatever the caller wants held-out predictions keyed by.
pub struct Example {
    pub id: Option<i64>,
    pub features: Features,
    pub label: u8,
}

/// The serialised model, exactly the shape the Node backend stored in
/// `models.payload` — a production database written by either backend is
/// readable by the other.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Model {
    pub version: u32,
    pub names: Vec<String>,
    pub counts: Vec<u32>,
    pub weights: Vec<f64>,
    #[serde(rename = "nExamples")]
    pub n_examples: usize,
    #[serde(rename = "nPos")]
    pub n_pos: usize,
    #[serde(rename = "nNeg")]
    pub n_neg: usize,
    pub options: FitOptions,
}

pub fn fit(examples: &[Example], options: FitOptions) -> Model {
    let opt = options;

    // Support in first-seen order: the index a feature gets — and with it the
    // exact SGD update order — must not depend on hash iteration.
    let mut support: HashMap<&str, u32> = HashMap::new();
    let mut seen: Vec<&str> = Vec::new();
    for ex in examples {
        for (name, _) in ex.features.iter() {
            match support.get_mut(name) {
                Some(n) => *n += 1,
                None => {
                    support.insert(name, 1);
                    seen.push(name);
                }
            }
        }
    }

    let mut index: HashMap<String, usize> = HashMap::new();
    let mut names: Vec<String> = Vec::new();
    let mut counts: Vec<u32> = Vec::new();
    for name in seen {
        let count = support[name];
        if name != "__bias__" && count < opt.min_count {
            continue;
        }
        index.insert(name.to_string(), names.len());
        names.push(name.to_string());
        counts.push(count);
    }
    if !index.contains_key("__bias__") {
        index.insert("__bias__".to_string(), names.len());
        names.push("__bias__".to_string());
        counts.push(examples.len() as u32);
    }

    let d = names.len();
    let mut w = vec![0.0_f64; d];
    let mut g2 = vec![1e-8_f64; d];

    // Encode once: parallel arrays of indices/values per example.
    struct Row {
        idx: Vec<usize>,
        val: Vec<f64>,
        y: f64,
    }
    let rows: Vec<Row> = examples
        .iter()
        .map(|ex| {
            let mut idx = Vec::new();
            let mut val = Vec::new();
            for (name, v) in ex.features.iter() {
                if let Some(&i) = index.get(name) {
                    idx.push(i);
                    val.push(v);
                }
            }
            Row {
                idx,
                val,
                y: f64::from(ex.label),
            }
        })
        .collect();

    let n_pos = rows.iter().filter(|r| r.y == 1.0).count();
    let n_neg = rows.len() - n_pos;
    // Balance the classes so a lopsided vote history doesn't collapse to "predict no".
    let w_pos = if n_pos > 0 {
        rows.len() as f64 / (2.0 * n_pos as f64)
    } else {
        1.0
    };
    let w_neg = if n_neg > 0 {
        rows.len() as f64 / (2.0 * n_neg as f64)
    } else {
        1.0
    };

    // Regularise harder when there is little data: 20 votes should not produce
    // the same swagger as 2000.
    let l2 = opt.l2 * (200.0 / (rows.len().max(1) as f64)).max(1.0);

    let mut rand = mulberry32(opt.seed);
    let mut order: Vec<usize> = (0..rows.len()).collect();

    for _epoch in 0..opt.epochs {
        for i in (1..order.len()).rev() {
            let j = (rand() * (i as f64 + 1.0)).floor() as usize;
            order.swap(i, j);
        }
        for &ri in &order {
            let r = &rows[ri];
            let mut z = 0.0;
            for k in 0..r.idx.len() {
                z += w[r.idx[k]] * r.val[k];
            }
            let err = sigmoid(z) - r.y;
            let cw = if r.y == 1.0 { w_pos } else { w_neg };
            for k in 0..r.idx.len() {
                let i = r.idx[k];
                let grad = cw * err * r.val[k] + l2 * w[i];
                g2[i] += grad * grad;
                w[i] -= (opt.lr / g2[i].sqrt()) * grad;
            }
        }
    }

    Model {
        version: 1,
        names,
        counts,
        weights: w.iter().map(|x| (x * 1e6).round() / 1e6).collect(),
        n_examples: rows.len(),
        n_pos,
        n_neg,
        options: opt,
    }
}

/// A model with its name→index lookup attached, ready to score with.
pub struct Runtime {
    pub model: Model,
    pub index: HashMap<String, usize>,
}

pub fn to_runtime(model: Model) -> Runtime {
    let index = model
        .names
        .iter()
        .enumerate()
        .map(|(i, n)| (n.clone(), i))
        .collect();
    Runtime { model, index }
}

#[derive(Debug, Clone, Serialize)]
pub struct Contribution {
    pub name: String,
    pub kind: String,
    pub label: String,
    pub effect: f64,
    pub support: u32,
}

#[derive(Debug, Clone)]
pub struct Score {
    pub score: f64,
    pub raw: f64,
    pub logit: f64,
    pub confidence: f64,
    pub coverage: f64,
    pub contributions: Vec<Contribution>,
}

pub fn score_features(rt: &Runtime, features: &Features, explain: bool) -> Score {
    let weights = &rt.model.weights;
    let mut z = 0.0;
    let mut known_mass = 0.0;
    let mut total_mass = 0.0;
    let mut contributions = Vec::new();

    for (name, v) in features.iter() {
        if name == "__bias__" {
            if let Some(&i) = rt.index.get(name) {
                z += weights[i] * v;
            }
            continue;
        }
        // Coverage measures recognised *content* (words, sites, authors). Style
        // features like "is a question" match every title and would inflate it.
        let is_content = !name.starts_with("t:");
        if is_content {
            total_mass += v.abs();
        }
        let Some(&i) = rt.index.get(name) else {
            continue;
        };
        if is_content {
            known_mass += v.abs();
        }
        let c = weights[i] * v;
        z += c;
        if explain && c != 0.0 {
            let FeatureDesc { kind, label } = describe_feature(name);
            contributions.push(Contribution {
                name: name.to_string(),
                kind,
                label,
                effect: c,
                support: rt.model.counts[i],
            });
        }
    }

    let coverage = if total_mass > 0.0 {
        known_mass / total_mass
    } else {
        0.0
    };
    // Confidence blends "how much of this title the model has seen before" with
    // "how many votes exist at all" — a 5-vote model should never sound certain.
    let volume = (rt.model.n_examples as f64 / 40.0).min(1.0);
    let balance = (rt.model.n_pos.min(rt.model.n_neg) as f64 / 8.0).min(1.0);
    let confidence = (volume * balance * (0.3 + 0.7 * coverage)).clamp(0.0, 1.0);

    if explain {
        contributions.sort_by(|a, b| b.effect.abs().partial_cmp(&a.effect.abs()).unwrap());
    }

    // Logistic regression is happily overconfident on a handful of votes, so the
    // number the app shows is pulled back towards "no idea" by how much evidence
    // actually backs it. Ranking is preserved; the bragging is not.
    let raw = sigmoid(z);
    let score = 0.5 + (raw - 0.5) * (0.3 + 0.7 * confidence);

    Score {
        score,
        raw,
        logit: z,
        confidence,
        coverage,
        contributions,
    }
}

pub fn score_story(rt: &Runtime, story: StoryText<'_>, explain: bool) -> Score {
    score_features(rt, &featurize(story), explain)
}

/* ------------------------------------------------------------------ metrics */

pub fn auc(labels: &[u8], scores: &[f64]) -> Option<f64> {
    let mut pairs: Vec<(u8, f64)> = labels.iter().copied().zip(scores.iter().copied()).collect();
    pairs.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
    let mut rank_sum = 0.0;
    let mut i = 0;
    while i < pairs.len() {
        let mut j = i;
        while j + 1 < pairs.len() && pairs[j + 1].1 == pairs[i].1 {
            j += 1;
        }
        let avg_rank = (i + j) as f64 / 2.0 + 1.0; // average rank for ties
        for pair in &pairs[i..=j] {
            if pair.0 == 1 {
                rank_sum += avg_rank;
            }
        }
        i = j + 1;
    }
    let n_pos = labels.iter().filter(|&&y| y == 1).count() as f64;
    let n_neg = labels.len() as f64 - n_pos;
    if n_pos == 0.0 || n_neg == 0.0 {
        return None;
    }
    Some((rank_sum - (n_pos * (n_pos + 1.0)) / 2.0) / (n_pos * n_neg))
}

/// The aggregate cross-validation metrics, exactly the JSON shape the Node
/// backend stored under `payload.metrics`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Metrics {
    pub folds: usize,
    pub n: usize,
    pub accuracy: f64,
    pub baseline: f64,
    pub auc: Option<f64>,
    #[serde(rename = "logLoss")]
    pub log_loss: f64,
    // `foldAccuracy` and `noise` arrived late in the Node backend's life, so a
    // snapshot from before them must still load; empty/zero matches what the
    // JS `?? 0` fallbacks made of their absence.
    #[serde(rename = "foldAccuracy", default)]
    pub fold_accuracy: Vec<f64>,
    /// How far a single accuracy figure can be expected to move without
    /// anything having been learned, so the app can tell a real change from a
    /// wobble. Two estimates, larger wins: what the folds actually disagree
    /// about, and the standard error on this many examples.
    #[serde(default)]
    pub noise: f64,
}

pub struct CvOutcome {
    pub metrics: Metrics,
    /// The held-out score per example, keyed by the id the caller attached.
    /// The aggregate metrics are a summary of these; the Votes view wants
    /// them one at a time, so they are returned instead of being thrown away.
    pub held_out: Vec<(i64, f64)>,
}

/// Stratified k-fold cross-validation, so the UI can report honest accuracy.
pub fn cross_validate(examples: &[Example], options: FitOptions, k: usize) -> Option<CvOutcome> {
    let pos: Vec<&Example> = examples.iter().filter(|e| e.label == 1).collect();
    let neg: Vec<&Example> = examples.iter().filter(|e| e.label == 0).collect();
    let folds = k.min(pos.len()).min(neg.len());
    if folds < 2 {
        return None;
    }

    // (example, fold), positives first — the order the Node backend used.
    let all: Vec<(&Example, usize)> = pos
        .iter()
        .enumerate()
        .map(|(i, e)| (*e, i % folds))
        .chain(neg.iter().enumerate().map(|(i, e)| (*e, i % folds)))
        .collect();

    let mut labels: Vec<u8> = Vec::new();
    let mut scores: Vec<f64> = Vec::new();
    // Accuracy per fold, kept rather than averaged away: the spread across folds
    // is the only honest measure of how much this number wobbles on its own, and
    // a round of a dozen votes moves it by about that much.
    let mut fold_accuracy: Vec<f64> = Vec::new();
    let mut held_out: Vec<(i64, f64)> = Vec::new();
    let mut log_loss = 0.0;
    for f in 0..folds {
        let train: Vec<Example> = all
            .iter()
            .filter(|(_, fold)| *fold != f)
            .map(|(e, _)| Example {
                id: e.id,
                features: e.features.clone(),
                label: e.label,
            })
            .collect();
        let test: Vec<&Example> = all
            .iter()
            .filter(|(_, fold)| *fold == f)
            .map(|(e, _)| *e)
            .collect();
        if !train.iter().any(|e| e.label == 1) || !train.iter().any(|e| e.label == 0) {
            return None;
        }
        let rt = to_runtime(fit(&train, options));
        let mut fold_correct = 0usize;
        for e in &test {
            let s = score_features(&rt, &e.features, false);
            labels.push(e.label);
            scores.push(s.score);
            if let Some(id) = e.id {
                held_out.push((id, s.score));
            }
            if u8::from(s.score >= 0.5) == e.label {
                fold_correct += 1;
            }
            let p = s.score.clamp(1e-9, 1.0 - 1e-9);
            log_loss -= f64::from(e.label) * p.ln() + (1.0 - f64::from(e.label)) * (1.0 - p).ln();
        }
        if !test.is_empty() {
            fold_accuracy.push(fold_correct as f64 / test.len() as f64);
        }
    }

    let correct = labels
        .iter()
        .zip(scores.iter())
        .filter(|(&y, &s)| u8::from(s >= 0.5) == y)
        .count();
    let majority = pos.len().max(neg.len()) as f64 / examples.len() as f64;
    let accuracy = correct as f64 / labels.len() as f64;
    Some(CvOutcome {
        metrics: Metrics {
            folds,
            n: labels.len(),
            accuracy,
            baseline: majority,
            auc: auc(&labels, &scores),
            log_loss: log_loss / labels.len() as f64,
            fold_accuracy: fold_accuracy.clone(),
            noise: spread(&fold_accuracy).max(standard_error(correct, labels.len())),
        },
        held_out,
    })
}

/// Agresti-Coull standard error: never zero, however clean the split. The plain
/// binomial form collapses to exactly zero when a small model scores 100% —
/// eight votes separated perfectly is not certainty, and a zero band would make
/// every later move look significant.
fn standard_error(correct: usize, n: usize) -> f64 {
    let adjusted = (correct as f64 + 2.0) / (n as f64 + 4.0);
    ((adjusted * (1.0 - adjusted)) / (n as f64 + 4.0)).sqrt()
}

/// Sample standard deviation, for the fold spread.
/// n-1, not n. This estimates how far a fold-sized accuracy wobbles from only
/// five draws of it, and the population form is biased low on a sample that
/// small — by 12% at k=5, all of it in the direction of calling noise real.
fn spread(values: &[f64]) -> f64 {
    if values.len() < 2 {
        return 0.0;
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    (values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (values.len() - 1) as f64).sqrt()
}

#[derive(Debug, Clone, Serialize)]
pub struct Insight {
    pub name: String,
    pub weight: f64,
    pub support: u32,
    pub kind: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Insights {
    pub likes: Vec<Insight>,
    pub dislikes: Vec<Insight>,
}

/// Strongest learned signals, for the "what it thinks you like" panel.
pub fn insights(model: &Model, limit: usize, min_support: u32) -> Insights {
    let mut rows: Vec<Insight> = model
        .names
        .iter()
        .enumerate()
        .filter(|(i, name)| {
            name.as_str() != "__bias__"
                && model.counts[*i] >= min_support
                && model.weights[*i].abs() > 1e-4
        })
        .map(|(i, name)| {
            let FeatureDesc { kind, label } = describe_feature(name);
            Insight {
                name: name.clone(),
                weight: model.weights[i],
                support: model.counts[i],
                kind,
                label,
            }
        })
        .collect();
    rows.sort_by(|a, b| b.weight.partial_cmp(&a.weight).unwrap());
    let likes = rows
        .iter()
        .take(limit)
        .filter(|r| r.weight > 0.0)
        .cloned()
        .collect();
    let dislikes = rows
        .iter()
        .rev()
        .take(limit)
        .filter(|r| r.weight < 0.0)
        .cloned()
        .collect();
    Insights { likes, dislikes }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LIKED: &[&str] = &[
        "Rust borrow checker internals",
        "Writing a compiler in Rust",
        "Rust memory safety proofs",
        "A tiny compiler for a toy language",
        "Compiler optimisation tricks",
        "Zig and Rust interop",
    ];
    const DISLIKED: &[&str] = &[
        "Apple announces the new iPhone",
        "iPhone 19 review roundup",
        "Apple Vision Pro sales slump",
        "Why Apple keeps winning",
        "The new iPhone camera explained",
        "Apple stock hits a record",
    ];

    fn ex(title: &str, label: u8) -> Example {
        Example {
            id: None,
            features: featurize(StoryText {
                title,
                ..Default::default()
            }),
            label,
        }
    }

    fn examples() -> Vec<Example> {
        LIKED
            .iter()
            .map(|t| ex(t, 1))
            .chain(DISLIKED.iter().map(|t| ex(t, 0)))
            .collect()
    }

    fn story(title: &str) -> StoryText<'_> {
        StoryText {
            title,
            ..Default::default()
        }
    }

    #[test]
    fn separates_two_clearly_different_tastes() {
        let rt = to_runtime(fit(&examples(), FitOptions::default()));
        let liked = score_story(&rt, story("Rust compiler plugins explained"), false);
        let disliked = score_story(&rt, story("Apple iPhone event recap"), false);
        assert!(liked.raw > 0.8, "expected a high score, got {}", liked.raw);
        assert!(
            disliked.raw < 0.2,
            "expected a low score, got {}",
            disliked.raw
        );
        assert!(liked.score > disliked.score);
    }

    #[test]
    fn shown_scores_are_pulled_towards_50_percent_while_evidence_is_thin() {
        let thin = to_runtime(fit(&examples(), FitOptions::default()));
        let mut many = Vec::new();
        for _ in 0..6 {
            many.extend(examples());
        }
        let thick = to_runtime(fit(&many, FitOptions::default()));
        let a = score_story(&thin, story("Rust compiler plugins explained"), false);
        let b = score_story(&thick, story("Rust compiler plugins explained"), false);
        assert!(
            a.score < a.raw,
            "a 12-vote model should not claim certainty"
        );
        assert!(b.score > a.score, "more votes, less shrinkage");
        assert!(b.score < b.raw + 1e-9);
    }

    #[test]
    fn unknown_titles_land_near_the_middle() {
        let rt = to_runtime(fit(&examples(), FitOptions::default()));
        let s = score_story(&rt, story("Beekeeping in Provence"), false);
        assert!(
            s.score > 0.35 && s.score < 0.65,
            "expected an unsure score, got {}",
            s.score
        );
        assert_eq!(s.coverage, 0.0, "no known features means no coverage");
    }

    #[test]
    fn confidence_grows_with_evidence() {
        let all = examples();
        let few: Vec<Example> = all[0..4]
            .iter()
            .chain(all[6..10].iter())
            .map(|e| Example {
                id: e.id,
                features: e.features.clone(),
                label: e.label,
            })
            .collect();
        let small = to_runtime(fit(&few, FitOptions::default()));
        let mut doubled = examples();
        doubled.extend(examples());
        let big = to_runtime(fit(&doubled, FitOptions::default()));
        assert!(
            score_story(&big, story("Rust compiler internals"), false).confidence
                > score_story(&small, story("Rust compiler internals"), false).confidence
        );
    }

    #[test]
    fn training_is_deterministic() {
        assert_eq!(
            fit(&examples(), FitOptions::default()).weights,
            fit(&examples(), FitOptions::default()).weights
        );
    }

    #[test]
    fn cross_validation_beats_the_majority_baseline_on_separable_data() {
        let m = cross_validate(&examples(), FitOptions::default(), 5)
            .unwrap()
            .metrics;
        assert!(m.accuracy > 0.8, "accuracy was {}", m.accuracy);
        assert!(m.auc.unwrap() > 0.9, "auc was {:?}", m.auc);
        assert_eq!(m.baseline, 0.5);
    }

    #[test]
    fn the_noise_band_is_the_sample_spread_not_the_population_one() {
        // Deliberately noisy labels, so the folds genuinely disagree: on separable
        // data every fold scores 1, the spread is 0 and there is nothing to measure.
        let words = [
            "rust", "apple", "compiler", "iphone", "sqlite", "crypto", "kernel", "startup",
        ];
        let liked = |w: &str| matches!(w, "rust" | "compiler" | "sqlite" | "kernel");
        let noisy: Vec<Example> = (0..40)
            .map(|i| {
                let from_words = u8::from(liked(words[i % 8]));
                let title = format!("{} {} thing number {}", words[i % 8], words[(i * 3) % 8], i);
                Example {
                    id: None,
                    features: featurize(StoryText {
                        title: &title,
                        ..Default::default()
                    }),
                    // every seventh label contradicts its words
                    label: if i % 7 == 0 {
                        1 - from_words
                    } else {
                        from_words
                    },
                }
            })
            .collect();

        let m = cross_validate(&noisy, FitOptions::default(), 5)
            .unwrap()
            .metrics;
        let mean = m.fold_accuracy.iter().sum::<f64>() / m.fold_accuracy.len() as f64;
        let ss: f64 = m.fold_accuracy.iter().map(|v| (v - mean).powi(2)).sum();
        let population = (ss / m.fold_accuracy.len() as f64).sqrt();
        let sample = (ss / (m.fold_accuracy.len() - 1) as f64).sqrt();

        assert!(
            sample > population,
            "the fixture must disagree across folds or this proves nothing"
        );
        // Five draws is a small sample and the population form is biased low, always
        // in the direction of calling a wobble significant.
        assert!(
            m.noise > population,
            "noise {} fell back to the population spread",
            m.noise
        );
        assert!(
            (m.noise - sample).abs() < 1e-12,
            "noise {} vs sample sd {}",
            m.noise,
            sample
        );
    }

    #[test]
    fn cross_validation_returns_none_when_a_class_is_too_small() {
        let few = &examples()[0..7];
        let cloned: Vec<Example> = few
            .iter()
            .map(|e| Example {
                id: e.id,
                features: e.features.clone(),
                label: e.label,
            })
            .collect();
        assert!(cross_validate(&cloned, FitOptions::default(), 5).is_none());
    }

    #[test]
    fn auc_handles_ties_and_degenerate_label_sets() {
        assert_eq!(auc(&[1, 0], &[0.9, 0.1]), Some(1.0));
        assert_eq!(auc(&[1, 0], &[0.5, 0.5]), Some(0.5));
        assert_eq!(auc(&[1, 1], &[0.9, 0.1]), None);
    }

    #[test]
    fn insights_name_the_words_that_drove_the_split() {
        let model = fit(&examples(), FitOptions::default());
        let Insights { likes, dislikes } = insights(&model, 5, 2);
        assert!(
            likes
                .iter()
                .any(|r| r.label.starts_with("rust") || r.label.starts_with("compil")),
            "{likes:?}"
        );
        assert!(
            dislikes
                .iter()
                .any(|r| r.label.contains("apple") || r.label.contains("iphone")),
            "{dislikes:?}"
        );
        assert!(likes.iter().all(|r| r.support >= 2));
    }

    #[test]
    fn class_weighting_keeps_a_lopsided_history_usable() {
        let mut lopsided: Vec<Example> = LIKED[0..2].iter().map(|t| ex(t, 1)).collect();
        lopsided.extend(DISLIKED.iter().map(|t| ex(t, 0)));
        lopsided.extend(DISLIKED.iter().map(|t| ex(&format!("{t} again"), 0)));
        let rt = to_runtime(fit(&lopsided, FitOptions::default()));
        assert!(score_story(&rt, story("Rust compiler internals"), false).raw > 0.5);
    }
}
