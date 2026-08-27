"""Tests for the pure parsing layer.

Nothing here touches the network: the API is a fixed contract and the
interesting behaviour is in what we do to the strings it returns.
"""

from __future__ import annotations

import pytest

from hn_clusters.parse import (
    extract_domain,
    extract_markers,
    extract_year_tag,
    parse_title,
    split_genre,
)


@pytest.mark.parametrize(
    ("raw", "genre", "rest"),
    [
        ("Show HN: My raytracer", "show_hn", "My raytracer"),
        ("Ask HN: How do you deploy?", "ask_hn", "How do you deploy?"),
        ("Tell HN: The site is down", "tell_hn", "The site is down"),
        ("show hn: lowercase counts", "show_hn", "lowercase counts"),
        ("Show HN - a dash instead", "show_hn", "a dash instead"),
        ("Postgres 17 released", "story", "Postgres 17 released"),
        # Not a prefix: the phrase has to lead.
        ("Why I stopped reading Ask HN", "story", "Why I stopped reading Ask HN"),
    ],
)
def test_split_genre(raw: str, genre: str, rest: str) -> None:
    assert split_genre(raw) == (genre, rest)


def test_split_genre_leaves_show_as_an_ordinary_word() -> None:
    assert split_genre("Show me the money")[0] == "story"


@pytest.mark.parametrize(
    ("raw", "is_pdf", "is_video"),
    [
        ("Attention Is All You Need [pdf]", True, False),
        ("A talk about compilers [video]", False, True),
        ("Both at once [pdf] [video]", True, True),
        ("A guide to PDF parsing", False, False),
        ("Case insensitive [PDF]", True, False),
    ],
)
def test_extract_markers(raw: str, is_pdf: bool, is_video: bool) -> None:
    pdf, video, _ = extract_markers(raw)
    assert (pdf, video) == (is_pdf, is_video)


def test_extract_markers_removes_the_marker() -> None:
    _, _, rest = extract_markers("Attention Is All You Need [pdf]")
    assert "pdf" not in rest.lower()


@pytest.mark.parametrize(
    ("raw", "year", "rest"),
    [
        ("The UNIX Time-Sharing System (1974)", 1974, "The UNIX Time-Sharing System"),
        ("A 2024 retrospective (2024)", 2024, "A 2024 retrospective"),
        ("No tag here", None, "No tag here"),
        # Only a trailing tag counts -- a parenthetical year mid-title is
        # part of what the story is about.
        ("The (2020) election in review", None, "The (2020) election in review"),
        # Out of range: not a publication year.
        ("Port allocation (8080)", None, "Port allocation (8080)"),
        ("Ancient text (1000)", None, "Ancient text (1000)"),
    ],
)
def test_extract_year_tag(raw: str, year: int | None, rest: str) -> None:
    assert extract_year_tag(raw) == (year, rest)


@pytest.mark.parametrize(
    ("url", "domain"),
    [
        ("https://www.bbc.co.uk/news/123", "bbc.co.uk"),
        ("https://github.com/foo/bar", "github.com"),
        ("http://EXAMPLE.COM/Path", "example.com"),
        ("https://example.com:8443/x", "example.com"),
        ("https://user:pw@example.com/x", "example.com"),
        # Self posts: Ask HN and text-only Show HN carry no URL at all.
        (None, ""),
        ("", ""),
        # `www.` only comes off the front, never out of the middle.
        ("https://www.www.example.com/", "www.example.com"),
        ("https://wwwx.example.com/", "wwwx.example.com"),
    ],
)
def test_extract_domain(url: str | None, domain: str) -> None:
    assert extract_domain(url) == domain


def test_parse_title_strips_prefix_marker_and_year_together() -> None:
    parsed = parse_title("Show HN: A tiny Lisp interpreter [pdf] (2011)")
    assert parsed.genre == "show_hn"
    assert parsed.clean_title == "A tiny Lisp interpreter"
    assert parsed.is_pdf is True
    assert parsed.is_video is False
    assert parsed.year_tag == 2011


def test_parse_title_finds_the_year_behind_a_marker() -> None:
    # The year tag is anchored to the end, so it is only visible once the
    # trailing `[video]` has been removed.
    parsed = parse_title("Dynamic Programming (1957) [video]")
    assert parsed.year_tag == 1957
    assert parsed.is_video is True
    assert parsed.clean_title == "Dynamic Programming"


def test_parse_title_handles_a_missing_title() -> None:
    parsed = parse_title(None)
    assert parsed.clean_title == ""
    assert parsed.genre == "story"
