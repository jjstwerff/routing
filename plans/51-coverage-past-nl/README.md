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

⚠ **The ceiling MOVED on 2026-08-03 and has not been re-costed.** loft#729/#730 took the four region
roads blocks from 478.6 MB to **255.5 MB while carrying more data**, and every §1 size model predates
that. The site sits at 639.8 MB of a ~950 MB budget. **C3's real cost is the first thing this plan
measures**, and every number below §6b's C3 row should be treated as stale until it does.

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
3. **Each base block needs its own CORS host.** Measured 2026-08-01: GitHub Pages sends
   `access-control-allow-origin: *` with a real 206, so a second Pages repo is a free one. That answers
   C3; it does not answer 45–90 repos at C5.

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
| **A** — re-cost C3 against the halved blocks. Nothing is built; this decides whether C3 is one neighbour or two. | S | a size table in this README, from `store_compact_probe` on a real second-country block | Open |
| **B** — fix the 62-block cap before it binds. | S | `block_overlap.loft` counts per pair; the gate's self-check still rejects a manufactured overlap | ✅ **DONE 2026-08-03** — owner LIST replaces the 62-bit mask. Proven at **70 blocks** (2 415 nested pairs = 70 choose 2 on identical copies), where the old code refused outright. The gate still rejects a manufactured overlap (39 shared cells), so it is not vacuous. It is also *faster*: the mask forced an O(blocks²) scan per cell — 3 844 iterations at 62 blocks — where almost every cell has ONE owner, so the check is now linear in cells rather than cells × blocks² |
| **C** — generate and publish ONE neighbour (BE or DE-west). | MH | `conservation_gate` · `block_overlap_gate` · the published index resolves | Blocked on A |
| **D** — the cross-border route. | M | a seam corpus: each route byte-identical against one-block and two-block reads | Blocked on C |
| **E** — decide C4/C5. WE roads is a scale-up of C; the WE **base map** is a genuine decision point and may end at "per-region on demand, forever". | S | a costed recommendation, or `status:declined` on the C5 half | Blocked on D |

## Open questions

1. **Which neighbour first — Belgium or Germany-west?** BE shares the language border and the denser
   cycle network; DE-west is the bigger test of size. *Decided by A's numbers.*
2. **Does a second country's extract cut disjointly?** Geofabrik per-country extracts include
   cross-border data on purpose. *Decided by B's gate, and it is the reason B runs before C.*
3. **Is C5 worth doing at all?** §6b already lists the honest alternatives — per-region on demand
   forever (C4 as the end state, "and it is a good one"), reduced detail, or an external map source.
   *Decided by E, and pre-committing storage before then is explicitly warned against.*
