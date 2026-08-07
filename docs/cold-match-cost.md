<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->

# Where a cold match's time goes — corridor, graph, search, and the route gate

**Kind:** reference · **Status:** current · **Last verified:** 2026-08-03 · **Owns:** the cold match's cost centres: the corridor read, build_graph, the anchor search, and the route-parity gate

`PLAN-PERF` §7a, §7a(2), §7b, §7h, §7i, §7j and §7p. **The remaining user-visible cost is the cold
match's frozen gap**, and it sits in the corridor read + `build_graph`, before the first stretch
exists — which is why the render-side yields cannot reach it. Also the record of what was tried and
REJECTED here (the spatial index, two anchor reductions, step 19b), so it is not re-opened without
new evidence.

⚠ **Section numbers are global to `PLAN-PERF.md`** — they were not renumbered when this file was split out, so a citation of `PLAN-PERF` §7g still resolves. Its *Where each section lives* table says which file holds which §. **`PLAN-PERF` §0 is still the step list, and §1 the invariant every step is judged against.**

---

## 7b. Steps 20 + 21 — the tube drops 66% of the ways and is NOT route-neutral (so §3's gate IS needed)

**Step 20 (`tiles_corridor_ways_tube`, inert)** keeps only tiles near the polyline, not every tile in its
bbox rectangle. The test is per-TILE, never per-way (PLAN-MATCH §1 measured a per-vertex sweep past a
2-minute budget). On three hand-picked sketches it dropped 43–60% of the ways with an **identical route**,
and I concluded it was route-neutral — a margin-faithful tube being "the same tier computed better"
rather than a cheap tier, so §3's gate might not apply to it.

**Step 21 (`tools/corpus_tube.loft`) falsified that on the fourth sketch it looked at.** 25 deterministic
sketches across the block (varying origin, direction, bend, and 3/9/15/21 points):

```
CORPUS 25 matched: identical=17  diverged=8          ← 32% diverge
WAYS  bbox=200708  tube=68529  dropped=132179 (66%)
```

**Three sketches said 0% divergence; 25 say 32%.** That is the sampling error this document warns about
in §2, made by the author of the warning, one commit after writing it. *Any corridor claim needs the
corpus, not a sample.*

**PLAN-MATCH §1 was right:** *"uniform tightening is NOT accuracy-neutral."* The §3 gate is required.

**But the divergences are not uniformly worse — which is exactly why the gate is a QUALITY gate:**

| sketch | bbox | tube | |
|---|---|---|---|
| i=3 | dev_max 1639 m, bridged 222 m | dev_max **725 m**, bridged **0 m** | tube **better** |
| i=7 | len 12489 m, dev_max 484 m | len 16548 m, dev_max 1003 m | tube **worse** |
| i=2 | len 13383, bridged 0 | len 9888, bridged 559 | different trade |

The tube is not a worse corridor; it is a **different** one — better on some sketches, worse on others.
Judging that per-segment on deviation + penalty share, and escalating when it fails, is precisely
PLAN-MATCH §3. So the ladder's shape was right and this plan's §7b guess was wrong.

**Where that leaves it:** the tube stays **inert** — which is why step 20 was specified inert, and it paid
for itself. It is a genuine ~66% way reduction (and ~2–3× on the corridor read) available the moment
step 22's gate can accept it per-segment and fall back to bbox when it cannot. `tools/corpus_tube.loft`
is the harness that tunes and then guards that gate; it prints the §7 numbers (dev_max/dev_mean/pen_m/
bridged_m/class_m) for both tiers per sketch.

---

## 7j. Attacking the SEARCH — anchoring cost more than routing (2026-07-22)

Once §7i fixed the graph build, the search became the largest slice. Same method: attribute first, with
temporary phase timing inside `build_state`.

| phase | cost (3-point sketch, 114 ms search) |
|---|---|
| **anchors (3 points)** | **60 ms — 53%** |
| `precompute_edges` | 27 ms |
| stretches (2) | 18 ms |
| `new_scratch` | 7 ms |

**Anchoring cost more than routing** — and unlike the stretches it is per POINT, so a realistic 40-point
sketch pays it forty times (this is the ~8 s freeze §6b A recorded for a dense sketch).

### The scan nobody had looked at

`nearest_nodes` is called ~3× per point. It allocated a `taken` vector **the size of the graph** (33,948
booleans) and then ran **`VITERBI_K` = 4 full selection scans over every node**. The comment above it
records that the *metric* was already optimised from Vincenty to flat-earth multiplies — *"turns ~17M
Vincenty calls into cheap multiplies"* — but **the scan itself was never touched.** One pass keeping the
best K replaces four passes plus the allocation.

**The result is IDENTICAL, not merely equivalent, and the tie-breaking is why.** The old code scanned
ascending with a strict `d < bestd`, so among equal distances the LOWEST node index won. The insertion
shifts only while `d < bd[pos-1]` — also strict — so an equal-distance node stays behind the one found
earlier. Anchors feed the Viterbi, so a different tie is a different route.

| | before | after |
|---|---|---|
| search (native) | 115 ms | **88 ms** (−23%; median of 10, 83–94, spread 1.16×) |
| cold match (native, TUBE) | 223 ms | ~205 ms |
| **warm match (browser, `CPU_THROTTLE=4`)** | 526 ms | **395 ms (−25%)** |
| cold match (browser) | 1820 ms | 1831 ms — **unchanged, within the 1.1× spread** |

**The win lands on the WARM match, and that is the point.** `update_state` recomputes only the edited
window, so a warm match is almost entirely anchor work — while a cold match is still dominated by the
corridor read and `build_graph`, where a 27 ms search saving disappears into the noise. Warm is *"the
interaction users actually perform"* (this document's own words), so an improvement that shows up only
there is the one worth having.

Routes byte-identical: all four tile-border fingerprints and all three `match_parity` lengths.

### 7k — `EdgeCosts` indexed by WAY, not by edge

`precompute_edges` was ~27 ms of the 88 ms search: five arrays of ~37.6k entries — about **188,000 vector
appends per cold match** — holding ~7.1k distinct values, because every edge of a way has identical costs.

The arrays are now one entry per WAY, indexed by `GEdge.w`. **The indirection is free where it matters:**
the hot relaxation loop already loads `e = g.edges[ei]` for `e.a`/`e.length`, so `e.w` costs nothing and
the arrays it indexes are 5× smaller — better locality, not worse. Four read sites, all with `e` already
in scope.

| | before | after |
|---|---|---|
| search (native) | 88 ms | **~66 ms** (−25%) |
| cold match (native, TUBE) | ~205 ms | **~187 ms** |
| **cold match (browser)** | 1831 ms | **1539 ms** (−16%) |
| **warm match (browser)** | 395 ms | **358 ms** (−9%) |

Routes byte-identical. Quiet box, spreads 1.0–1.1×.

⚠ **The first attempt to measure this was thrown away**, and that is the process working: the box was at
load 16 and the probe spread opened to 1.7× (match 70–121 ms). The commit landed on its correctness proof
with the timing explicitly *not* claimed, and the numbers above were taken later on a quiet box. *A
change can be committed on a gate; it cannot be characterised on a contended one.*

### 7l — the spatial index: BUILT, MEASURED, REVERTED. And it found the real bottleneck.

`nearest_nodes` was still O(nodes), so it was replaced with loft's `spatial<T[x,y]>` — an expanding-box
query plus an exact re-rank, tie-breaking by lowest node index explicitly (Morton order does not give it
for free, and anchors feed the Viterbi). **It worked: routes byte-identical on all four border corridors
and all three `match_parity` lengths.** It is still reverted, because it is a large net loss:

| 40-point sketch, native, quiet box | before | with spatial index |
|---|---|---|
| build_graph | 70 ms | **345 ms** (+275, ~5×) |
| match | 259 ms | **~260 ms** — *no change* |
| total | 350 ms | **~635 ms** (+81%) |

Two things paid for by building it, both worth more than the change would have been:

1. **33,948 radix-tree inserts per corridor is not free** — it costs ~275 ms, five times the entire graph
   build. An index that must be built per corridor has to earn that back, and this one earned nothing.
2. **`nearest_nodes` was NOT the bottleneck.** §7j's one-pass top-K had already made the scan cheap; what
   is left in anchoring is `denoise_anchor` running a **full `dijkstra_win` from point i−1 to point i+1
   for every interior point** — 38 extra Dijkstras on a 40-point sketch, on top of pass 2's 39. *The scan
   was the visible thing; the search behind it was the expensive thing.*

### 7m — the anchor pass, attributed and half of it removed

Attribution over 40 anchors on a realistic sketch, before touching anything:

| | cost |
|---|---|
| **`dijkstra_win`** | **131 ms (61%)** |
| `nearest_node1` | 41 ms |
| `nearest_nodes` | 41 ms |
| `closest_node_on_path` | ~0 ms |

**The two lookups are the same function on the same points.** For point *j*, `nearest_nodes(ct[j])` was
computed once as the source `a` while anchoring point *j+1*, and again as the target set `ctgt` while
anchoring point *j−1* — so half of that 82 ms was recomputation. Now memoised, **flat** (nested
collections are the O(n²) trap the CSR comment warns about) and **lazy** (a warm match recomputes only
the edited window, so eagerly filling all *m* points would have slowed the interaction users actually
perform — the exact regression it was meant to avoid).

| | before | after |
|---|---|---|
| 40-point match (native) | 259 ms | **~215 ms** |
| 3-point match (native) | 66 ms | 67 ms — unchanged, one interior point, nothing to reuse |
| **cold match (browser)** | 1539 ms | **1450 ms** |
| **warm match (browser)** | 358 ms | **343 ms** |

Routes byte-identical. Quiet box, spreads 1.0×.

### What is left, and why it is NOT a refactor

`dijkstra_win` is 131 ms of the anchor pass: one full search from point *i−1* to *i+1* for **every**
interior point, on top of pass 2's search per stretch. Sharing those searches between neighbours, or
bounding them, changes **which anchor is chosen** and therefore the route.

**That makes it a §7h-class change, not an optimisation** — it needs the 26-sketch corpus as its gate,
judged on the §7 quality numbers with "0 worse accepted", exactly as step 22 was.

### 7n — it was attempted, corpus-gated, and REJECTED

`tools/corpus_anchor.loft` (new) prints the §7 quality numbers per sketch over step 22's corpus — 25
lattice sketches plus, at i=25, the app's own — so a diff of two runs is the verdict. Baseline captured
first, then a deviation **prune** was added to the anchor search only (`dev_cap`; pass 2 kept `BIG`, so
its behaviour was untouched), and the cap swept:

| cap | routes changed | corpus match_ms |
|---|---|---|
| 400 m | many — sketch 0 **len 3964 → 6443 m (+62%)**, sketch 1 +26%, sketch 2 +17% | 1156 (−28%) |
| 1200 m | 5 | 1583 (−0.9%) |
| 2000 m | 2 | 1472 (−8%) |
| — | baseline | 1597 |

**There is no setting that buys speed without changing routes, and the reason is structural.** The
corpus's own `dev_max` runs to ~1056 m, so a cap tight enough to prune meaningfully is tight enough to
sever legitimate paths — the route then detours, which is why lengths *grow* by up to 62% while `dev_max`
barely moves. The deviation term already makes distant nodes expensive, so the search was never
exploring much far field to cut.

⚠ **And the loose caps' "wins" are inside the noise floor.** Two runs of byte-identical code gave
`match_ms` 1597 vs 1652 (~3.4%), so −0.9% is nothing and −8% is barely outside it. The harness now marks
its timing line `(not golden)` for exactly this reason — *a corpus is an acceptance gate, not a
stopwatch.*

**Reverted; all 26 quality rows verified identical to baseline.** A geometric prune is closed.

### 7o — reducing the NUMBER of anchor searches: also measured, also REJECTED

The other lever. Consecutive anchor searches overlap almost entirely (point *i* searches i−1..i+1, point
*i+1* searches i..i+2), so one search over a longer span can supply anchors for every point it passes
**through**. Implemented as overlapping blocks — overlapping by one point so every interior point stays
*interior* to some block and keeps a through-path anchor, rather than degrading to plain nearest-node.

**`ANCHOR_SPAN = 2` reproduces the per-point behaviour EXACTLY**, and that was verified before the value
was touched: all 26 corpus quality rows, the four border fingerprints, and `match_parity` all unchanged.
A refactor that cannot be shown faithful is not a baseline to sweep from.

| span | same | changed-not-worse | **worse** | corpus cost |
|---|---|---|---|---|
| 3 | 14 | 7 | **5** | −18% |
| 4 | 10 | 7 | **9** | −19% |
| 6 | 10 | 8 | **8** | −22% |

**0 worse accepted — so all of them fail.** The damning cases are not marginal: sketch 11 gains **855 m
of bridging** where it had none (a connectivity gap, drawn as a straight line the user can see), and
sketch 19's length goes 5377 → 9639 m (+79%).

**The cause is structural, not a tuning problem.** A longer block is optimised end-to-end, so its path no
longer passes close to each *intermediate* tap; those anchors land off the natural line, and pass 2 then
has to bridge between badly-placed anchors. *The per-point search exists precisely to centre each anchor
on its own neighbourhood* — which is the thing a shared search cannot do.

Reverted (SPAN=2 machinery included: it was behaviourally identical and no faster, so keeping a constant
that must never change would only be a trap).

### Where that leaves the anchor pass

Both levers on `denoise_anchor` are now closed by measurement: **narrowing** each search (§7n) and
**sharing** searches between points (§7o). Its ~131 ms is the honest cost of centring every anchor on its
own neighbourhood, and anything cheaper is a different matcher, not a faster one. `tools/corpus_anchor.loft`
is the gate for whoever disagrees.

⚠ And a note for anyone reaching for `spatial<T[x,y]>` elsewhere: it is sound but **not wired to its own
exact queries**. `loft2/src/spatial.rs` carries exact `nearest`/`within`, but it is `#![allow(dead_code)]`
and nothing references `spatial::` — only `radix_db`'s surface is reachable from loft. The outward walk
`xs[(x,y)..:n]` is `Near`, which loft's own source calls approximate: *"never for a correct radius or
k-NN"*. Only the BOX slice is sound, and it returns a superset that the caller must filter
(`tools/spatial_probe.loft` asserts exactly that).

## 7i. Attacking the corridor read and the graph build directly (2026-07-22)

With 18 and 19b both closed on measurement, the cold match was attacked where it actually is. The
attribution came first, and it named a culprit nobody had proposed.

### Where `build_graph`'s 163 ms went

Measured by variant (replace one part, re-time):

| component | cost |
|---|---|
| **`add_edge`** | **~108 ms (66%)** |
| node hashing | ~55 ms |
| per-edge geodesic | ~6 ms |
| `build_adj` (the CSR passes) | ~6 ms |

**Neither the trig nor the CSR mattered.** The cost was constructing ~37.6k `GEdge` records of
**fourteen** fields — eleven of them text tags that are *identical for every edge of the same way*. A
corridor has ~7.1k ways behind those 37.6k edges, so every tag was being copied five times over.

### The fix, and two wrong turns worth keeping

`GEdge` now holds `w`, an index into a per-way tag table on the `Graph`. Both wrong turns were caught by
measuring rather than by reasoning:

1. **`etags` first returned `Way`** — which carries its `coords`. Reading one per edge copied a
   coordinate vector and `match` went 199 → 450 ms: the entire `build_graph` saving handed straight back.
   Hence `WayTags` — 11 text handles, no geometry.
2. **Even `WayTags` cost too much copied per edge** (~380 ms). The fix was not a cheaper copy but *not
   copying*: `precompute_edges` now computes its five cost arrays **per WAY**, and the per-edge pass is
   five array reads. `way_penalty` alone is ~40 string comparisons and was running 37.6k times instead of
   7.1k — so this ended up **faster than the original**, not merely recovered.

### Result

Native, TUBE tier (what a cold match uses):

| | corridor | build_graph | match | total |
|---|---|---|---|---|
| this morning | 71 | 180 | 124 | 375 ms |
| after 19a | 29 | 153 | 130 | 311 ms |
| **now** | **20** | **93** | **115** | **223 ms** (−41%) |

Browser, `CPU_THROTTLE=4`, spreads 1.0×: **cold match 2721 → 1820 ms**, **warm match 644 → 526 ms**.
Routes byte-identical throughout — all four tile-border fingerprints and all three `match_parity`
lengths unchanged.

⚠ Hit a loft **codegen bug** on the way: a `text` field read directly off a struct-returning call emits
Rust returning `&str` where `String` is expected (`--native` only, and it surfaces as a rustc error
against generated code). Bind the struct to a local first. Filed in `docs/loft-feedback.md`.

## 7p. The ladder's gate re-swept on `walking_paved` — it holds (2026-07-22)

Prerequisite for wiring `server/server.loft` onto the match ladder, established **before** any code was
touched, because `tier_ok`'s own doc comment says its K was swept on `cycling_road` and warns: *"Expect
it to matter on walking/trail, where penalties dominate rather than bonuses — re-tune there."*

**The server's default profile is `walking_paved`** (`server.loft`'s `profile` default), so the warning
applies directly to it. Re-swept with `tools/corpus_tube.loft <store> walking_paved`:

| K | accepted | escalate | **worse** | ladder cost vs bbox-only |
|---|---|---|---|---|
| 5 | 12 | 14 | 0 | 90% |
| **6** | **14** | **12** | **0** | **87%** ← the wired value |
| 8 | 16 | 10 | 0 | 84% |
| 9 | 17 | 9 | **1** | 79% |

**K = 6 holds on walking: 0 worse, and the first bad acceptance is at K = 9 — the same shape as
`cycling_road`.** So the gate does not need re-tuning per profile after all, and the server can use it as
wired. The caution in `tier_ok` was worth having and is now answered with numbers rather than removed.

Note the ladder is worth **less** here than on cycling: 87% of bbox-only, i.e. ~13% off the server's tile
match, against a larger win on `cycling_road`. Real, but small — size it against the wiring's risk before
spending much on it.

---

## 7a(2). Step 19 RE-MEASURED (2026-07-22) — and 19a landed without a format change

§7a said to re-size step 19 before building it. Done, with a new instrument
(`tools/match_phase_probe.loft`), and it changed what to build.

### Where a cold match actually goes

Native, medians, the app's own sketch:

| tier | corridor | **build_graph** | match | total |
|---|---|---|---|---|
| **TUBE** — the tier a cold match uses (step 22) | 71 ms | **180 ms** | 124 ms | 375 ms |
| BBOX — what it escalates to when the gate rejects | 121 ms | 394 ms | 199 ms | 735 ms |

**`build_graph` is ~50% of a cold match — MORE than §7a's recorded ~41%, not less.** Steps 20–22 shrank
the corridor READ further than they shrank the graph build, so its share rose while the total fell.
Step 19's premise is *stronger* than when it was written. That is the opposite of what §7a expected, and
is exactly why it said to re-measure.

### 19a — the text node key, removed. No format change, no risk.

`node_idx` deduped nodes with a TEXT key, `"{lat},{lon}"`, formatted **per vertex of every way** — ~45k
float→string conversions plus text hashing per cold match. Now the fixed-point degrees packed into one
i64.

**Safe only because the text key was INJECTIVE, which was checked, not assumed.** Had loft's float
formatting been rounding, the text key would have been silently snapping nearby nodes together — that
snapping would be load-bearing, and swapping keys would change routes.
`tools/nodekey_probe.loft` asks the real corridor: **44,739 vertices → 33,948 distinct nodes under BOTH
keyings.** Route fingerprints byte-identical across all 5 `match_parity` cases.

| | before | after | |
|---|---|---|---|
| cold match, native | 375 ms | **311 ms** | −17% |
| **cold match, browser** (`CPU_THROTTLE=4`) | 3327 ms | **2721 ms** | −18% |
| build_graph, native | 180 ms | 153 ms | |
| corridor read, native | 71 ms | 29 ms | the text keys left ~34k live strings per graph; heap pressure slowed the allocating work around them |

### 19b's acceptance gate exists NOW — and it already de-risked the change

`tools/tile_border_gate.sh` (in `make test-native`) is §268's acceptance — *"a corridor spanning ≥2 tiles
matches identically"* — standing **before** the change it judges:

```
#B [0] ways=7138 tiles=14 route_pts=213 crossings=6 fp=13491979666115
#B [1] ways=7138 tiles=14 route_pts=213 crossings=6 fp=13491979666115
#B [2] ways=4501 tiles=6  route_pts=82  crossings=5 fp=2009382494520
#B [3] ways=552  tiles=4  route_pts=70  crossings=5 fp=1467589415931
#B ALL PASS — every corridor spans tiles, crosses borders, and is order-insensitive
```

**The matcher is ORDER-INSENSITIVE.** Feeding the same ways REVERSED and ROTATED gives a byte-identical
route, on all four corridors. §6b B warned the chain — way order → node/edge indices → Dijkstra
tie-breaks → a different route from identical input — and a per-tile union necessarily numbers nodes
differently from one global build. It does not matter: **19b's risk is the node SET it merges, not the
order.** That removes a canonical-node-ordering requirement the change would otherwise have carried.

**Non-vacuity is asserted, not hoped for.** Each corridor must span ≥2 tiles *and* its route must actually
cross a boundary — a green run over corridors that never touch a border proves nothing. The golden check
was verified to FIRE by perturbing one fingerprint by 1.

### 19b — MEASURED AND REJECTED. Do not build it.

Its whole case is that unioning persisted per-tile graphs is much cheaper than building one from ways.
That had never been measured. `tools/union_probe.loft` simulates the change with in-memory parts —
partition the corridor's ways by storing tile, build each tile's graph (the work that would become
persisted), then time the **union alone** against a straight build of the same corridor:

| corridor | build | union | saving |
|---|---|---|---|
| 14 tiles, 7138 ways | 154–158 ms | 132 ms | ~16% |
| 6 tiles, 4501 ways | 92 ms | 73 ms | ~21% |
| 4 tiles, 552 ways | 16–21 ms | 14–18 ms | ~13% |

**And the structural reason, so it is not just three numbers:**

```
hashed: build=44739 vertices vs union=34454 part-nodes (parts duplicate only 506)
```

The union must still hash **every part-node** to merge the parts — only **23% fewer** than the vertices a
build hashes — and it still copies every edge and still rebuilds the CSR. All it genuinely skips is the
per-vertex coordinate walk and one geodesic per edge. With the parts duplicating just **1.5%** of their
nodes, **there is no headroom for a cleverer persisted format either**: any union has to merge ~34k nodes.

**Sizing it.** `build_graph` is ~49% of a cold match and the union saves ~16% of that, so 19b is worth
**~8% of a cold match — about 215 ms of the browser's 2721 ms.** In exchange for a `TTile` format change,
regenerating and redeploying 23.5 MB of stores, a loader-side merge, and the riskiest row in the plan.
**19a delivered 606 ms the same afternoon for a one-line key change.**

⛔ **NO-GO.** Found for the cost of a probe rather than a regeneration, a redeploy, and a route-regression
hunt. `union_graphs` is kept as the reference implementation — correct, and where a future revisit starts
— with its route identity asserted in the border gate rather than left to rot as unexercised code.

**If it is ever reopened**, re-run `tools/union_probe.loft` first: the verdict is a ratio between two
costs, and either could move (a cheaper node hash, or a corridor small enough that the constant factors
change the balance).

---

## 7a. Step 19 scoped — persisting the graph is a FORMAT change (read before starting)

Its one-line summary undersells it. `PLAN-TILES` §268 is not "prebuild one graph": *"the generator
persists per-tile `GNode`/CSR adjacency alongside (or instead of) `Road`s; the loader unions the loaded
tiles and merges their **exact-integer border nodes, splicing adjacency**… Do this **only after**
single-tile read (B.2 / D.4) works."* A graph is corridor-specific, so what can be persisted is a graph
**per tile**, re-unioned per corridor. That means all of:

1. **`TTile` gains `GNode`/CSR fields** — a store-format change.
2. **`tools/gen-tiles.loft`** builds and writes them.
3. **The stores are regenerated** (enschede: 20 MB layout + 3.5 MB roads) and re-deployed.
4. **The loader unions the corridor's tiles and splices border nodes** — the risky part: borders must
   merge on exact-integer coords, or a route crossing a tile edge changes. §268's own check is "a corridor
   spanning ≥2 tiles matches identically".
5. Only then does the kernel skip `build_graph`.

**Prerequisite status:** §268 says "only after single-tile read works". The paged API **is** shipped
(`store_load_key` / `store_load_keys` / `store_load_key_text`, loft#522) and there is prior art in
`client/basemap/load_working_set.loft` — but the app's kernel does **not** use it: it loads whole stores.
So the prerequisite is *available*, not *met*.

**Sizing, honestly.** Since step 7 the graph is built once per corridor and reused, so `build_graph` now
costs only on a corridor MISS — i.e. the cold match (~5.3 s), where it is ~41% (~2.2 s). Real, but this is
a format change plus a border splice that can silently alter a route, for one number.

**So do step 20 first.** The cell-tube corridor is *additive and inert* (tube beside bbox, bbox still the
default), changes no format, regenerates nothing, and shrinks the ways — which makes **both** the corridor
read and `build_graph` cheaper, attacking the same cold match from the cheap end. Re-measure after it;
19's ~41% may be a smaller slice of a smaller number by then, and 22's gate may matter more than either.

---

## §7h — Step 22 attempted and REVERTED: an absolute `DEV_TOL` is the wrong gate (2026-07-22)

**Status: wired, measured, reverted. The tree is clean and the ladder is not live.** PLAN-MATCH §3's
threshold is correctly *tuned* (0 worse accepted) and still makes the app **slower**. Both are true, and
the second was invisible until the ladder was costed rather than just validated.

**The corpus said go.** `tools/corpus_tube.loft` now simulates the ladder and times both tiers:

```
GATE DEV_TOL=900: accepted=13 escalated=12 WORSE_ACCEPTED=0
COST bbox_only=15552ms ladder=8272ms  (53% of bbox-only)
```

**The app said stop.** Wired into `do_match_session_streamed`, the profiler's cold match went
**5899 → 10064 ms** at `CPU_THROTTLE=4`. On the profiler's own sketch:

```
tube: ways=7138  bridged=0  devmax=1047  ms=245
bbox: ways=13077 bridged=0  devmax=1047  ms=538
GATE=ESCALATE  ladder_ms=783  bbox_only_ms=538      ← 1.46x SLOWER for an IDENTICAL result
```

**The mechanism.** `dev_max` measures how far the matched route sits from the **drawn sketch** — mostly a
property of *where the user drew*, not of which corridor was used. A line drawn 1 km from any road has
`dev_max ≈ 1000` under **both** tiers. The gate then reads a large `dev_max` as "the cheap corridor
clipped something" when it actually means "this sketch is far from the network", escalates, and pays the
fat tier to produce the same answer. In the corpus, **8 of the 12 escalations have `t_devmax ==
b_devmax`** (rows 0, 13, 15, 19, 20, 21, 22, 23) — pure loss, by construction.

The corpus average hid this because the *accepted* sketches happen to be the expensive ones (9606, 8066,
9477 ways) while the escalations are mostly sparse. So the aggregate wins while the sketches the app
actually runs lose. **An average over a synthetic corpus is not a claim about a specific interaction** —
the same lesson as §7e, one level up.

**Two candidate redesigns, neither tuned yet:**

1. **Drop `DEV_TOL`; gate on `bridged_m == 0` alone.** §3's own finding 1 says connectivity does most of
   the work (2 of 3 worse cases). Costs: i=7 would be accepted (dev 1003 vs bbox's 484) — 1 worse
   accepted in 25. Cheap to evaluate: re-run the corpus with `DEV_TOL` at infinity.
2. **Make the deviation test SCALE-RELATIVE — the more principled one.** The tube keeps tiles within
   `corridor_margin(pts)` of the polyline, so `dev_max > margin` means the route is straying to where the
   tube's ways run out, while `dev_max <= margin` means it sits comfortably inside and nothing was
   clipped. That tests the *corridor*, which is what the gate is for, instead of the sketch. It also
   self-scales per sketch, so no constant is fitted to a corpus.

**Whichever is chosen, the acceptance criterion must change too.** "0 worse accepted" is necessary and
not sufficient; the gate must also be shown to cost less **on the sketches the app runs**, not only in
corpus aggregate. The step-22 row now says so.

**What was kept:** `tools/corpus_tube.loft` gained the ladder simulation, per-tier timing, and the
`WORSE_ACCEPTED` / `COST` lines — that harness is what caught this, and it is what will tune either
redesign. The kernel wiring itself is reverted; `tools/match_parity.sh` is byte-identical again.

**A note in the ladder's favour, so it is not written off:** on `match_parity`'s case C the tube was
accepted and produced a byte-identical route from **4501 ways instead of 11287**. The tier is genuinely
good; only the gate is wrong.

### §7h(2) — Option 2 shipped: the margin-relative gate, cold match 1.96× (2026-07-22)

`bridged_m == 0 && dev_max <= corridor_margin(pts) * K`. It asks the question the gate is *for* — did the
route stray to where the tube's ways run out? — instead of "did the user draw far from a road?", which is
what an absolute `dev_max` answers and why it escalated 8 cases for nothing.

**K was swept, not chosen.** `corridor_margin` is capped at `CORRIDOR_MAX_M = 200 m` while corpus
`dev_max` runs 339–2390 m, so a literal `dev_max <= margin` accepts nothing and the useful ratio had to
be read off the data. The corpus now includes **the app's own sketch** (i=25) for exactly the reason §7h
records — an aggregate can win while that sketch loses:

| K | accepted | WORSE | ladder cost | app sketch |
|---|---|---|---|---|
| 5 | 11 | 0 | 90% | escalates |
| **6** | **13** | **0** | **83%** | **ACCEPT** |
| 8 | 16 | 0 | 77% | ACCEPT |
| 9 | 17 | **1** | 70% | ACCEPT |

**K = 6, not the cost-optimal 8.** §3's asymmetry decides it: the gate can only make us escalate (spend
more), never accept something the fat tier would improve on — so headroom is cheap and a wrong acceptance
is the only real failure. 6 sits two full steps below the first bad acceptance and still accepts the
sketch the app runs.

**Measured A/B, one quiet machine, `CPU_THROTTLE=4`, every spread 1.1×:**

| | ladder off | ladder on | |
|---|---|---|---|
| **cold match** | 6370 ms | **3253 ms** | **1.96×** |
| warm (one point moved) | ~880 ms | **584 ms** | 1.5× |
| repeat (nothing changed) | ~450 ms | **306 ms** | 1.47× |

The warm/repeat gains were not predicted: the session now *holds* the accepted tube corridor, so every
later incremental match runs over ~half the ways too. The ladder pays twice over.

**Gated on the COLD path only.** Re-gating warm edits was tried and showed a 4.6× spread on the warm
number — an edit that tripped the threshold turned a ~700 ms incremental match into a full corridor
rebuild. It is also redundant: `covered()` already requires every point within `margin * 0.85` of a
corridor this session built, so a covered edit is by construction inside the tube that was accepted.
**`covered()` is the warm-path guard; the gate chooses a tier at build time.**

**A measurement note that nearly cost a wrong conclusion.** The first post-wiring profile showed cold
6903 ms with a **2.0× spread** and warm at **4.6×** — the machine was at load average 25 from sibling-tree
builds. Both the ladder-on and ladder-off numbers above were taken after it quiesced. *A profile without
its spread is not a measurement*, and this repo's own instrument prints the spread for that reason.

**Not wired: `server/server.loft`.** Step 22's row says "server + kernel", but the server keeps its own
`covered()` + corridor logic and an Overpass path with a different accumulate-vs-replace policy that the
corpus does not cover. Wiring it on this evidence would be speculative; it needs its own corpus over the
Overpass path first.
