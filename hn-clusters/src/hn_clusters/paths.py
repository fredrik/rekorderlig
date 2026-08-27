"""Filesystem layout.

Stages do not talk to each other in memory: each one reads its inputs from
disk and writes its outputs back, so `fetch`, `embed` and `cluster` can be
run separately (and re-run cheaply). Every path a stage touches hangs off a
`Paths` instance that the CLI builds once and hands down -- there is no
module-level state anywhere in this package.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Paths:
    """Where each stage keeps its cache and its artefacts."""

    root: Path

    @property
    def data(self) -> Path:
        return self.root / "data"

    @property
    def output(self) -> Path:
        return self.root / "output"

    # -- fetch -------------------------------------------------------------
    @property
    def stories(self) -> Path:
        """Raw API rows, one per story."""
        return self.data / "stories.parquet"

    # -- embed -------------------------------------------------------------
    @property
    def embeddings(self) -> Path:
        return self.data / "embeddings.npy"

    @property
    def embeddings_meta(self) -> Path:
        """Model name + a digest of the titles the vectors were built from.

        Without it a stale `embeddings.npy` would be silently reused against a
        different set of titles, and the rows would line up by position only.
        """
        return self.data / "embeddings.meta.json"

    # -- cluster -----------------------------------------------------------
    def reduction(self, n_components: int) -> Path:
        """The UMAP projection at a given width.

        The 5-D fit the clusterer reads and the 2-D fit the plot uses are
        separate files, because they are separate fits.
        """
        return self.data / f"umap_{n_components}d.npy"

    def reduction_meta(self, n_components: int) -> Path:
        return self.data / f"umap_{n_components}d.meta.json"

    @property
    def clusters(self) -> Path:
        return self.output / "clusters.parquet"

    @property
    def report(self) -> Path:
        return self.output / "report.md"

    @property
    def plot(self) -> Path:
        return self.output / "clusters.png"

    def ensure(self) -> None:
        """Create the two directories the stages write into."""
        self.data.mkdir(parents=True, exist_ok=True)
        self.output.mkdir(parents=True, exist_ok=True)


def default_paths() -> Paths:
    """Project-relative layout: `data/` and `output/` beside the working dir."""
    return Paths(root=Path.cwd())
