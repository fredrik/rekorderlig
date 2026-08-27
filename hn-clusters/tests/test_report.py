"""Tests for the pure parts of the labelling stage.

Both of these guard a real failure mode rather than restating the code: the
analyzer's title boundaries, and the centrality calculation the report ranks
on.
"""

from __future__ import annotations

import numpy as np
import polars as pl

from hn_clusters.cluster import ClusterResult
from hn_clusters.report import _analyzer, attach_labels, centrality, ctfidf_terms


def test_analyzer_emits_unigrams_and_bigrams() -> None:
    assert _analyzer(["machine learning models"]) == [
        "machine",
        "learning",
        "models",
        "machine learning",
        "learning models",
    ]


def test_analyzer_does_not_bridge_two_titles() -> None:
    """The bug this guards: bigrams straddling the join between titles.

    Concatenating "...about AI" and "AI is a bubble" into one string and
    tokenising that manufactures an "ai ai" nobody wrote -- and on a cluster
    of a few hundred AI stories, enough of them to reach the top terms.
    """
    grams = _analyzer(["Everything about AI", "AI is a bubble"])
    assert "ai ai" not in grams
    assert "ai bubble" in grams  # within one title, so it survives


def test_analyzer_drops_stop_words_before_pairing() -> None:
    # "state of the art" -> "state art": the pair is kept, the filler is not.
    grams = _analyzer(["state of the art"])
    assert "state art" in grams
    assert "the" not in grams


def test_analyzer_keeps_punctuated_technology_names() -> None:
    grams = _analyzer(["C++ and Node.js and F# and self-hosted GPT-4"])
    for token in ("c++", "node.js", "f#", "self-hosted", "gpt-4"):
        assert token in grams


def test_analyzer_drops_bare_numbers_and_single_letters() -> None:
    assert _analyzer(["A 2024 review"]) == ["review"]


def _frame(titles: list[str]) -> pl.DataFrame:
    return pl.DataFrame(
        {
            "clean_title": titles,
            "domain": ["example.com"] * len(titles),
            "points": list(range(len(titles))),
            "title": titles,
        }
    )


def test_ctfidf_finds_each_cluster_its_own_vocabulary() -> None:
    titles = ["rust borrow checker"] * 5 + ["sourdough bread baking"] * 5
    labels = np.array([0] * 5 + [1] * 5, dtype=np.int32)
    labelled = _frame(titles).with_columns(pl.Series("cluster", labels))
    terms = ctfidf_terms(labelled, top_n=3)
    assert set(terms) == {0, 1}
    assert "rust" in terms[0]
    assert "rust" not in terms[1]
    assert "sourdough" in terms[1]


def test_ctfidf_skips_the_noise_bucket() -> None:
    titles = ["rust borrow checker"] * 5 + ["assorted unrelated things"] * 5
    labels = np.array([0] * 5 + [-1] * 5, dtype=np.int32)
    labelled = _frame(titles).with_columns(pl.Series("cluster", labels))
    assert set(ctfidf_terms(labelled)) == {0}


def test_ctfidf_prunes_terms_the_corpus_barely_contains() -> None:
    # "zzz" appears once; with a floor of 3 it cannot name a cluster, even
    # though it is unique to one.
    titles = ["rust borrow checker zzz"] + ["rust borrow checker"] * 4
    labels = np.zeros(len(titles), dtype=np.int32)
    labelled = _frame(titles).with_columns(pl.Series("cluster", labels))
    assert "zzz" not in ctfidf_terms(labelled, top_n=10, min_term_count=3)[0]


def test_centrality_ranks_the_typical_member_highest() -> None:
    # Two vectors pointing the same way and one at right angles: the odd one
    # out must score lowest against the shared centroid.
    embeddings = np.array(
        [[1.0, 0.0], [1.0, 0.0], [0.0, 1.0]],
        dtype=np.float32,
    )
    labels = np.zeros(3, dtype=np.int32)
    scores = centrality(embeddings, labels)
    assert scores[0] == scores[1] > scores[2]


def test_centrality_is_zero_for_noise() -> None:
    embeddings = np.array([[1.0, 0.0], [0.0, 1.0]], dtype=np.float32)
    labels = np.array([-1, -1], dtype=np.int32)
    assert list(centrality(embeddings, labels)) == [0.0, 0.0]


def test_attach_labels_rejects_a_length_mismatch() -> None:
    """A silent misalignment here would produce clusters that look fine."""
    frame = _frame(["a", "b", "c"])
    result = ClusterResult(
        labels=np.zeros(2, dtype=np.int32),
        probabilities=np.ones(2, dtype=np.float32),
    )
    try:
        attach_labels(frame, result, np.zeros((2, 4), dtype=np.float32))
    except ValueError as exc:
        assert "out of step" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("expected a ValueError")
