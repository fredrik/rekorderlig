"""Stage 2: turn `clean_title` into normalised sentence embeddings.

This is the slow stage -- minutes on CPU for 20k titles -- so it is cached
hard. The cache is keyed on the model name *and* a digest of the exact list
of titles it was built from: `embeddings.npy` is positional, so reusing it
against a different fetch would line vectors up with the wrong rows and
produce clusters that look plausible and are wrong.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import TYPE_CHECKING

import numpy as np
import polars as pl

from .paths import Paths

if TYPE_CHECKING:  # keep the torch/transformers import off the CLI's fast paths
    from sentence_transformers import SentenceTransformer

log = logging.getLogger(__name__)

#: Small, fast, and strong on short-text similarity -- the right shape for
#: titles. BGE's asymmetric `query:` instruction prefix is for retrieval; we
#: are comparing titles to each other, so no prefix is prepended.
MODEL_NAME = "BAAI/bge-small-en-v1.5"

BATCH_SIZE = 256


def select_device() -> str:
    """`cuda` if there is a GPU, else Apple `mps`, else `cpu`."""
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _digest(titles: list[str], model_name: str) -> str:
    """Content hash of the exact input the vectors were computed from."""
    hasher = hashlib.sha256()
    hasher.update(model_name.encode())
    hasher.update(b"\0")
    for title in titles:
        hasher.update(title.encode())
        hasher.update(b"\0")
    return hasher.hexdigest()


def load_cached(paths: Paths, titles: list[str], model_name: str) -> np.ndarray | None:
    """The stored matrix, or `None` if it is absent or stale."""
    if not (paths.embeddings.exists() and paths.embeddings_meta.exists()):
        return None
    try:
        meta = json.loads(paths.embeddings_meta.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    if meta.get("digest") != _digest(titles, model_name):
        log.info("embedding cache is stale (titles or model changed)")
        return None
    matrix = np.load(paths.embeddings)
    if matrix.shape[0] != len(titles):
        return None
    return matrix


def embed_titles(
    frame: pl.DataFrame,
    paths: Paths,
    *,
    model_name: str = MODEL_NAME,
    batch_size: int = BATCH_SIZE,
    device: str | None = None,
    refresh: bool = False,
) -> np.ndarray:
    """Embed `clean_title`, reusing `data/embeddings.npy` when it still fits.

    Returns a `(n_titles, dim)` float32 matrix of L2-normalised vectors, in
    the row order of `frame`.
    """
    paths.ensure()
    titles: list[str] = frame["clean_title"].to_list()
    if not titles:
        raise ValueError("nothing to embed -- run the fetch stage first")

    if not refresh:
        cached = load_cached(paths, titles, model_name)
        if cached is not None:
            log.info("using cached embeddings %s", cached.shape)
            return cached

    from sentence_transformers import SentenceTransformer

    device = device or select_device()
    log.info("embedding %d titles with %s on %s", len(titles), model_name, device)
    model: SentenceTransformer = SentenceTransformer(model_name, device=device)
    matrix = model.encode(
        titles,
        batch_size=batch_size,
        # Cosine distance downstream (UMAP `metric="cosine"`, c-TF-IDF aside),
        # so normalise once here instead of at every comparison.
        normalize_embeddings=True,
        convert_to_numpy=True,
        show_progress_bar=True,
    ).astype(np.float32)

    np.save(paths.embeddings, matrix)
    paths.embeddings_meta.write_text(
        json.dumps(
            {
                "model": model_name,
                "rows": int(matrix.shape[0]),
                "dim": int(matrix.shape[1]),
                "digest": _digest(titles, model_name),
            },
            indent=2,
        )
    )
    log.info("wrote %s %s", paths.embeddings, matrix.shape)
    return matrix
