"""Command line entry point.

Four subcommands. `fetch`, `embed` and `cluster` are the pipeline stages, each
runnable on its own because each reads its input from disk; `run` is the three
of them in order. Nothing is passed between them in memory, so
`hn-clusters cluster --min-cluster-size 40` re-clusters a corpus that was
fetched and embedded days ago without touching the network or the GPU.
"""

from __future__ import annotations

import argparse
import logging
import sys
from collections.abc import Sequence

import numpy as np
import polars as pl

from . import cluster as cluster_stage
from . import embed as embed_stage
from . import fetch as fetch_stage
from . import report as report_stage
from .paths import Paths, default_paths

DEFAULT_LIMIT = 20_000


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="hn-clusters",
        description="Fetch, embed and cluster Hacker News story titles.",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="debug logging, including per-window fetch detail",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    def add_fetch_flags(target: argparse.ArgumentParser) -> None:
        target.add_argument(
            "--limit",
            type=int,
            default=DEFAULT_LIMIT,
            help=(
                "how many stories to collect (default "
                "20,000). Sizes the fetch, not the corpus: a cache "
                "already holding more is used in full"
            ),
        )
        target.add_argument(
            "--refresh",
            action="store_true",
            help="ignore the cached fetch and hit the API again",
        )

    def add_cluster_flags(target: argparse.ArgumentParser) -> None:
        target.add_argument(
            "--min-cluster-size",
            type=int,
            default=cluster_stage.MIN_CLUSTER_SIZE,
            help=f"HDBSCAN min_cluster_size (default {cluster_stage.MIN_CLUSTER_SIZE})",
        )
        target.add_argument(
            "--min-samples",
            type=int,
            default=cluster_stage.MIN_SAMPLES,
            help=f"HDBSCAN min_samples (default {cluster_stage.MIN_SAMPLES})",
        )
        target.add_argument(
            "--plot",
            action="store_true",
            help="also write output/clusters.png (a second UMAP fit, to 2D)",
        )

    fetch_parser = subparsers.add_parser("fetch", help="stage 1: pull titles from HN")
    add_fetch_flags(fetch_parser)

    embed_parser = subparsers.add_parser("embed", help="stage 2: embed clean_title")
    embed_parser.add_argument(
        "--refresh",
        action="store_true",
        help="ignore the cached embeddings and recompute them",
    )

    cluster_parser = subparsers.add_parser(
        "cluster", help="stages 3-4: cluster, label and report"
    )
    add_cluster_flags(cluster_parser)

    run_parser = subparsers.add_parser("run", help="all stages, in order")
    add_fetch_flags(run_parser)
    add_cluster_flags(run_parser)

    return parser


def _require_stories(paths: Paths) -> pl.DataFrame:
    frame = fetch_stage.load_cached(paths)
    if frame is None or frame.height == 0:
        raise SystemExit(
            f"no stories at {paths.stories} -- run `hn-clusters fetch` first"
        )
    return frame


def run_fetch(paths: Paths, args: argparse.Namespace) -> pl.DataFrame:
    frame = fetch_stage.fetch_stories(
        paths, limit=args.limit, refresh=args.refresh
    )
    print(f"fetch: {frame.height:,} stories -> {paths.stories}")
    return frame


def run_embed(
    paths: Paths,
    *,
    refresh: bool,
    frame: pl.DataFrame | None = None,
) -> tuple[pl.DataFrame, np.ndarray]:
    frame = frame if frame is not None else _require_stories(paths)
    matrix = embed_stage.embed_titles(frame, paths, refresh=refresh)
    print(f"embed: {matrix.shape[0]:,} x {matrix.shape[1]} -> {paths.embeddings}")
    return frame, matrix


def run_cluster(
    paths: Paths,
    args: argparse.Namespace,
    frame: pl.DataFrame | None = None,
    matrix: np.ndarray | None = None,
) -> int:
    frame = frame if frame is not None else _require_stories(paths)
    if matrix is None:
        titles = frame["clean_title"].to_list()
        matrix = embed_stage.load_cached(paths, titles, embed_stage.MODEL_NAME)
        if matrix is None:
            raise SystemExit(
                f"no embeddings at {paths.embeddings} for this fetch -- "
                "run `hn-clusters embed` first"
            )

    reduced = cluster_stage.reduce_cached(matrix, paths)
    result = cluster_stage.cluster_embeddings(
        reduced,
        min_cluster_size=args.min_cluster_size,
        min_samples=args.min_samples,
    )
    labelled = report_stage.attach_labels(frame, result, matrix)
    terms = report_stage.ctfidf_terms(labelled)
    summaries = report_stage.summarise(labelled, terms)

    report = report_stage.render_report(
        labelled,
        summaries,
        result,
        params={
            "min_cluster_size": args.min_cluster_size,
            "min_samples": args.min_samples,
            "n_components": cluster_stage.N_COMPONENTS,
            "n_neighbors": cluster_stage.N_NEIGHBORS,
            "model": embed_stage.MODEL_NAME,
        },
    )
    report_stage.write_outputs(labelled, report, paths)

    if args.plot:
        projection = cluster_stage.project_2d(matrix, paths)
        report_stage.plot_clusters(projection, result.labels, paths.plot)

    print(report_stage.render_console(summaries, result))
    print(f"cluster: {paths.clusters} and {paths.report}")
    if args.plot:
        print(f"plot:    {paths.plot}")
    return len(summaries)


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    if not args.verbose:
        # sentence-transformers pulls in httpx and huggingface_hub, which
        # narrate every model-file HEAD request at INFO.
        for noisy in ("httpx", "urllib3", "sentence_transformers", "transformers"):
            logging.getLogger(noisy).setLevel(logging.WARNING)
    paths = default_paths()

    if args.command == "fetch":
        run_fetch(paths, args)
    elif args.command == "embed":
        run_embed(paths, refresh=args.refresh)
    elif args.command == "cluster":
        run_cluster(paths, args)
    elif args.command == "run":
        frame = run_fetch(paths, args)
        # `run --refresh` means "refetch". The embedding cache invalidates
        # itself off the titles it was built from, so a refetch that changed
        # nothing should still not pay to re-embed.
        frame, matrix = run_embed(paths, refresh=False, frame=frame)
        run_cluster(paths, args, frame, matrix)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
