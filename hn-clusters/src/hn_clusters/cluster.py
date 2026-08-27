"""Stage 3: UMAP down, HDBSCAN across.

HDBSCAN on 384-dimensional vectors is both slow and bad -- density means
little at that dimensionality. Reducing to 5 components first is the standard
fix: enough room to keep topical structure, few enough dimensions for a
density estimate to mean something. The 2D reduction used by `--plot` is a
*separate* fit, because a projection tuned for human eyes is not the one the
clusterer should be reading.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass

import numpy as np

from .paths import Paths

log = logging.getLogger(__name__)

N_COMPONENTS = 5
N_NEIGHBORS = 15
MIN_CLUSTER_SIZE = 25
MIN_SAMPLES = 5

#: Fixed so a rerun reproduces the same clusters. UMAP warns that this costs
#: the parallelism in its optimiser; for 20k rows that is worth paying.
RANDOM_STATE = 42

NOISE_LABEL = -1


@dataclass(frozen=True)
class ClusterResult:
    """Labels and membership strengths, aligned to the input row order."""

    labels: np.ndarray
    probabilities: np.ndarray

    @property
    def n_clusters(self) -> int:
        """Clusters found, not counting the noise bucket."""
        return int((np.unique(self.labels) != NOISE_LABEL).sum())

    @property
    def noise_fraction(self) -> float:
        """Share of stories HDBSCAN refused to place in any cluster."""
        if self.labels.size == 0:
            return 0.0
        return float((self.labels == NOISE_LABEL).mean())


def reduce_dimensions(
    embeddings: np.ndarray,
    *,
    n_components: int = N_COMPONENTS,
    n_neighbors: int = N_NEIGHBORS,
    random_state: int = RANDOM_STATE,
    metric: str = "cosine",
) -> np.ndarray:
    """UMAP `embeddings` down to `n_components` dimensions."""
    import umap

    log.info(
        "UMAP %d rows: %dd -> %dd (n_neighbors=%d, metric=%s)",
        embeddings.shape[0],
        embeddings.shape[1],
        n_components,
        n_neighbors,
        metric,
    )
    reducer = umap.UMAP(
        n_components=n_components,
        n_neighbors=n_neighbors,
        metric=metric,
        random_state=random_state,
    )
    return np.asarray(reducer.fit_transform(embeddings), dtype=np.float32)


def _reduction_key(
    embeddings: np.ndarray,
    *,
    n_components: int,
    n_neighbors: int,
    metric: str,
    random_state: int,
) -> str:
    """Digest of everything that determines the projection.

    Because it covers the inputs *and* every parameter, a key match means the
    cached array is exactly what a refit would produce -- so the cache needs
    no `--refresh` flag of its own to stay honest.
    """
    hasher = hashlib.sha256()
    hasher.update(embeddings.tobytes())
    hasher.update(
        json.dumps(
            {
                "shape": list(embeddings.shape),
                "n_components": n_components,
                "n_neighbors": n_neighbors,
                "metric": metric,
                "random_state": random_state,
            },
            sort_keys=True,
        ).encode()
    )
    return hasher.hexdigest()


def reduce_cached(
    embeddings: np.ndarray,
    paths: Paths,
    *,
    n_components: int = N_COMPONENTS,
    n_neighbors: int = N_NEIGHBORS,
    random_state: int = RANDOM_STATE,
    metric: str = "cosine",
) -> np.ndarray:
    """`reduce_dimensions`, memoised on disk.

    UMAP is the slow half of the cluster stage and it does not depend on the
    HDBSCAN settings at all, so re-tuning `--min-cluster-size` should not pay
    for it twice. Caching it is what lets a rerun finish in seconds.
    """
    paths.ensure()
    key = _reduction_key(
        embeddings,
        n_components=n_components,
        n_neighbors=n_neighbors,
        metric=metric,
        random_state=random_state,
    )
    array_path = paths.reduction(n_components)
    meta_path = paths.reduction_meta(n_components)
    if array_path.exists() and meta_path.exists():
        try:
            stored = json.loads(meta_path.read_text()).get("key")
        except (OSError, json.JSONDecodeError):
            stored = None
        if stored == key:
            reduced = np.load(array_path)
            log.info("using cached %dd projection %s", n_components, reduced.shape)
            return reduced

    reduced = reduce_dimensions(
        embeddings,
        n_components=n_components,
        n_neighbors=n_neighbors,
        random_state=random_state,
        metric=metric,
    )
    np.save(array_path, reduced)
    meta_path.write_text(json.dumps({"key": key, "n_components": n_components}, indent=2))
    return reduced


def cluster_embeddings(
    reduced: np.ndarray,
    *,
    min_cluster_size: int = MIN_CLUSTER_SIZE,
    min_samples: int = MIN_SAMPLES,
) -> ClusterResult:
    """HDBSCAN over the reduced space.

    Euclidean, not cosine: UMAP has already laid the points out so that
    straight-line distance in the low-dimensional space stands in for cosine
    distance in the original one.
    """
    import hdbscan

    log.info(
        "HDBSCAN over %d rows (min_cluster_size=%d, min_samples=%d)",
        reduced.shape[0],
        min_cluster_size,
        min_samples,
    )
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=min_cluster_size,
        min_samples=min_samples,
        metric="euclidean",
        # Excess-of-mass leaves a few huge clusters on data this uneven; leaf
        # selection returns topics at a readable grain.
        cluster_selection_method="eom",
        prediction_data=False,
    )
    labels = clusterer.fit_predict(reduced)
    result = ClusterResult(
        labels=np.asarray(labels, dtype=np.int32),
        probabilities=np.asarray(clusterer.probabilities_, dtype=np.float32),
    )
    log.info(
        "found %d clusters, %.1f%% noise",
        result.n_clusters,
        100 * result.noise_fraction,
    )
    return result


def project_2d(
    embeddings: np.ndarray,
    paths: Paths,
    *,
    n_neighbors: int = N_NEIGHBORS,
    random_state: int = RANDOM_STATE,
) -> np.ndarray:
    """A second, independent UMAP to 2D, for the scatter plot only.

    Deliberately not the 5-D fit with three columns dropped: a projection
    tuned for human eyes is not the one a density estimate should be run on,
    and reusing one for the other makes the picture lie about the clustering.
    """
    return reduce_cached(
        embeddings,
        paths,
        n_components=2,
        n_neighbors=n_neighbors,
        random_state=random_state,
    )
