"""Tests for the offline half of the fetch stage.

`_to_row` and `build_frame` turn API payloads into the corpus, and they are
pure functions of a dict. Nothing here contacts Algolia: the API is a fixed
contract, and what is worth testing is what we do with what it returns.
"""

from __future__ import annotations

import polars as pl

from hn_clusters.fetch import SCHEMA, _to_row, build_frame


def _hit(**overrides: object) -> dict:
    hit = {
        "objectID": "42",
        "title": "Show HN: A tiny Lisp [pdf] (2011)",
        "url": "https://www.example.com/lisp",
        "points": 120,
        "num_comments": 33,
        "created_at_i": 1_700_000_000,
    }
    hit.update(overrides)
    return hit


def test_to_row_derives_every_column() -> None:
    row = _to_row(_hit())
    assert row is not None
    assert row["id"] == 42
    assert row["domain"] == "example.com"
    assert row["genre"] == "show_hn"
    assert row["clean_title"] == "A tiny Lisp"
    assert row["is_pdf"] is True
    assert row["year_tag"] == 2011
    # The raw title is kept alongside, so the report can show what was posted.
    assert row["title"] == "Show HN: A tiny Lisp [pdf] (2011)"


def test_to_row_keeps_a_self_post() -> None:
    """Ask HN has no URL; it still has to be embedded and clustered."""
    row = _to_row(_hit(title="Ask HN: How do you deploy?", url=None))
    assert row is not None
    assert row["domain"] == ""
    assert row["genre"] == "ask_hn"
    assert row["clean_title"] == "How do you deploy?"


def test_to_row_drops_a_hit_with_nothing_to_embed() -> None:
    # A title that is only a prefix and a marker leaves no text behind.
    assert _to_row(_hit(title="Show HN: [video]")) is None
    assert _to_row(_hit(title=None)) is None
    assert _to_row(_hit(objectID=None)) is None
    assert _to_row(_hit(created_at_i=None)) is None


def test_to_row_tolerates_missing_counts() -> None:
    row = _to_row(_hit(points=None, num_comments=None))
    assert row is not None
    assert (row["points"], row["num_comments"]) == (0, 0)


def test_build_frame_dedupes_and_sorts_newest_first() -> None:
    hits = [
        _hit(objectID="1", created_at_i=100),
        _hit(objectID="2", created_at_i=300),
        # Overlapping windows can hand the same story back twice.
        _hit(objectID="1", created_at_i=100),
        _hit(objectID="3", created_at_i=200),
    ]
    frame = build_frame(hits)
    assert frame["id"].to_list() == [2, 3, 1]


def test_build_frame_matches_the_declared_schema() -> None:
    frame = build_frame([_hit()])
    assert frame.columns == list(SCHEMA)
    assert frame.schema == pl.Schema(SCHEMA)


def test_build_frame_of_nothing_is_still_the_right_shape() -> None:
    """An empty window must not produce a frame later stages cannot read."""
    frame = build_frame([])
    assert frame.height == 0
    assert frame.schema == pl.Schema(SCHEMA)


def test_build_frame_sets_a_utc_timestamp() -> None:
    frame = build_frame([_hit(created_at_i=1_700_000_000)])
    stamp = frame["created_at"][0]
    assert (stamp.year, stamp.month, stamp.day) == (2023, 11, 14)
    assert stamp.tzinfo is not None
