# hn-clusters

Fetch Hacker News story titles, embed them, cluster them, and print the
clusters back with names on them.

The point is inspection: what is HN actually *about*, in the aggregate, once
you stop reading it one story at a time. The output is a markdown report of
clusters — each with its distinctive vocabulary and its most representative
titles — plus the labelled dataset as parquet.

```
uv run hn-clusters run
```

On a fresh clone that fetches ~20k stories, embeds them, clusters them and
writes `output/report.md` — about two and a half minutes end to end on a CPU.
Every rerun after that takes about six seconds: fetch, embed and the UMAP
projection are all cached to disk.

## Install

Needs [uv](https://docs.astral.sh/uv/) and Python 3.12+. There is nothing to
install by hand — `uv run` builds the environment from `uv.lock` on first use.

## The pipeline

Four stages. Three are separately runnable, because nothing is passed between
them in memory: each stage reads its inputs from `data/` and writes its
outputs back.

```
uv run hn-clusters fetch [--limit N] [--refresh]
uv run hn-clusters embed [--refresh]
uv run hn-clusters cluster [--min-cluster-size N] [--min-samples N] [--plot]
uv run hn-clusters run        # all of the above, in order
```

So re-clustering an existing corpus at a different grain costs neither a
network call nor a GPU-minute:

```
uv run hn-clusters cluster --min-cluster-size 60 --plot
```

### 1. Fetch

Algolia's HN Search API, `tags=story` and `points>50`, into
`data/stories.parquet`.

Algolia will not paginate past ~1000 hits for any one query, so volume has to
come from many queries rather than deep paging. The fetcher walks backwards
from now in `created_at_i` windows and **adapts the window as it goes**: a
window that comes back full was truncated, so it is halved and refetched
rather than accepted with a hole in it; a window that comes back less than
half full doubles for the next slice. Story density is not constant — HN today
puts ~60 stories a day over 50 points and 2009 put far fewer — so a fixed
window would either saturate at the recent end or waste requests at the old
end.

Kept from the API: `id`, `title`, `url`, `points`, `num_comments`,
`created_at`. Derived: `domain`, `genre`, `clean_title`, `is_pdf`,
`is_video`, `year_tag`.

### 2. Embed

`BAAI/bge-small-en-v1.5` over `clean_title`, normalised, batch size 256, on
CUDA / MPS / CPU depending on what is there. No `query:` instruction prefix —
that prefix is for asymmetric retrieval, and this is titles compared to each
other.

Cached as `data/embeddings.npy` with a sidecar recording the model and a
digest of the exact titles it was built from. The matrix is positional, so
reusing it against a different fetch would line vectors up with the wrong
rows and produce clusters that look plausible and are wrong; the digest is
what stops that.

### 3. Cluster

UMAP to 5 components (`metric="cosine"`, `n_neighbors=15`, fixed
`random_state`), then HDBSCAN (`min_cluster_size=25`, `min_samples=5`, both on
the CLI).

The reduction is not optional. HDBSCAN on 384 dimensions is both slow and
bad — density means little up there. Five components leave enough room for
topical structure and few enough dimensions for a density estimate to mean
something.

The projection is cached too, in `data/umap_5d.npy`. It is the slow half of
this stage and it does not depend on the HDBSCAN settings at all, so
re-tuning `--min-cluster-size` should not pay for it twice: the first
`cluster --plot` takes about a minute and the next one takes six seconds. The
cache key covers the embeddings *and* every UMAP parameter, so a key match
means the stored array is exactly what a refit would produce — which is why
this cache needs no `--refresh` flag to stay honest.

Label `-1` is noise. The noise fraction is reported; on a corpus this varied
it is normally large, and that is the honest answer rather than a failure.

### 4. Label and inspect

Each cluster is named by its top c-TF-IDF terms: concatenate every title in a
cluster into one document, then score terms by how much more they belong to
*that* document than to the rest. Plain TF-IDF over individual titles would
not work — a five-word title has no term frequencies worth the name.

The noise bucket takes part in the fit but gets no entry in the output. As one
enormous background document it is what pushes generic HN vocabulary down for
everyone else, which is precisely the job idf is there to do.

Titles within a cluster are ranked by **centrality** — cosine similarity to
the cluster centroid — not by HDBSCAN's membership probability, which
saturates at exactly 1.0 for most points on a real corpus and so gives no
ordering at all. Not by points either: that would list each cluster's
greatest hits and tell you nothing about what is in it.

## Output

| Path | What |
|---|---|
| `data/stories.parquet` | the fetch cache |
| `data/embeddings.npy` | the embedding cache, plus a `.meta.json` sidecar |
| `data/umap_5d.npy` | the projection the clusterer reads, keyed by a `.meta.json` sidecar |
| `data/umap_2d.npy` | `--plot` only: the separate projection the picture uses |
| `output/clusters.parquet` | every story with its `cluster`, `cluster_prob` and `centrality` |
| `output/report.md` | the readable report — per cluster: size, top terms, top 8 titles |
| `output/clusters.png` | `--plot` only: a second, 2D UMAP fit, scattered by label |

The 2D projection used for the plot is a **separate** fit from the 5D one the
clusterer reads. A projection tuned for human eyes is not the one a density
estimate should be run on, and pretending otherwise makes the picture lie
about the clustering.

## Notes on the shape of the data

- **Genre prefixes are stripped.** `Show HN:` is shared by thousands of
  otherwise unrelated stories; left in, it pulls them together into one
  cluster that means nothing but "this is a Show HN". It goes into a `genre`
  column instead, where it can still be filtered on.
- **`[pdf]`, `[video]` and `(2011)` are stripped** for the same reason — a
  format and a repost marker, not a subject.
- **Self posts have no URL.** Ask HN and text-only Show HN get `domain = ""`
  rather than a null, so the column stays a plain non-nullable string, and
  they embed and cluster like anything else.

## Development

```
uv run ruff check .
uv run pytest
```

The tests cover the pure layer — title prefix parsing, marker and year-tag
extraction, domain extraction, the row builder, the c-TF-IDF analyzer and the
centrality calculation. Nothing in the suite touches the live API: it is a
fixed contract, and the interesting behaviour is in what happens to the
strings it returns.
