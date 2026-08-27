"""Stage 1: pull story metadata off the Algolia HN Search API.

Algolia will not paginate past ~1000 hits for a query, however many match.
Volume therefore has to come from *many* queries rather than deep paging, so
this walks backwards from now in `created_at_i` windows, one request per
window, and adapts the window size as it goes:

* a window that comes back full (1000 hits) is saturated -- results were
  dropped, so it is halved and refetched rather than accepted,
* a window that comes back less than half full is cheap -- the next one
  doubles.

That matters because story density is not constant: HN today puts ~60 stories
a day over 50 points, and 2009 put far fewer, so a fixed window would either
saturate at the recent end or waste requests at the old end.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Iterator

import polars as pl
import requests

from .parse import extract_domain, parse_title
from .paths import Paths

log = logging.getLogger(__name__)

SEARCH_URL = "https://hn.algolia.com/api/v1/search"

#: Algolia's hard ceiling on hits for one query. A window returning exactly
#: this many is assumed to have been truncated.
PAGE_SIZE = 1000

#: The first HN story. Walking past it just returns empty windows forever.
HN_EPOCH = 1160418000  # 2006-10-09

INITIAL_WINDOW = 14 * 86400
MIN_WINDOW = 6 * 3600
MAX_WINDOW = 365 * 86400

#: Politeness: Algolia's unauthenticated limit is generous, but a tight loop
#: of a few dozen requests is still worth spacing out.
REQUEST_PAUSE = 0.25

MAX_ATTEMPTS = 5
BACKOFF_BASE = 1.0

MIN_POINTS = 50

#: Columns kept from the API, plus the ones derived from them.
SCHEMA: dict[str, pl.DataType] = {
    "id": pl.Int64,
    "title": pl.String,
    "url": pl.String,
    "points": pl.Int64,
    "num_comments": pl.Int64,
    "created_at": pl.Datetime(time_unit="us", time_zone="UTC"),
    "created_at_i": pl.Int64,
    "domain": pl.String,
    "genre": pl.String,
    "clean_title": pl.String,
    "is_pdf": pl.Boolean,
    "is_video": pl.Boolean,
    "year_tag": pl.Int64,
}


class FetchError(RuntimeError):
    """The API could not be reached, or kept failing past the retry budget."""


def _search_window(
    session: requests.Session,
    start: int,
    end: int,
    *,
    pause: float = REQUEST_PAUSE,
) -> list[dict]:
    """One request for `[start, end)`, with backoff on 429 and 5xx.

    Returns the raw hits. 4xx other than 429 is not retried -- a malformed
    filter will fail identically however many times it is sent.
    """
    params = {
        "tags": "story",
        "numericFilters": (
            f"points>{MIN_POINTS},created_at_i>={start},created_at_i<{end}"
        ),
        "hitsPerPage": str(PAGE_SIZE),
    }
    last_error: Exception | None = None
    for attempt in range(MAX_ATTEMPTS):
        if attempt:
            delay = BACKOFF_BASE * 2 ** (attempt - 1)
            log.warning("retrying window in %.0fs (attempt %d)", delay, attempt + 1)
            time.sleep(delay)
        try:
            response = session.get(SEARCH_URL, params=params, timeout=30)
        except requests.RequestException as exc:  # connection reset, timeout
            last_error = exc
            continue
        if response.status_code == 429 or response.status_code >= 500:
            last_error = FetchError(f"HTTP {response.status_code} from Algolia")
            continue
        if not response.ok:
            raise FetchError(
                f"HTTP {response.status_code} from Algolia: {response.text[:200]}"
            )
        time.sleep(pause)
        return response.json().get("hits", [])
    raise FetchError(f"giving up on window {start}-{end}: {last_error}")


def _walk_windows(
    session: requests.Session,
    limit: int,
    *,
    now: int,
    pause: float = REQUEST_PAUSE,
) -> Iterator[dict]:
    """Yield raw hits newest-first until `limit` distinct stories are seen."""
    end = now
    window = INITIAL_WINDOW
    seen: set[str] = set()

    while len(seen) < limit and end > HN_EPOCH:
        start = max(HN_EPOCH, end - window)
        hits = _search_window(session, start, end, pause=pause)

        if len(hits) >= PAGE_SIZE and window > MIN_WINDOW:
            # Truncated: results in this window were silently dropped. Narrow
            # and refetch the same span rather than advancing past the gap.
            window = max(MIN_WINDOW, window // 2)
            log.debug("window saturated, narrowing to %ds", window)
            continue
        if len(hits) >= PAGE_SIZE:
            log.warning(
                "window %d-%d saturated at the %ds floor; some stories skipped",
                start,
                end,
                MIN_WINDOW,
            )

        for hit in hits:
            key = hit.get("objectID")
            if key is None or key in seen:
                continue
            seen.add(key)
            yield hit
            if len(seen) >= limit:
                return

        log.info("%d/%d stories (back to epoch %d)", len(seen), limit, start)
        end = start
        if len(hits) * 2 < PAGE_SIZE:
            window = min(MAX_WINDOW, window * 2)


def _to_row(hit: dict) -> dict | None:
    """Flatten one API hit into a row, or `None` if it is unusable.

    A hit with no id or no title cannot be embedded or joined against, so it
    is dropped. A hit with no URL is a self post and is kept.
    """
    raw_id = hit.get("objectID")
    title = hit.get("title")
    created = hit.get("created_at_i")
    if raw_id is None or not title or created is None:
        return None
    parsed = parse_title(title)
    if not parsed.clean_title:
        # A title that is nothing but a genre prefix and markers has no text
        # left to embed.
        return None
    return {
        "id": int(raw_id),
        "title": title,
        "url": hit.get("url") or "",
        "points": int(hit.get("points") or 0),
        "num_comments": int(hit.get("num_comments") or 0),
        "created_at_i": int(created),
        "domain": extract_domain(hit.get("url")),
        "genre": parsed.genre,
        "clean_title": parsed.clean_title,
        "is_pdf": parsed.is_pdf,
        "is_video": parsed.is_video,
        "year_tag": parsed.year_tag,
    }


def build_frame(hits: list[dict]) -> pl.DataFrame:
    """Rows -> typed frame, deduplicated on id and sorted newest-first."""
    rows = [row for row in (_to_row(hit) for hit in hits) if row is not None]
    if not rows:
        return pl.DataFrame(schema=SCHEMA)
    frame = pl.DataFrame(rows).with_columns(
        pl.from_epoch("created_at_i", time_unit="s")
        .dt.replace_time_zone("UTC")
        .alias("created_at")
    )
    return (
        frame.unique(subset=["id"], keep="first")
        .sort("created_at_i", descending=True)
        .select(list(SCHEMA))
    )


def load_cached(paths: Paths) -> pl.DataFrame | None:
    """The stored fetch, or `None` if there is not one."""
    if not paths.stories.exists():
        return None
    return pl.read_parquet(paths.stories)


def fetch_stories(
    paths: Paths,
    *,
    limit: int = 20_000,
    refresh: bool = False,
    session: requests.Session | None = None,
    now: int | None = None,
) -> pl.DataFrame:
    """Fetch (or reuse) at least `limit` stories and write `data/stories.parquet`.

    `--limit` sizes the *fetch*, not the corpus. The parquet is the corpus,
    and every later stage reads it whole, so a cache that already holds at
    least `limit` rows is returned in full rather than sliced down -- slicing
    would leave the embeddings and the labels describing a different set of
    stories than the file they sit beside. Asking for more than the cache
    holds re-runs the walk, which is ordered and cannot resume from the
    middle; `--refresh` forces the walk regardless.
    """
    paths.ensure()
    cached = None if refresh else load_cached(paths)
    if cached is not None and cached.height >= limit:
        if cached.height > limit:
            log.info(
                "cache holds %d stories, more than the %d requested -- using all "
                "of them (pass --refresh to shrink it)",
                cached.height,
                limit,
            )
        else:
            log.info("using cached fetch (%d stories)", cached.height)
        return cached
    if cached is not None:
        log.info(
            "cache holds %d stories, %d wanted -- refetching", cached.height, limit
        )

    owned = session is None
    session = session or requests.Session()
    if owned:
        session.headers["User-Agent"] = "hn-clusters (+https://github.com)"
    try:
        started = now if now is not None else int(time.time())
        hits = list(_walk_windows(session, limit, now=started))
    finally:
        if owned:
            session.close()

    frame = build_frame(hits)
    frame.write_parquet(paths.stories)
    log.info("fetched %d stories -> %s", frame.height, paths.stories)
    return frame
