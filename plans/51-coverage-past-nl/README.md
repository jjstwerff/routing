<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# 51 — Coverage past the Netherlands: C3 Benelux+1, then Western Europe

**Issue:** [`jjstwerff/routing#51`](https://github.com/jjstwerff/routing/issues/51) ·
**Value:** `F` · **Effort:** `VH`

## Status

**C2 is live and stable** — the Netherlands routes and searches offline on GitHub Pages, and has since
2026-08-01. **Nothing above it has been entered.** `PLAN-SCALE.md` §6b's ladder defines C3 (Benelux +
one big neighbour), C4 (WE roads) and C5 (WE base map as coverage) with entry gates; this plan owns that
open tail. The ladder itself stays in `PLAN-SCALE` — it is the record of what each rung *proved*, which
is reference, not intent.

**The ceiling is PUBLISHING, not the read path**, and that has been measured rather than assumed
(`PLAN-SCALE` D2, §6e): a viewport costs 75–190 kB against an 88 GB base store exactly as it does
against a 1 GB one, because `store_load_key` pages. What does not scale is hosting — GitHub Pages is
~1 GB per site — and the *generator*, which accumulates a whole store in memory (~350 bytes/feature, so
a WE-sized one is 130–270 GB). §6e's answer to the generator is structural and already chosen: never
build one that big, one region per run.

⚠ **The ceiling moved on 2026-08-03 — and phase A has now RE-COSTED it against real blocks.** loft#729/
#730 took the four region roads blocks from 478.6 MB to **255.5 MB while carrying more data**. Benelux
measured (not modelled) at **0.45 GB roads + 4.0 GB base**, against §6b's pre-halving estimate of ~1.5 +
~9 GB for C3 — the roads half came in far cheaper. `PLAN-SCALE` §6b's C3 row is stale; the table below
supersedes it.

## Goal

A cold visitor routes across a border — Netherlands into Belgium or Germany — on one dataset, with the
seam invisible and the working set bounded.

## Anchors

| what | where |
|---|---|
| the ladder, its rungs and their entry gates | `PLAN-SCALE.md` §6b |
| what the NL rung cost, and the four defects it found | `PLAN-SCALE.md` §6c, §6f F3 |
| why hosting binds before the read path | `PLAN-SCALE.md` D2, §6e |
| the cut, both rules, and its conservation checks | `tools/cut-regions.sh`, `plans/README.md` |
| the whole refresh sequence | `tools/refresh-region.sh` |

## Data cost

**This plan is almost entirely data cost** — that is what distinguishes it from every other plan here.
No schema change is expected: a second country is more blocks of the *same* format, and the pipeline
that makes them ran end to end on 2026-08-03. What changes is scale.

| rung | blocks | roads + base | binds on |
|---|---|---|---|
| **C2** (today) | 6 | 0.26 + 2.75 GB | — |
| **C3** Benelux + 1 | ~6 + ~12 | ~1.5 + ~9 GB *(stale — pre-halving)* | one Pages site per base block; a cross-border route |
| **C4** WE roads | ~10–16 | 7–15 GB | the 62-block index cap (below) |
| **C5** WE base map | +25–45 | 44–88 GB | genuinely a cost decision, not a formality |

Three known constraints, each already written down and none yet load-bearing:

1. **An index is capped at 62 blocks** (`tools/block_overlap.loft` masks cell owners per block). §6e puts
   WE at 34–68. The cheap fix is counting shared cells per *pair* instead of masking. **Do it before it
   binds** — it is a one-commit change now and a debugging session later.
2. **Geofabrik extracts overlap deliberately.** Blocks cut from one extract are disjoint by
   construction; blocks from per-country extracts are not, and `block_overlap_gate.sh` is the check that
   says which kind you have — *before* a continent is generated on the wrong one.
3. **Each base block needs its own host — and "free CORS host" was too strong.** GitHub Pages sends
   `access-control-allow-origin: *` with a real 206, so a second Pages repo answers C3 and does not
   answer 45–90 repos at C5. ⚠ **But it is a free host only because it is the SAME ORIGIN**: Pages sends
   no `access-control-expose-headers`, and `Content-Range` is not CORS-safelisted, so a genuinely
   cross-origin reader gets `null` for the store size and draws nothing — silently. It works because
   `…/routing` and `…/routing-data-nl-*` are paths on one origin. A custom domain or a native app is a
   different origin and would need a real CORS host (`cors_host_gate` states the two headers).

## Invariant gate

The rung is not entered when the data is published; it is entered when a **route crosses the seam and
is the route the whole region gives**.

| phase | expected result | invariant | negative control |
|---|---|---|---|
| **A** | a re-costed C3 size table on today's blocks | a size model is only valid for the compaction it was measured under | — (measurement) |
| **B** | a Belgian block beside the Dutch ones | blocks in one index are **disjoint by cell** | `block_overlap_gate.sh` must **fail** on raw per-country Geofabrik extracts if they overlap — a pass there is the claim being tested, not a formality |
| **C** | a route from NL into BE is byte-identical to the same route matched against a single block covering both | a seam changes nothing | a sketch that *straddles* the cut, not one that merely nears it |
| **D** | a 500 km pan holds its memory ceiling | the working set is bounded by the viewport, not the dataset | measured with `CPU_THROTTLE=4`, medians with spread — `PLAN-PERF` §7e |

## Phases

| Phase | Effort | Verify | Status |
|---|---|---|---|
| **A** — re-cost C3 against the halved blocks. Nothing is built; this decides whether C3 is one neighbour or two. | S | a size table in this README, from `store_compact_probe` on a real second-country block | ✅ **MEASURED 2026-08-03** — see § below |
| **B** — fix the 62-block cap before it binds. | S | `block_overlap.loft` counts per pair; the gate's self-check still rejects a manufactured overlap | ✅ **DONE 2026-08-03** — owner LIST replaces the 62-bit mask. Proven at **70 blocks** (2 415 nested pairs = 70 choose 2 on identical copies), where the old code refused outright. The gate still rejects a manufactured overlap (39 shared cells), so it is not vacuous. It is also *faster*: the mask forced an O(blocks²) scan per cell — 3 844 iterations at 62 blocks — where almost every cell has ONE owner, so the check is now linear in cells rather than cells × blocks² |
| **C** — publish ONE neighbour (BE first — A's numbers decided it). **It is a TRIM, not a re-tiling**: roads trimmed to cells the live index does not own; the base map may keep overlapping, because a viewport is bounded. Belgium needs ~2 base hosts. | MH | `conservation_gate` · `block_overlap_gate` · the published index resolves | **Unblocked** — A done |
| **D** — the cross-border route. | M | a seam corpus: each route byte-identical against one-block and two-block reads | Blocked on C |
| **E** — decide C4/C5. WE roads is a scale-up of C; the WE **base map** is a genuine decision point and may end at "per-region on demand, forever". | S | a costed recommendation, or `status:declined` on the C5 half | Blocked on D |

## Open questions

1. ~~**Which neighbour first?**~~ **ANSWERED — Belgium.** 159.5 MB roads + 1202.5 MB base, so it fits
   the rung at ~2 extra base hosts, and it exercises the border trim on real shared cells.
2. ~~**Does a second country's extract cut disjointly?**~~ **ANSWERED — no, and it does not have to.**
   377 shared cells, partial in both directions. But only ROADS need disjointness (an unbounded corridor
   read); the base map is already published as an overlapping cover, because a viewport read is bounded.
   The neighbour needs its roads *trimmed*, not the continent re-tiled.
3. **Is C5 worth doing at all?** §6b already lists the honest alternatives — per-region on demand
   forever (C4 as the end state, "and it is a good one"), reduced detail, or an external map source.
   *Decided by E, and pre-committing storage before then is explicitly warned against.*


---

## Phase A, measured (2026-08-03) — Benelux built, not estimated

Belgium and Luxembourg were built for real, with today's schema. Raw block bytes (roads compact to ~0.5x
at bind; base does not):

| | roads | base | base tiles / features |
|---|---|---|---|
| Netherlands | 272 MB | 2691 MB *(4 regions)* | 186 215 / 17.3 M |
| **Belgium** | **159.5 MB** | **1202.5 MB** | 148 858 / 10.7 M |
| **Luxembourg** | **16.9 MB** | **70.6 MB** | 14 246 / 0.56 M |
| **Benelux** | **~449 MB** | **~3965 MB** | |

### Three things the measurement changed

1. **Base size does NOT track road density, so the extrapolation would have been wrong.** Belgium is 53%
   of the Netherlands by road ways but **44%** by base bytes; Luxembourg is 6% by roads and **2.6%** by
   base. The base map is buildings and landcover, and those do not scale with the road network. This is
   the reason phase A insisted on a real block rather than a model.
2. **Belgium cannot ship as ONE base block.** 1202.5 MB is over the ~1 GB Pages-per-site cap, so it needs
   cutting exactly as the Netherlands did. Luxembourg at 70.6 MB is comfortably one, or can ride with a
   Belgian region. **Benelux is ~7 base hosts** (NL 4 + BE 2 + LU 1) against the 4 live today.
3. **§6b's estimate was pessimistic on roads and close on base.** It put C3 — Benelux *plus a big
   neighbour* — at ~1.5 GB roads + ~9 GB base. Benelux alone is 0.45 GB + 4.0 GB, so the roads half came
   in far cheaper than the pre-halving model assumed.

### ⚠ The blocker phase C actually has: raw country extracts OVERLAP

`block_overlap_gate`'s question is no longer theoretical. A raw Geofabrik Belgium extract against the
four live Netherlands regions:

```
blocks 0 and 4 PARTIALLY overlap: 143 shared cells   (nl-west    vs belgium)
blocks 1 and 4 PARTIALLY overlap: 108 shared cells   (nl-midwest vs belgium)
blocks 2 and 4 PARTIALLY overlap: 111 shared cells   (nl-mideast vs belgium)
blocks 3 and 4 PARTIALLY overlap:  15 shared cells   (nl-east    vs belgium)
```

**377 shared cells, and PARTIAL — neither block is a subset.** Belgium's extent reaches lat 53.74 / lon
1.89, well inside the Netherlands, because `osmium extract` keeps whole ways and Geofabrik's country
files deliberately carry cross-border data. A corridor over the border would read those roads twice and
match a **different** route, not a slower one.

So **C3 is not "download the neighbour and add it to the index."** The blocks in one index have to be cut
from a common tiling, the way the four NL regions are — either one Benelux extract cut into regions, or
per-country extracts trimmed to disjoint bands before they are published. That is phase C's real content
and it was invisible until a second country existed.

### The rule phase C turns on — and it is not about borders

The overlap above looks like it demands one answer (cut everything from a common tiling), but the
Netherlands already ships **two**, and which is right is decided by the READ, not by the border:
roads are a disjoint **PARTITION** because a route corridor is unbounded; the base map is an overlapping
**COVER** because a viewport is bounded. **`PLAN-SCALE` D12 owns that rule** — it is stated once, there.

What it means here: **phase C is a TRIM, not a re-tiling.** A neighbour does not need one Benelux extract
cut from scratch; it needs its *roads* trimmed to cells the live index does not already own — the same
`split_block` pass `cut-regions.sh` runs internally, applied at the country edge. The 377 shared cells
above are the trim list, and the gate that found them already computes it. Its base map may keep
overlapping, as the four NL regions do today.

### Measuring a tiling without building it — `tools/tiling_probe.py`

Answering "do these overlap?" and "how many regions?" cost a full `gen-tiles` run: **25 min and 1.8 GB
RSS** for Belgium, and the input grows several times again for France or Germany. Neither question needs
a store — a feature is keyed at its FIRST VERTEX, so its cell is one `floordiv` on one coordinate, and a
block's bytes track its coordinate count. The probe streams the geojsonseq the pipeline already produces
and emits the cell set plus the counts.

**Belgium in 8.4 s against 25 min**, and validated rather than asserted:

| check | probe | real block | error |
|---|---|---|---|
| cells, 3 real blocks | — | — | within **0.25%** |
| bytes per coordinate | ~15 | ~15 | constant across all three |
| NL∩BE shared cells | 397 | 377 | +5.3%, and on the safe side |

⚠ **It answers about the TILING, not about the block.** It cannot say a route is correct or a category
survived — `conservation_gate` and `block_overlap_gate` still own those, on real blocks. It is the cheap
screen you run *before* committing an hour of CPU.

### ~~The generator's memory is upstream~~ — REFUTED 2026-08-03, and by our own gate

> ⚠ **This section said binding the store FIRST was 4.5× worse and that key order changed nothing. Both
> halves are wrong.** The measurement was correct for the binary it ran on — loft 2026.8.0 md5
> `0849e437…`, where [loft#746](https://github.com/loft-lang/loft/issues/746) broke the bind-first insert
> path — and it was a throwaway probe, so nobody could re-run it when upstream disagreed. It is now
> **`tools/bind_order_gate.sh`**, and the numbers below come from it.

Re-measured on loft 2026.8.0 md5 `276cf8f9…` (2026-08-03 19:06), binning **400 000 roads into 40 000
tiles at 10 steps per road** — `gen-tiles.loft`'s shape, inner-vector appends included, because that is
the detail the old finding turned on:

| | bind LAST | bind FIRST | |
|---|---|---|---|
| **scattered keys** | 292 MB | **85 MB** | bind-first **3.4× lower** |
| **ordered keys** (feed in tkey order) | 622 MB | **117 MB** | bind-first **5.3× lower** |

At 1.6 M roads / 160 k tiles the direction holds and the ratio narrows — 765 → 273 MB scattered (2.8×),
1633 → 458 MB ordered (3.6×). **Binding first is the cheaper order, not the more expensive one.**

**And the memory a bound store holds is RECLAIMABLE, which is the half that decides §6e.** Under a cgroup
cap with swap disabled:

| | 400 k / 40 k | 1.6 M / 160 k |
|---|---|---|
| bind FIRST, capped at half its uncapped RSS | **completes** (44 MB peak, 6.1 s vs 3.2 s) | **completes** (88 MB peak, 27.6 s vs 12.7 s) |
| bind LAST, same cap | **OOM-killed** | **OOM-killed** (kernel: `Failed with result 'oom-kill'`) |

A bound store is file-backed, so its pages can be written back and evicted; an unbound `hash` is
anonymous heap and cannot be. That is the difference between a dataset that sets a *throughput* cost and
one that sets a *memory requirement*.

Three limits, so this does not become the next stale premise:

1. **The floor is not zero and it grows.** 400 k completes at 48 MB and dies at 32; 1.6 M was only tested
   down to 96 MB. Capping costs ~2× wall at both scales — gentler than the 271 s cliff upstream saw at
   32 MB, but not free.
2. **WE remains an extrapolation.** This measured to 1.6 M features; WE is two orders of magnitude more.
   What is now *settled* is that §6e's 130–270 GB is a **bind-LAST** number, not that WE fits.
3. ⚠ **`MemoryMax` alone proves nothing on a box with swap.** The first run of the cap test had both
   orders "completing" under 96 MB, because this machine has 8 GB of swap and bind-last simply paged out.
   `MemorySwapMax=0` is what separates eviction from swapping — the gate sets it, and the two orders come
   apart the moment it does.

**A new finding the old measurement had backwards: KEY ORDER IS NOT NEUTRAL.** Feeding tiles in key order
costs *more* than scattering them — 1.4× the RSS at both scales, and at 400 k a **2.3× bigger file** (213
against 91 MB) for byte-for-byte the same logical content, verified by read-back. That is the opposite of
the intuition the old section was built on, and it is worth knowing before any generator is "improved" by
sorting its input.

**Building less at a time is now a THROUGHPUT choice, not a necessity.**
`tools/build-base-chunked.sh` already did this for the base map; `tools/build-blocks-banded.sh` (new)
does it for roads, building longitude bands whose edges come from the probe's even-**cost** histogram —
even *width* is rarely even cost. Belgium in 3 bands, against the whole-country block:

| | b0 `[2.52, 4.1)` | b1 `[4.1, 5.2)` | b2 `[5.2, 6.43]` | sum | whole country |
|---|---|---|---|---|---|
| ways | 404 583 | 693 186 | 382 982 | **1 480 751** | 1 480 755 |
| cells | 2 748 | 4 219 | 3 406 | **10 373** | 10 374 |
| bytes | 82 MB | 133 MB | 84 MB | 299 MB | 159.5 MB *(compacted)* |

✅ **Disjoint** — `block_overlap.loft`: 0 nested pairs, no partial overlap over all 10 373 cells. That
is the property routes depend on (D12).

✅ **Complete everywhere inside the requested area** — and this took a second tool to see.
`tools/cell_diff.loft` (new) compares a reference block against a set of parts on both axes: which cells
no part holds, *and* which cells every part holds but **under-fills**. A cell-set diff alone could not
have found this, because the missing ways were in a cell that was present.

Exactly two cells out of 10 374 differ, and **neither is at a band seam** (those are lon 4.1 and 5.2):

| | cell | lon | lat | vs Belgium's bbox `2.5231,49.4967,6.4253,51.5051` |
|---|---|---|---|---|
| **MISSING** | 125562201 | 5.56–5.58 | 49.46–49.48 | wholly **south** of 49.4967 — outside it. Holds **0 ways** (a barrier-only tile) |
| **SHORT** −4 ways | 127398467 | 4.76–4.78 | 51.50–51.52 | **straddles** the north bound 51.5051 |

**The mechanism, and it is not the band cut.** `osmium extract` keeps a way when *any* node falls in the
bbox, and a block keys it at its **FIRST VERTEX** — which may be outside. So a way skimming the northern
border can be anchored beyond it, and whether it survives depends on which longitude window you extract:
the band owning its first-vertex cell may not contain the one node that was inside, and the 0.15° margin
only reaches ways shorter than the margin. Both differing cells are therefore **artifacts of the country
bbox, not of the banding** — the whole-country block has them for the same accidental reason.

**Verdict: the banded build is exact where it is asked to be.** All 10 372 cells inside the bbox match the
whole-country block in cell *and* way count. What a banded build changes is which border artifacts come
along, and those are anchored outside the area by definition. `cell_diff` is now the **C2b** half of `block_overlap_gate.sh`, so a cut set is checked against its
source (named by the manifest's new `cut_from`) on every run — the live four-region NL dataset passes it
at 12 483 cells. When no reference exists — which is the whole point of banding — the sum against
`<block>.srccount` plus a `block_overlap` pass is the check.

⚠ Two traps this cost, both already in HANDOFF §2. Its outer edges are NOT seams — trimming the region's
own bounds ate the cell containing the eastern bound. And an earlier run's numbers were **contaminated**:
it did not delete its blocks first, and `store_persist_bind` over an existing file keeps the old image
while returning `true`, so band 1 reported 4 ways it had not built from a byte-identical extract.

### Two defects this phase found before producing a single size

* **The 62-block cap** (phase B) — fixed; WE is 34–68 blocks, so it would have bound at exactly this rung.
* **The paged spot check was vacuous outside Enschede.** `page_locality_probe.loft` hardcoded its
  viewport, so `build-blocks.sh` printed `asked=42 loaded=0 roads=0` for Belgium and carried on — a pass,
  for a read path that fetched nothing. It now derives the viewport from the block's own extent:
  **42/42 keys, 8 491 roads** on the same block. It would have read as a pass for every country C3 adds.
