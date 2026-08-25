# Categorising stories

A plan, not an implementation. The goal: mute whole topics you never want
(politics, finance) and get useful *sub*-topics inside the ones you do
(agents vs. evals vs. inference, rather than one bucket called "AI").

Everything below that reports a number was measured, not estimated. The
sample is **3,439 stories over 7 days** (2026-08-18 → 2026-08-24, `points>=3`,
8 pages/day — the same query `sync` uses). Reproduce with the scripts in the
PR description; they are throwaway, not committed.

## 1. What signal exists

| Signal | Availability | Verdict |
|---|---|---|
| **Title** | 100% | The primary signal, and thinner than it looks (§1.1) |
| **Domain** | 96.9% | A strong prior for a *small* set of sites, weak elsewhere (§1.2) |
| **Author** | 100% | Weak; some submitters have a beat. Already a `by:` feature |
| **`story_text`** | 8.1% | **Currently discarded.** Free extra text on self-posts (§1.3) |
| **points / num_comments** | 100% | No topical content. Ranking only |
| **HN's own tags** | — | **Do not exist** (§1.4) |
| **Comment text** | via `children` | Strong but unaffordable (§1.4) |
| **Your votes** | 3k-ish | Taste, *not* topic. Must stay separate (§3.4) |

### 1.1 Titles are short and Zipfian

8,305 distinct words across 3,439 titles. Only **397 words appear in 10 or
more titles**; 25.8% of all word occurrences are words seen in two titles or
fewer. An HN title is ~8 words, and a quarter of them are effectively unique.

The practical consequence is visible in the titles a keyword rule cannot
touch:

```
Rent's Rule
You Shouldn't Exist
Terra Incognita: The Economics of a Shrinking World [pdf]
Why nerds are unpopular (2003)
```

HN titles are frequently allusive on purpose. No lexicon reaches these.

### 1.2 Domains are a long tail with an ambiguous head

1,694 distinct domains for 3,439 stories. Coverage by rank:

| top N domains | share of stories |
|---:|---:|
| 10 | 20.6% |
| 50 | 36.3% |
| 200 | 50.2% |
| 500 | 62.1% |

**1,384 domains appear exactly once**, and those singletons are 40.2% of all
stories. Worse, the head is not topical: the largest domain is `github.com`
(238, 6.9%), which is a container, not a subject — an AI runtime, a game and
a CLI tool all live there. `nytimes.com`, `youtube.com`, `reddit.com` and
`medium.com` are the same problem.

A *minority* of domains are genuinely pure-play and worth a hard prior:
`arxiv.org` (41), `lwn.net`, `phoronix.com`, `bleepingcomputer.com`,
`tomshardware.com`, `politico.com`. Treat domain as a **prior, never a
verdict**.

### 1.3 `story_text` is free and thrown away

`normalize()` in `src/hn.js` drops `hit.story_text`. It is present on 280 of
3,439 stories (8.1%) — Ask HN bodies and link-dump self-posts. It is the only
place we get more than 8 words of text for free. Small, but it lands
disproportionately on exactly the posts a title cannot classify (`Ask HN:
How do you access archive.today?`).

### 1.4 What we cannot have

**HN has no topic taxonomy.** Confirmed against the live API: `_tags` on a
story is only `["story", "author_x", "story_49433292", "front_page"]`. There
is nothing to import; every category we get, we compute.

**Comments are too expensive.** `children` gives comment ids, and comment
text would be a much richer topical signal than a title. At ~70k stories and
one request per story, this is not affordable and never will be.

## 2. What does not work (tested, rejected)

### 2.1 A keyword lexicon alone — leaves 60% blank

A 14-category lexicon, ~300 terms plus 21 domain priors, run over the sample:

| outcome | share |
|---|---:|
| **no category matched** | **60.6%** |
| exactly one matched | 31.9% |
| two or more matched | 7.5% |

Six in ten stories come out blank. Adding terms shrinks that slowly and
never closes it, because §1.1 is the reason, not vocabulary gaps.

The 7.5% that matched *several* categories matters too. The most frequent
collisions were `finance + politics` (27), `ai/llm + ai/ml` (24),
`ai/llm + finance` (15). Single-label argmax would be throwing away a true
answer: "Delta Uses AI to Cut Costs, CEO Says Profits Could Rise 50%" is
genuinely business *and* AI.

**Conclusion: keep the lexicon, demote it to a seed layer.**

### 2.2 Unsupervised clustering — titles are too sparse

Tested PPMI co-occurrence over the sample (title tokens + domain, df≥4,
1,392-term vocabulary, 20,530 pairs). Frequent terms produce clean
neighbourhoods:

```
trump  -> administration, donald, visas, canada, iran, threatens, war
claude -> code, anthropic, codex, opus, token, limit, skill
```

Everything mid-frequency collapses into HN boilerplate:

```
kubernetes -> @github.com, show, hn
compiler   -> @github.com, show, hn
browser    -> play, show, air, hn, search, @github.com
```

Documents are 8 words long, so co-occurrence counts stay tiny for anything
outside the top few hundred terms. A year of stories helps, but does not
change the shape — and unsupervised clusters would not line up with the
categories *you* want to mute anyway. **Rejected.**

### 2.3 LLM labelling — the quality ceiling, and off-ethos

An LLM would classify all of this well, including §1.1's allusive titles.
It also breaks three things the project states plainly: no cloud, no
dependencies, and deterministic (same votes → same weights).

Not dismissed outright — see §6 — but it cannot be the mechanism that a
`sync` depends on.

## 3. Recommended architecture

**Seeded weak supervision.** Hand-write a small taxonomy of seed terms, use
it only to *label* a training set, and train the repo's existing logistic
regression to generalise past it. Four layers, each independently testable.

```
taxonomy.js  seeds + domain priors, hand-edited        (L0)
    ↓  deterministic rules
seed labels  ~40% of the corpus, high precision        (L1)
    ↓  fit() from model.js, one binary model / category
classifiers  full-corpus coverage, multi-label         (L2)
    ↓  threshold, store above-threshold rows
story_categories                                       (L3)
    ↑  your corrections outrank seeds on the next train (L4)
```

### 3.1 Why this fits

`src/model.js` already does everything L2 needs — sparse named features, L2
regularisation, class balancing, deterministic AdaGrad, cross-validation. A
category classifier is the same `fit()` over the same `featurize()` output
with a different label. No new algorithm, no new dependency.

### 3.2 It works — measured

Seeding from ~25 terms per category and training on the repo's own `fit()`,
here is what each classifier ranks highest **among stories no seed term
matched**:

*software* — `PostgreSQL 19: What's New in Monitoring` · `Mojo is now open
source` · `Bun 1.4 Released` · `Emacs arbitrary code execution on file open`

*politics* — `New U.S. tariffs in effect after trade talks fail` ·
`Felony charges for citizen deleting phone data at US Border`

*science* — `Cancer-related mortality among US pilots and flight attendants`
· `Human brain organoids record the passage of time over multiple years`

*ai* — `Caveman prompting saves tokens, until you run it in real sessions` ·
`Adding Error Bars to Evals: A Statistical Approach to LM Evaluations` ·
`Run 290B+ frontier MoE models locally on your gaming PC`

None of those contain a seed term. This is the 60% from §2.1 being
recovered, which is the whole argument for the layer.

### 3.3 Negatives must be sampled from the whole corpus

This is the one setup detail that decides whether it works.

First attempt drew negatives only from *other categories' seed matches*. The
AI classifier promptly learned that `Show HN` and `Ask HN` mean AI — because
AI stories skew Show HN, and the negative pool had none. It scored `Ask HN:
How do you access archive.today?` at 0.88 and `Terminal-code: VS Code inside
the terminal` at 0.88.

Re-running with negatives drawn as a **random sample of the whole corpus**
(3× the positives) produced the clean §3.2 list, and pushed
`Delta Use AI to Cut Costs` and `20× the CI traffic... at Datadog` to 0.00.
Sample negatives from everything, including unlabelled stories. Positives
are precise; negatives must be representative.

### 3.4 Category and taste stay separate

Do not add category labels as features in `features.js`, and do not train
the taste model on them.

Two reasons. A derived label fed back as a feature makes a mislabelled story
permanently invisible with no way to argue with it — and this project's whole
position is that you can argue with the model. And you asked for something a
score cannot express: *never show me this*, not *rank this lower*. Muting is
a filter, ranking is a score. Keep the dimensions orthogonal:

- **taste** → `scores.score` → ordering (unchanged)
- **topic** → `story_categories` → a `WHERE` clause

### 3.5 Multi-label, not argmax

Store a probability per (story, category) above a threshold, not one winning
category. §2.1 showed the collisions are real and frequent. A story is
allowed to be both AI and finance; you mute finance and it disappears, which
is the correct outcome for a story about an AI funding round.

### 3.6 Hierarchy, flattened at write time

The taxonomy is a tree (`tech/ai/agents`), but write **one row per ancestor**
— `tech`, `tech/ai`, `tech/ai/agents` — rather than only the leaf. Muting at
any level is then a flat `NOT EXISTS` in SQL with no recursive CTE, which
keeps feed filtering in SQL where CLAUDE.md requires it. The redundancy is
~3 rows per story per label; cheap.

## 4. Schema and code

```sql
-- One row per (story, category) above threshold, plus ancestors (§3.6).
-- Absence of a row means "below threshold", so muting works without a
-- row per story per category in the taxonomy.
CREATE TABLE IF NOT EXISTS story_categories (
  story_id  INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  category  TEXT    NOT NULL,
  score     REAL    NOT NULL,
  source    TEXT    NOT NULL,   -- 'seed' | 'model' | 'user'
  model_rev INTEGER NOT NULL,
  PRIMARY KEY (story_id, category)
);
CREATE INDEX IF NOT EXISTS idx_story_categories_cat ON story_categories(category);

-- Your corrections. Hard labels: they beat seeds and are never overwritten
-- by a retrain, the way votes are never overwritten by a rescore.
CREATE TABLE IF NOT EXISTS category_labels (
  story_id   INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  category   TEXT    NOT NULL,
  value      INTEGER NOT NULL,  -- 1 = yes it is, -1 = no it isn't
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (story_id, category)
);

-- All category models under one revision, so story_categories.model_rev is
-- coherent across the taxonomy and a rescore is atomic.
CREATE TABLE IF NOT EXISTS category_models (
  rev           INTEGER PRIMARY KEY AUTOINCREMENT,
  trained_at    INTEGER NOT NULL,
  taxonomy_hash TEXT    NOT NULL,  -- retrain when the seed file changes
  payload       TEXT    NOT NULL   -- JSON: { [category]: model }
);
```

Muted categories live in `meta` as a JSON array — single user, a handful of
strings, no table needed.

| New file | Owns |
|---|---|
| `src/taxonomy.js` | the tree: seed terms + domain priors per category. Hand-edited, readable, the categorisation twin of `features.js`. Exports a stable `taxonomyHash()` |
| `src/categories.js` | seed labelling (L1), per-category `fit()` (L2), `categorize()` for one story, `recategorizeAll()` / `categorizeMissing()` |
| `src/categorizer.js` + `src/categorize-worker.js` | background retrain in a worker thread, mirroring `trainer.js` / `syncer.js` exactly |

| Touched | Change |
|---|---|
| `src/db.js` | the three tables above; `setCategoryLabel()`, `mutedCategories()` |
| `src/service.js` | `feed()` gains `categories` / `excludeCategories`, filtered **in SQL**; `sync()` calls `categorizeMissing()` alongside `scoreMissing()` |
| `src/hn.js` | keep `story_text` in `normalize()` (§1.3) — one column, one line |
| `src/server.js` | `GET/POST /api/categories`, `POST /api/categories/label` |
| `public/app.js` | mute toggles in Brain, category chips on feed rows |
| `CLAUDE.md` | per its own rule, in the same change |

**Retrain triggers.** Category models are independent of your votes, so they
must *not* retrain on the vote-debounced `POST /api/train` — that would burn
a full recategorisation on every voting burst. Retrain on: the taxonomy hash
changing, a new `category_labels` correction, or an explicit request. New
stories only get *scored* (`categorizeMissing()`), the same split
`scoreMissing()` already makes.

**Cost.** ~70k stories × ~20 categories × ~20 features is ~28M multiply-adds
per full recategorisation — a couple of seconds in a worker thread, in the
same league as the existing `rescoreAll()`. Storage at a 0.2 threshold is
well under 10 rows per story.

## 5. Fine-grained tech is the easy half

The counter-intuitive result: the sub-categories you care about are
*easier* than the coarse ones you want to mute.

Technical vocabulary is precise and proper-noun-heavy — `postgres`,
`kubernetes`, `rust`, `vllm`, `risc-v` name exactly one thing. Political and
financial vocabulary is generic and shared (`policy`, `market`, `billion`,
`ban`), which is why `finance + politics` was the top collision in §2.1.
So the seed layer is at its most precise exactly where you want resolution,
and the classifier layer earns its keep on the categories you want to
discard.

Volume is not a constraint. Seed matches per week, from seeds alone, before
the classifier widens them:

| sub-category | /week | | sub-category | /week |
|---|---:|---|---|---:|
| ai/agents | 148 | | lang/rust | 37 |
| ai/models | 116 | | lang/js | 29 |
| hardware | 71 | | infra/devops | 25 |
| infra/os | 60 | | security | 21 |
| infra/databases | 45 | | ai/training | 18 |
| ai/inference | 41 | | ai/evals | 17 |
| lang/systems | 41 | | lang/python | 10 |

The thinnest (`ai/evals`, 17/week ≈ 900/year) still has ample positives for a
binary classifier that needs a few hundred. **Sub-categories are viable at
this granularity, roughly 20 of them.**

## 6. Honest limits

**The cross-validation numbers are circular.** Per-category CV came out at
89–95% accuracy, AUC 0.95–0.99. That measures *"can the classifier reproduce
the lexicon"*, not *"is the category right"* — the labels it is scored
against are the seeds it was trained on. Do not put those numbers in the
Brain tab next to the honest CV accuracy of the taste model; they are not
the same kind of number. The only real evidence is §3.2's qualitative
generalisation, and eventually the disagreement rate against your L4
corrections — which *is* an honest metric, and the one worth showing.

**Mute degrades gracefully; "only show" does not.** A negative filter with
imperfect recall still removes most of what you don't want, and its failures
are stories you'd have seen anyway. A positive filter with the same recall
silently hides things you *do* want. Ship muting first; treat
"show me only ai/agents" as a phase-4 feature that needs the correction loop
behind it.

**Allusive titles stay unsolved.** `Rent's Rule` is an electronics paper.
Nothing in this design classifies it, and no amount of seed-term work will.
This is the residual an LLM pass would close — worth revisiting as an
**offline, opt-in enrichment** that writes into `category_labels` as
`source='llm'` seeds and is never on the `sync` path. That keeps
determinism and the zero-dependency runtime intact while letting a one-off
pass raise the ceiling.

## 7. Phasing

Each phase ships something usable on its own.

1. **Taxonomy + seeds + schema.** `taxonomy.js`, the three tables, seed
   labelling only, mute list in Brain, feed filtered in SQL. Politics and
   finance muting works on the ~40% the seeds catch — an immediate
   improvement, and §6 says a partial mute is honest.
2. **Classifier layer.** L2 with corpus-sampled negatives (§3.3), worker
   thread, `categorizeMissing()` in `sync()`. This is the phase that closes
   the 60%.
3. **Corrections.** `category_labels`, a chip on each feed row to fix a
   label, disagreement rate as the honest metric.
4. **Fine-grained tech.** Expand the taxonomy under `tech/*` to the ~20
   sub-categories in §5, positive filtering, per-category views.

Phase 1 is worth doing even if 2–4 never happen; phase 4 is only worth doing
after 3, because a 20-way taxonomy without a correction loop cannot be
tuned.

## 8. Tests

Per CLAUDE.md, a test with every behavioural change. The seams that matter:

- `taxonomy.js` — seed matching is exact and word-bounded (`ai` must not
  match `said`, `go` must not match `google`); `taxonomyHash()` is stable
  across runs and changes when a term does.
- `categories.js` — ancestors are written for a leaf label (§3.6); a
  `category_labels` correction outranks a seed; negatives are drawn from the
  whole corpus, not just other categories (§3.3 — assert the pool, it is the
  bug that will come back).
- `service.js` — `feed()` excludes a muted category in SQL and still pages
  correctly; a story with no category rows is *not* filtered out by a mute.
- `db.js` — `story_categories` cascades on story delete, like `scores`.
