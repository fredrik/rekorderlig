"""Pure title/URL parsing.

Everything here is a total function of its arguments -- no network, no disk,
no config. That is deliberate: this is the part with real edge cases, so it
is the part the tests cover.

The job is to reduce a raw HN title to the text worth embedding. A title
carries three kinds of noise that would otherwise dominate the vector space:

* a genre prefix (`Show HN:`) -- shared by thousands of unrelated stories,
* content markers (`[pdf]`, `[video]`) -- a format, not a topic,
* a year tag (`(2011)`) -- HN's marker for a repost of something old.

Each is pulled out into its own column and stripped from `clean_title`, so
the clustering sees the subject and the columns stay available for filtering.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from urllib.parse import urlsplit

#: Genre prefixes HN recognises, mapped to the value stored in the `genre`
#: column. Anything without a prefix is a plain `story`.
_GENRE_PREFIXES: dict[str, str] = {
    "show hn": "show_hn",
    "ask hn": "ask_hn",
    "tell hn": "tell_hn",
}

DEFAULT_GENRE = "story"

# Hyphen last: anywhere else in a character class it would open a range.
_DASHES = "\u2013\u2014-"  # en dash, em dash, hyphen

# "Show HN: " / "Show HN - " / "Show HN " -- the separator drifts by
# submitter, so accept a colon, any of the three dashes, or nothing at all.
_GENRE_RE = re.compile(
    rf"^\s*(show|ask|tell)\s+hn\s*[:{_DASHES}]?\s+",
    re.IGNORECASE,
)

# `[pdf]` / `[video]` anywhere in the title. HN convention puts them at the
# end, but submitters occasionally wedge them mid-title.
_PDF_RE = re.compile(r"\[\s*pdf\s*\]", re.IGNORECASE)
_VIDEO_RE = re.compile(r"\[\s*video\s*\]", re.IGNORECASE)

# A trailing `(1997)`. Anchored to the end so a title *about* a year
# ("The (2020) election in review") keeps it. Bounded to plausible
# publication years so `(1000)` or a stray port number is not mistaken
# for one.
_YEAR_RE = re.compile(r"\s*\((1[5-9]\d{2}|20\d{2})\)\s*$")

_WHITESPACE_RE = re.compile(r"\s+")


@dataclass(frozen=True)
class ParsedTitle:
    """The decomposition of one raw HN title."""

    genre: str
    clean_title: str
    is_pdf: bool
    is_video: bool
    year_tag: int | None


def split_genre(title: str) -> tuple[str, str]:
    """Split a genre prefix off the front of a title.

    Returns `(genre, remainder)`. A title with no recognised prefix comes
    back as `("story", title)` unchanged.

    >>> split_genre("Show HN: My raytracer")
    ('show_hn', 'My raytracer')
    >>> split_genre("Postgres 17 released")
    ('story', 'Postgres 17 released')
    """
    match = _GENRE_RE.match(title)
    if match is None:
        return DEFAULT_GENRE, title
    key = f"{match.group(1).lower()} hn"
    return _GENRE_PREFIXES[key], title[match.end() :]


def extract_markers(title: str) -> tuple[bool, bool, str]:
    """Pull `[pdf]` / `[video]` markers out of a title.

    Returns `(is_pdf, is_video, remainder)`.
    """
    is_pdf = _PDF_RE.search(title) is not None
    is_video = _VIDEO_RE.search(title) is not None
    remainder = _VIDEO_RE.sub(" ", _PDF_RE.sub(" ", title))
    return is_pdf, is_video, remainder


def extract_year_tag(title: str) -> tuple[int | None, str]:
    """Pull a trailing `(YYYY)` repost tag out of a title.

    Returns `(year, remainder)`, with `year` `None` when there is no tag.

    >>> extract_year_tag("The UNIX Time-Sharing System (1974)")
    (1974, 'The UNIX Time-Sharing System')
    """
    match = _YEAR_RE.search(title)
    if match is None:
        return None, title
    return int(match.group(1)), title[: match.start()]


def normalise_whitespace(text: str) -> str:
    """Collapse runs of whitespace and trim -- stripping leaves holes."""
    return _WHITESPACE_RE.sub(" ", text).strip()


def parse_title(title: str | None) -> ParsedTitle:
    """Decompose a raw HN title into genre, markers, year tag and clean text.

    The order matters: the genre prefix comes off the front first, then the
    markers (which can sit anywhere), then the year tag -- which is anchored
    to the end, so it can only be seen once a trailing `[pdf]` is gone.
    """
    raw = title or ""
    genre, rest = split_genre(raw)
    is_pdf, is_video, rest = extract_markers(rest)
    # Markers leave a gap where they were; close it before the year tag is
    # matched against the end of the string.
    rest = normalise_whitespace(rest)
    year, rest = extract_year_tag(rest)
    return ParsedTitle(
        genre=genre,
        clean_title=normalise_whitespace(rest),
        is_pdf=is_pdf,
        is_video=is_video,
        year_tag=year,
    )


def extract_domain(url: str | None) -> str:
    """Host of `url`, lowercased and without a leading `www.`.

    Self posts (Ask HN, and Show HN with the text in the body) have no URL at
    all; they get the empty string rather than a null, so the column stays a
    plain non-nullable string and the rows still cluster like any other.

    >>> extract_domain("https://www.BBC.co.uk/news/123")
    'bbc.co.uk'
    >>> extract_domain(None)
    ''
    """
    if not url:
        return ""
    try:
        host = urlsplit(url).netloc
    except ValueError:
        # urlsplit raises on a malformed IPv6 literal; a bad URL is not worth
        # losing the story over.
        return ""
    # Drop credentials and port: `user:pw@example.com:8443` -> `example.com`.
    host = host.rpartition("@")[2]
    if host.startswith("["):  # IPv6 literal, keep the brackets, drop the port
        host = host.partition("]")[0] + "]"
    else:
        host = host.partition(":")[0]
    host = host.lower().removeprefix("www.")
    return host
