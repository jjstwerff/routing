<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# 51 — Coverage past the Netherlands: C3 Benelux+1, then Western Europe

**Kind:** plan · **Status:** current · **Last verified:** 2026-08-04 · **Owns:** issue #51 — coverage past the Netherlands: Benelux+1, then Western Europe

**Issue:** [`jjstwerff/routing#51`](https://github.com/jjstwerff/routing/issues/51) ·
**Value:** `F` · **Effort:** `VH`

## Status

**C3 is ENTERED and the Benelux is live** — a cold visitor routes across the NL/BE border on one
dataset. Phases A–D are done; **E (decide C4/C5) is the only open phase**, and it is a decision, not a
build. `PLAN-SCALE.md` §6b's ladder defines C3, C4 (WE roads) and C5 (WE base map) with entry gates;
this plan owns that open tail. **What the rung PROVED lives in `PLAN-SCALE.md` §6j** — the sizes, the
trim rule, the banded build and the seam route are reference, not intent, and a plan must not be the
last home of a durable fact.

**The ceiling is PUBLISHING, not the read path**, measured rather than assumed (`PLAN-SCALE` D2, §6e): a
viewport costs the same against an 88 GB base store as against a 1 GB one, because `store_load_key`
pages — **that independence is the property, and it still holds.** ⚠ The *number* once attached to it
(75–190 kB) was retracted by §6f: a viewport is **8.1 MB**, and a dense metro one 21.8 MB. What does not
scale is hosting — GitHub Pages is ~1 GB per site and **100 GB/month of bandwidth, which caps the app at
~1 000 sessions/month and binds at Benelux** (`docs/hosting-cost-model.md`) — and the *generator*, whose
answer is structural and already chosen: never build one that big, one region per run.

## Goal

A cold visitor routes across a border — Netherlands into Belgium or Germany — on one dataset, with the
seam invisible and the working set bounded.

## Anchors

| what | where |
|---|---|
| the ladder, its rungs and their entry gates | `PLAN-SCALE.md` §6b |
| **what the Benelux rung measured, trimmed and proved** | **`PLAN-SCALE.md` §6j** |
| what the NL rung cost, and the four defects it found | `PLAN-SCALE.md` §6c, §6f F3 |
| why roads partition and the base map covers | `PLAN-SCALE.md` D12 (§3) |
| why hosting binds before the read path | `PLAN-SCALE.md` D2, §6e · `docs/hosting-cost-model.md` |
| **what a name search costs, and the index that bounds it** | `docs/name-search-index.md` — E's third half |
| the generator's memory, and the `stat` trap | `docs/loft-feedback.md` (loft#746, #752) · `tools/bind_order_gate.sh` |
| the cut, both rules, and its conservation checks | `tools/cut-regions.sh`, `plans/README.md` |
| the whole refresh sequence | `tools/refresh-region.sh` |

## Data cost

**This plan is almost entirely data cost** — that is what distinguishes it from every other plan here.
No schema change is expected: a second country is more blocks of the *same* format, and the pipeline
that makes them ran end to end on 2026-08-03. What changes is scale.

| rung | blocks | roads + base | binds on |
|---|---|---|---|
| **C2** | 6 | 0.26 + 2.75 GB | — |
| **C3** Benelux ✅ | 6 | **0.45 + 4.0 GB** *(measured — §6j)* | ~7 base hosts; Belgium's base needs cutting in two |
| **C3+** one big neighbour | +2–4 | +~1 + ~5 GB | one Pages site per base block |
| **C4** WE roads | ~10–16 | 7–15 GB | ~~the 62-block index cap~~ — lifted (phase B, gated at 70 blocks) |
| **C5** WE base map | +25–45 | 44–88 GB | genuinely a cost decision, not a formality |

Three constraints, each now with evidence behind it:

1. ~~**An index is capped at 62 blocks**~~ — **done (phase B), gated at 70.** §6j has the numbers.
2. **Geofabrik extracts overlap deliberately** — 377 shared cells NL∩BE, partial in both directions.
   `block_overlap_gate.sh` is the check that says which kind of cut you have, *before* a continent is
   generated on the wrong one. The consequence is a **trim**, not a re-tiling (D12, §6j).
3. **Each base block needs its own host — and "free CORS host" was too strong.** GitHub Pages sends
   `access-control-allow-origin: *` with a real 206, so a second Pages repo answers C3 and does not
   answer 45–90 repos at C5. ⚠ **But it is free only because it is the SAME ORIGIN**: Pages sends no
   `access-control-expose-headers`, and `Content-Range` is not CORS-safelisted, so a genuinely
   cross-origin reader gets `null` for the store size and draws nothing — silently. It works because
   `…/routing` and `…/routing-data-nl-*` are paths on one origin. A custom domain or a native app is a
   different origin and would need a real CORS host (`cors_host_gate` states the two headers).

## Invariant gate

The rung is not entered when the data is published; it is entered when a **route crosses the seam and is
the route the whole region gives**.

| phase | expected result | invariant | negative control |
|---|---|---|---|
| **A** | a re-costed C3 size table on today's blocks | a size model is only valid for the compaction it was measured under | — (measurement) |
| **B** | a Belgian block beside the Dutch ones | blocks in one index are **disjoint by cell** | `block_overlap_gate.sh` must **fail** on raw per-country Geofabrik extracts if they overlap — a pass there is the claim being tested, not a formality |
| **C** | a route from NL into BE is byte-identical to the same route matched against a single block covering both | a seam changes nothing | a sketch that *straddles* the cut, not one that merely nears it |
| **D** | a 500 km pan holds its memory ceiling | the working set is bounded by the viewport, not the dataset | measured with `CPU_THROTTLE=4`, medians with spread — `PLAN-PERF` §7e |

## Phases

| Phase | Effort | Verify | Status |
|---|---|---|---|
| **A** — re-cost C3 against the halved blocks. Nothing is built; this decides whether C3 is one neighbour or two. | S | a size table from `store_compact_probe` on a real second-country block | ✅ **MEASURED 2026-08-03** — `PLAN-SCALE` §6j |
| **B** — fix the 62-block cap before it binds. | S | `block_overlap.loft` counts per pair; the gate's self-check still rejects a manufactured overlap | ✅ **DONE 2026-08-03** — owner list replaces the 62-bit mask, proven at 70 blocks |
| **C** — publish ONE neighbour (BE first — A's numbers decided it). | MH | `conservation_gate` · `block_overlap_gate` · the published index resolves | ✅ **DONE** — trimmed and verified 2026-08-03 (`tools/trim-borders.sh`), then **SHIPPED**: the trimmed set is the live one in `v2026-08-03d`. ⚠ The trim this plan SPECIFIED was wrong; see the closure record |
| **D** — the cross-border route. | M | a seam corpus: each route byte-identical against one-block and two-block reads | ✅ **DONE 2026-08-03** — `tools/seam_route_gate.sh`, 4 crossings, all identical. **The rung is entered.** |
| **E** — decide C4/C5. WE roads is a scale-up of C; the WE **base map** is a genuine decision point and may end at "per-region on demand, forever". | S | a costed recommendation, or `status:declined` on the C5 half | **OPEN, unblocked.** Three halves, all now costed. `PLAN-SCALE` §8b is the cadence; `docs/hosting-cost-model.md` the hosting — priced 2026-08-04: R2 over B2 from ~10k sessions/month, and the limit that actually binds is Pages' 100 GB/month (~1 000 sessions), which binds at Benelux rather than at WE. **The names store is the third** (`docs/name-search-index.md`, 2026-08-07): ⚠ its recorded ceiling was **3× too high — a harness that did not gzip**, so decide against ~17 s at WE, not ~6.5 min; a 7.2 MB word index removes it outright |

## Closure record

**Shipped.** Benelux roads as a valid partition — **6 blocks, 23 299 cells, 0 overlapping** — and a
cross-border route byte-identical to the same route against a merged single block. **Six new
instruments, all standing gates rather than probes**: `tools/tiling_probe.py` (a tiling question in
8.4 s against 25 min), `tools/build-blocks-banded.sh`, `tools/cell_diff.loft` (now the C2b half of
`block_overlap_gate`), `tools/trim-borders.sh`, `tools/merge_blocks.loft` and
`tools/seam_route_gate.sh`.

**Dropped, and why.**

* **The trim this plan specified.** *"Trim the neighbour's roads to cells the live index does not already
  own"* assumed the 377 shared cells were Dutch cells Belgium reached into. They run **both directions at
  once**, so that rule would have deleted 22 635 Belgian ways along the northern border — a hole exactly
  where a cross-border route goes. It would have passed `block_overlap_gate` and failed phase D. Replaced
  by **majority assignment** (every shared cell to whichever block holds more of it; live outranks
  staged), costing **0.32%** of ways against ~28 500 lost one-sidedly. ⚠ Not lossless and cannot be:
  `TRoad` carries no way id, so there is no key to dedupe on. **If `TRoad` ever gains one, this becomes a
  merge.** Evidence in `PLAN-SCALE` §6j.
* **A finding this plan recorded and then refuted.** It briefly held that binding the store first was
  4.5× worse and that key order changed nothing. Both halves were wrong — correct for the binary it ran
  on (loft#746), but a throwaway probe nobody could re-run when upstream disagreed. It is now
  `tools/bind_order_gate.sh` and `docs/loft-feedback.md`. **Bind FIRST is the cheaper order**, and a
  bound store's memory is reclaimable, which is what `PLAN-SCALE` §6e turns on.

**Staged, then shipped — and the transition had its own trap.** The trim changes **four PUBLISHED
Netherlands blocks**, so phase D was measured against `blocks/trim/` first, without publishing anything;
the switch was the MERGE, not the publish. It has since gone live as `v2026-08-03d` (`HANDOFF.md` §0),
and it had to go whole: **leaving Belgium staged would have left the cells the NL regions gave up owned
by NOBODY** — a hole inside the Netherlands, at the border. ⚠ **A gate pointed at a staging directory
goes green when the staging ends**: `seam_route_gate` read `blocks/trim`, and the moment that set became
the real one it SKIPped — passing, having tested nothing (`HANDOFF.md` §2).

## Open questions

1. ~~**Which neighbour first?**~~ **ANSWERED — Belgium.** 159.5 MB roads + 1202.5 MB base, so it fits the
   rung at ~2 extra base hosts, and it exercises the border trim on real shared cells.
2. ~~**Does a second country's extract cut disjointly?**~~ **ANSWERED — no, and it does not have to.**
   Only ROADS need disjointness (an unbounded corridor read); the base map is already published as an
   overlapping cover, because a viewport read is bounded (D12).
3. **Is C5 worth doing at all?** §6b lists the honest alternatives — per-region on demand forever (C4 as
   the end state, *"and it is a good one"*), reduced detail, or an external map source. *Decided by E, and
   pre-committing storage before then is explicitly warned against.*
