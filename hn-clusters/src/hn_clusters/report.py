"""Stage 4: name the clusters and write them out.

A cluster id is not a label, so each cluster gets its distinctive vocabulary
computed with c-TF-IDF: treat a cluster's titles as one document, then score
terms by how much more they belong to *that* document than to the rest. Plain
TF-IDF over individual titles would not do -- a five-word title has no term
frequencies worth the name.

"One document" is a counting decision, not a string operation: the titles are
pooled into a single term-count vector, but n-grams are still generated one
title at a time (see `_analyzer`). Literally concatenating them first is the
easy version and it invents bigrams across the joins.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from functools import cache
from itertools import pairwise
from pathlib import Path

import numpy as np
import polars as pl

from .cluster import NOISE_LABEL, ClusterResult
from .paths import Paths

log = logging.getLogger(__name__)


@cache
def _stop_words() -> frozenset[str]:
    """sklearn's English list, imported on first use.

    Every other heavy import in this package is deferred into the function
    that needs it, so that `hn-clusters fetch` does not pay to load
    scikit-learn, UMAP and torch. This one keeps to the same rule.
    """
    from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS

    return frozenset(ENGLISH_STOP_WORDS)

TOP_TERMS = 5
TOP_TITLES = 8

#: Corpus-wide occurrences a term needs before it can name a cluster.
#: Below this it is a typo or a one-off product name.
MIN_TERM_COUNT = 3

#: Tokens start with a letter -- a bare number is a year or a version, never
#: a topic -- and may carry `+`, `#`, `.` and `-` inside, so "node.js" and
#: "self-hosted" stay whole. The last character may be `+` or `#` as well as
#: alphanumeric, which is what keeps "c++" and "f#" from being tokenised
#: away to nothing; a trailing `\b` cannot follow a symbol, so it is a
#: closing character class instead.
_TOKEN_RE = re.compile(r"\b[a-zA-Z][a-zA-Z0-9+#.\-]*[a-zA-Z0-9+#]")


@dataclass(frozen=True)
class ClusterSummary:
    """Everything the report prints about one cluster."""

    label: int
    size: int
    terms: list[str]
    titles: pl.DataFrame

    @property
    def name(self) -> str:
        """A readable stand-in for a hand-written label."""
        return ", ".join(self.terms) if self.terms else "(no distinctive terms)"


def centrality(embeddings: np.ndarray, labels: np.ndarray) -> np.ndarray:
    """Cosine similarity from each story to its own cluster's centroid.

    This, not HDBSCAN's `probabilities_`, is what ranks the titles in the
    report. Membership probability saturates -- on a real corpus most points
    come back at exactly 1.0, which is no ordering at all -- whereas distance
    to the centroid separates the titles that *are* the topic from the ones
    that merely fell inside its boundary.

    Noise rows get 0.0: they have no cluster to be central to.
    """
    scores = np.zeros(labels.shape[0], dtype=np.float32)
    for label in np.unique(labels):
        if label == NOISE_LABEL:
            continue
        members = labels == label
        centroid = embeddings[members].mean(axis=0)
        norm = np.linalg.norm(centroid)
        if norm == 0:  # antipodal members cancelling out; vanishingly unlikely
            continue
        scores[members] = embeddings[members] @ (centroid / norm)
    return scores


def attach_labels(
    frame: pl.DataFrame,
    result: ClusterResult,
    embeddings: np.ndarray,
) -> pl.DataFrame:
    """Put `cluster`, `cluster_prob` and `centrality` onto the frame.

    Joined by row position -- the embedding matrix, the label array and the
    frame are all in fetch order -- so a length mismatch is a hard error
    rather than a silent misalignment.
    """
    if not frame.height == result.labels.shape[0] == embeddings.shape[0]:
        raise ValueError(
            f"{frame.height} stories, {result.labels.shape[0]} labels, "
            f"{embeddings.shape[0]} embeddings -- these are out of step"
        )
    return frame.with_columns(
        pl.Series("cluster", result.labels, dtype=pl.Int32),
        pl.Series("cluster_prob", result.probabilities, dtype=pl.Float32),
        pl.Series("centrality", centrality(embeddings, result.labels), dtype=pl.Float32),
    )


def _analyzer(titles: list[str]) -> list[str]:
    """Unigrams and bigrams, generated *within* each title.

    This is why the vectoriser gets a list of titles rather than one
    concatenated string. Joining first and letting scikit-learn tokenise the
    result lets bigrams straddle the seam between two titles: "...about AI"
    followed by "AI is..." manufactures an "ai ai" that nobody wrote, and on
    a cluster of a few hundred AI stories it manufactures enough of them to
    reach the top five terms. Bigrams that stop at a title boundary cost
    nothing and say something true.

    Stop words come off before the bigrams are formed, which is what sklearn
    does too: it keeps "machine learning" and turns "state of the art" into
    "state art" rather than losing it.
    """
    stop_words = _stop_words()
    grams: list[str] = []
    for title in titles:
        tokens = [
            token
            for token in _TOKEN_RE.findall(title.lower())
            if token not in stop_words
        ]
        grams.extend(tokens)
        grams.extend(f"{a} {b}" for a, b in pairwise(tokens))
    return grams


def ctfidf_terms(
    labelled: pl.DataFrame,
    *,
    top_n: int = TOP_TERMS,
    min_term_count: int = MIN_TERM_COUNT,
) -> dict[int, list[str]]:
    """Top `top_n` distinctive terms per cluster, by c-TF-IDF.

    The formula is BERTopic's: term frequency within a class, times
    `log(1 + A / f)` where `A` is the average number of words per class and
    `f` the term's total frequency across all of them.

    The noise bucket takes part in the *fit* but gets no entry in the result:
    as one enormous background document it is what pushes generic HN
    vocabulary ("using", "new", "software") down for everyone else, which is
    exactly the job idf is here to do.
    """
    from sklearn.feature_extraction.text import CountVectorizer

    grouped = (
        labelled.group_by("cluster")
        .agg(pl.col("clean_title"))
        .sort("cluster")
    )
    labels: list[int] = grouped["cluster"].to_list()
    documents: list[list[str]] = grouped["clean_title"].to_list()
    if not documents:
        return {}

    # A callable analyzer bypasses `stop_words`, `lowercase`, `min_df`-by-
    # document and `ngram_range`; `_analyzer` does all four itself.
    vectorizer = CountVectorizer(analyzer=_analyzer)
    try:
        counts = vectorizer.fit_transform(documents).toarray().astype(np.float64)
    except ValueError:  # every title empty -- nothing to count
        return {label: [] for label in labels if label != NOISE_LABEL}

    words_per_class = counts.sum(axis=1, keepdims=True)
    # A class with no surviving terms would divide by zero.
    tf = np.divide(
        counts,
        words_per_class,
        out=np.zeros_like(counts),
        where=words_per_class > 0,
    )
    total_per_term = counts.sum(axis=0)
    average_words = counts.sum() / max(counts.shape[0], 1)
    idf = np.log1p(
        np.divide(
            average_words,
            total_per_term,
            out=np.zeros_like(total_per_term),
            where=total_per_term > 0,
        )
    )
    scores = tf * idf

    # Pruning is on the *corpus-wide* count, not on how many clusters a term
    # shows up in: a term that appears in exactly one cluster is the most
    # distinctive thing there is, and a document-frequency floor would throw
    # away precisely those. What needs pruning is the term seen twice in the
    # whole archive, which in a small cluster can still take a high tf.
    scores[:, total_per_term < min_term_count] = 0.0

    vocabulary = np.asarray(vectorizer.get_feature_names_out())
    terms: dict[int, list[str]] = {}
    for row, label in enumerate(labels):
        if label == NOISE_LABEL:
            continue
        ranked = np.argsort(scores[row])[::-1][:top_n]
        terms[int(label)] = [
            str(vocabulary[i]) for i in ranked if scores[row, i] > 0
        ]
    return terms


def summarise(
    labelled: pl.DataFrame,
    terms: dict[int, list[str]],
    *,
    top_titles: int = TOP_TITLES,
) -> list[ClusterSummary]:
    """One summary per real cluster, largest first.

    Ranked by `centrality` -- closeness to the cluster's centroid in the
    embedding space. That is what makes a title *representative*, which is
    what an inspection report wants; ranking by points would just list the
    cluster's greatest hits and tell you nothing about what it contains.
    """
    summaries: list[ClusterSummary] = []
    for label in sorted(set(labelled["cluster"].to_list())):
        if label == NOISE_LABEL:
            continue
        members = labelled.filter(pl.col("cluster") == label)
        head = members.sort(
            ["centrality", "points"], descending=[True, True]
        ).head(top_titles)
        summaries.append(
            ClusterSummary(
                label=int(label),
                size=members.height,
                terms=terms.get(int(label), []),
                titles=head,
            )
        )
    summaries.sort(key=lambda summary: summary.size, reverse=True)
    return summaries


def _escape(text: str) -> str:
    """Keep a title from breaking out of a markdown table cell."""
    return text.replace("|", "\\|").replace("\n", " ")


def render_report(
    labelled: pl.DataFrame,
    summaries: list[ClusterSummary],
    result: ClusterResult,
    *,
    params: dict[str, object],
) -> str:
    """The markdown written to `output/report.md` and echoed to stdout."""
    lines: list[str] = ["# HN title clusters", ""]
    lines.append(f"- stories: **{labelled.height:,}**")
    lines.append(f"- clusters: **{len(summaries)}**")
    lines.append(
        f"- noise: **{result.noise_fraction:.1%}** "
        f"({int((result.labels == NOISE_LABEL).sum()):,} stories unclustered)"
    )
    if labelled.height:
        span = labelled["created_at"]
        lines.append(
            f"- span: {span.min():%Y-%m-%d} to {span.max():%Y-%m-%d}"
        )
    settings = ", ".join(f"{key}={value}" for key, value in params.items())
    lines.append(f"- settings: {settings}")
    lines.append("")

    for summary in summaries:
        share = summary.size / labelled.height if labelled.height else 0.0
        lines.append(f"## Cluster {summary.label} — {summary.name}")
        lines.append("")
        lines.append(f"{summary.size:,} stories ({share:.1%})")
        lines.append("")
        lines.append("| centrality | points | domain | title |")
        lines.append("| ---: | ---: | --- | --- |")
        for row in summary.titles.iter_rows(named=True):
            domain = row["domain"] or "_self_"
            lines.append(
                f"| {row['centrality']:.3f} | {row['points']} | {domain} | "
                f"{_escape(row['title'])} |"
            )
        lines.append("")
    return "\n".join(lines)


def render_console(summaries: list[ClusterSummary], result: ClusterResult) -> str:
    """A terser version of the same thing, for the terminal."""
    lines = [
        f"{len(summaries)} clusters, {result.noise_fraction:.1%} noise",
        "",
    ]
    for summary in summaries:
        lines.append(f"[{summary.label:>3}] n={summary.size:<5} {summary.name}")
        for row in summary.titles.iter_rows(named=True):
            domain = row["domain"] or "self"
            lines.append(
                f"        {row['centrality']:.3f}  {row['title']}  ({domain})"
            )
        lines.append("")
    return "\n".join(lines)


def plot_clusters(
    projection: np.ndarray,
    labels: np.ndarray,
    path: Path,
) -> None:
    """Scatter the 2D projection, coloured by cluster, noise in grey."""
    import matplotlib

    matplotlib.use("Agg")  # no display in a CLI run
    import matplotlib.pyplot as plt

    figure, axes = plt.subplots(figsize=(12, 10), dpi=140)
    is_noise = labels == NOISE_LABEL
    axes.scatter(
        projection[is_noise, 0],
        projection[is_noise, 1],
        s=2,
        c="#d0d0d0",
        linewidths=0,
        label="noise",
    )
    real = labels[~is_noise]
    if real.size:
        # tab20 has 20 colours and there are usually more clusters than that;
        # cycling is fine here, neighbouring clusters are what must differ.
        colours = matplotlib.colormaps["tab20"](real % 20)
        axes.scatter(
            projection[~is_noise, 0],
            projection[~is_noise, 1],
            s=3,
            c=colours,
            linewidths=0,
        )
    axes.set_title("HN story titles, UMAP 2D, coloured by HDBSCAN cluster")
    axes.set_xticks([])
    axes.set_yticks([])
    figure.tight_layout()
    figure.savefig(path)
    plt.close(figure)
    log.info("wrote %s", path)


def write_outputs(
    labelled: pl.DataFrame,
    report: str,
    paths: Paths,
) -> None:
    """Persist the labelled dataset and the report."""
    paths.ensure()
    labelled.write_parquet(paths.clusters)
    paths.report.write_text(report)
    log.info("wrote %s and %s", paths.clusters, paths.report)
