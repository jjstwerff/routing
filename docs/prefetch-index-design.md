<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# The prefetch index — turning 764 round trips into one batch

**Kind:** reference · **Status:** current · **Last verified:** 2026-08-04 · **Owns:** the page index that turns a paged read from 764 round trips into one batch

**Status: BUILT, PUBLISHED and LIVE — §11 is the state; §0–§10 are how it was reached; §12 is the
measurement that caught the harness lying and cut the claim from 2.29× to 1.53×.**

The design half was written BEFORE the code, because the failure paths are where the invariant surfaces
(`design-protocol`), and because this is an exact-invariant domain — byte ranges, caching, round trips —
where the construction has to be *recovered from a capture*, not argued from the desk. Two of its own
sections were later retired by measurement (§7 by §8.2); they are struck through rather than deleted,
because what a design got wrong is the part worth keeping.

---

## 0. The measurement that starts it

A cold visitor opening the app on Amsterdam, live site, `CPU_THROTTLE=4`:

| | |
|---|---|
| time to first map drawn | **16.1 s** (a second run: 19.7 s) |
| ranged requests before first paint | **764** |
| ranged requests after first paint (the ring) | 38 |
| bytes before first paint | **50.1 MB** — 43.3 MB base + 6.7 MB roads |
| effective concurrency | **0.4×** — serial, *and* gappy |

⚠ **The ring is not the problem.** 764 of 802 requests are on the critical path; the prefetch that
happens after the pixels are up is 38. An earlier reading of this blamed the ring and was wrong.

**And the requests are latency-bound, not bandwidth-bound** — measured against the live host:

```
1 B      41 ms        ← a 64 kB range costs the SAME as one byte:
64 kB    41 ms          the round trip dominates completely
512 kB   85 ms        ← marginal transfer ≈ 85 Mbps
2 MB    221 ms
         TTFB 26 ms on a reused connection
```

`764 × 26 ms ≈ 20 s`, against 16–20 s measured. **The wait is round-trip depth, and essentially
nothing else.** That is the whole finding: no amount of byte-shaving moves it, and fetching *more*
bytes in fewer requests would be faster.

---

## 1. The invariant

> **Every byte the pager asks for during a cold read of cell set `K` is already in the client's buffer,
> because the pages a cold read of `K` touches are a pure function of `(block bytes, K)` — knowable
> ahead of time, and therefore fetchable in one parallel batch instead of 764 serial ones.**

This is a hypothesis, and it was **tested before being designed around** (`design-protocol` step 3).
Two cold captures of the same camera, recorded from CDP so nothing was perturbed by instrumenting it:

```
critical-path requests   A=764  B=764
distinct ranges          A=739  B=739
IDENTICAL AS A SET       YES
IDENTICAL IN ORDER       YES
offsets aligned to 64 kB 764/764
```

**Byte-identical, in order.** The invariant holds, and the capture also handed us the construction:

**It is not a range index. It is a PAGE SET.** Every read is 64 kB-aligned; sizes are 739 × 64 kB,
19 × 128 kB, 2 × 192 kB and 3 × 1 B (size probes). So the published artifact is *"which 64 kB pages
does cell `c` need"*, which is far smaller and far more reusable than a per-camera range list.

---

## 2. What it costs to publish

| | |
|---|---|
| distinct pages for this camera | 661 base + 102 roads |
| a packed index for this camera | **~9 kB** |
| **upper bound for a whole block** | `nl-midwest.base.store` is 812 MB ⇒ **12 400 pages** ⇒ a complete page map is **~150 kB**, 0.018% of the block |

The index is bounded by the block's **page count**, not by the number of cameras — every camera draws
from the same 12 400 pages. That is the property that makes one published file serve every visitor,
and it is why the falsifier in §5 does not fire.

---

## 3. The design

1. **Record.** A generator walks each cell of a block and records the pages a cold read of that cell
   touches. `browser/cdp_range_capture.mjs` already does this from CDP for a camera; the generator form
   does it per cell, offline, from the block itself.
2. **Publish** `<block>.pages` beside the store: `cell → page list`, keyed by the block's **sha256**.
   ~150 kB. It regenerates without re-uploading the 812 MB block, which is the second thing this buys.
3. **Prefetch.** On a view: resolve cells (already done — `layout_cell_keys`), union their page lists,
   coalesce adjacent pages, and issue the batch **concurrently**. One round trip of depth instead of 764.
4. **Serve.** `loft_host_http_range` finds each range in the buffer and returns **synchronously** — the
   path the sidecar cache already proves: `ctrl.httpBytes = hit; return hit.length`, no fetch, no
   asyncify unwind. **Delete each entry as it is consumed**, so peak JS memory is the in-flight batch and
   not a second copy of the image (the caveat `store-kernel.mjs` states for the sidecar cache is about a
   *cache*, which retains; a drained prefetch buffer is a different object).

**Predicted:** depth `764 → ~1`, leaving the 50.1 MB transfer at ~85 Mbps ≈ **4.7 s** as the floor.
So **16 s → ~5 s**, and the remaining cost becomes bytes, where it was never the binding constraint before.

---

## 4. Re-assertion sites — `N = 1`

The invariant is asserted in exactly **one** place: `loft_host_http_range` in `browser/store-kernel.mjs`.
Every paged read in the app already funnels through it — that is the same chokepoint the sidecar cache
and every range counter sit on. Nothing else has to know the prefetch exists.

⚠ **The staleness check must sit at that same site**, or `N` becomes 2 with a silent failure mode (see
§5.1). A hit is only a hit if the buffer was built for *this* block's sha256.

---

## 5. Failure paths — what breaks, and what makes it loud

**5.1 A stale index serves WRONG BYTES, silently.** This is the one genuine correctness hazard: an
index outliving its block would return plausible bytes from the wrong offsets, and loft would decode
garbage rather than error. **Mitigation:** the index carries the block's sha256, `coverage.json` already
records that sha256 per block, and the bridge refuses a buffer whose hash does not match the store it is
serving. Loud, at the chokepoint, `N = 1`.

**5.2 A cell the index does not name.** A viewport at a zoom or margin the generator never walked asks
for a page not in the buffer. **This must degrade, not fail:** an unknown range falls through to the
existing fetch path. The design is then a *latency* optimisation that can miss, never a correctness one.

**5.3 The prefetch is wasted.** If the union over-fetches, we pay bytes for pages never read. Bounded
and measurable: compare pages prefetched against `rangeReads` actually served from the buffer. A hit
rate below ~80% means the per-cell recording is too coarse.

**5.4 Memory.** 50 MB of prefetched pages held in JS *beside* wasm's copy is exactly the thing the
sidecar comment warns about. Drain on consume; assert peak buffer size in the gate.

**5.5 The ring interacts.** `scheduleRing` runs after the view and would issue its own reads. It should
consult the same buffer, and its pages should be prefetched at *lower priority* — never ahead of the
critical path, which is the property that made the ring worth having.

---

## 6. The claim most likely to be wrong

Per `design-protocol` step 4, the cleanest claim deserves the most suspicion. Here it is:

> *"the pages a cold read of `K` touches are a pure function of `(block, K)`"*

Proven for **one camera, twice, from cold**. **Not yet proven** for:

* **accumulation** — `store_load_keys` accumulates, so the pages touched for cell `K` may differ when
  the session already holds cell `J`. If they do, the index must be per-cell-from-cold and the union
  will over-fetch. *Probe: capture cell `K` alone, then `J` then `K`, and diff.*
* **key order** — captured in one order only. *Probe: same cells, shuffled, diff.*
* **a different block** — one block, one zoom. *Probe: repeat on `nl-east` and at z16.*

**Until those three diffs come back empty, this is a hypothesis with one confirmation, not a law.**

---

## 7. One index over THREE scales — and what it unlocks

The ladder is already three-tiered, and each tier is a separate store:

| scale | block | zoom | read | size | 64 kB pages |
|---|---|---|---|---|---|
| rough | `overview` | 0–12 | **whole** | 46.4 MB | 708 |
| middle | `nl-mid` | 12–14 | paged | 305.2 MB | 4 657 |
| detail | `nl-midwest` | 14–99 | paged | 812.6 MB | 12 398 |

A page index keyed by cell can name **all three at once** — the same lookup, one published file, one
batch. A complete three-scale page map for that column is ~17 800 pages ⇒ **~215 kB**, and it compresses
hard because cell→page is nearly monotonic in `tkey`.

**What that unlocks is not "3× faster". It is *instant, then sharpens*.** Draw the rough data at once,
fetch detail behind it — and the app is *supposed* to do this already. `PLAN-LAYERS` §5 (L3) names it as
the first of the floor's three jobs:

> **never blank while a finer layer loads** — real vectors instead of `holdFrame`'s stretched pixels

⚠ **It cannot do that today, and the reason is exactly the one this design removes.** The floor is
**read whole** — `readMode: "whole"`, 46.4 MB — so `store-app.mjs` loads it *on first need* rather than
at boot, deliberately: *"a visit that lands straight on z16 inside a covered region never sees the floor
and must not be charged 33.7 MB for it."* A 33.7 MB whole-file fetch can never sit **in front of** a
first paint. So the floor is a **coverage** fallback (fires where the fine layer has no ground) and not a
**loading** fallback — which is why the Amsterdam capture in §0 shows no overview requests at all, and
why the user sees 16 s of nothing rather than 16 s of coarse map sharpening.

**Page the overview and that inverts.** A viewport's worth of the rough layer is a handful of 64 kB
pages — well under a megabyte — so it costs ~1 round trip, not 46 MB:

| | today | with a three-scale page index |
|---|---|---|
| first pixels | **16.1 s** (blank until detail lands) | **~0.3 s** — rough layer, ~1 RTT + <1 MB |
| full detail | 16.1 s | ~5 s, arriving behind a map that is already drawn |
| overview fetched | 46.4 MB whole, or not at all | only the pages the viewport covers |

**The scope change this implies:** `overview` moves from `readMode: "whole"` to `paged`. That is a
one-line manifest change plus a regenerated index — the store itself is unchanged, because paging is a
property of how it is READ, not of how it was written. ⚠ It needs its own measurement: `overview` was
made whole-read *because it is small and universally needed*, and §6i measured a bare visit at 19.62 MB
in one request / 0.6 s. Paging it must not make the country view slower to serve a deep-link case.
**That is a trade to measure, not to assume** — and it is the first thing to probe after §6's three diffs.

---

## 8. ⚠ A MOVING SESSION SAYS SOMETHING ELSE — and it retires §7's proposal

Everything above measures a **cold deep link**. That is the worst case and an unrepresentative one: *a
session is never a teleport.* Replaying a walk instead (`browser/cdp_journey.mjs`, live, CPU 4×, n=1):

```
step                     kind               ms   reqs      MB
entry (cold deep link)   —               37450    764    52.3
pan  ¼ screen            in-ring         16753    436    28.6
pan  ¼ screen again      in-ring          6799    100     6.4
pan  1 screen            past-ring       12045    386    25.3
zoom out z13             same block      22879    457    29.9
zoom out z12  →nl-mid    SCALE CHANGE    11933    486    31.8
zoom out z11  →overview  SCALE CHANGE     4627      0    13.5
zoom in  z14  →detail    SCALE CHANGE    27548    778    52.4
zoom in  z16             same block     >40000   1356    88.9
```

Three things fall out, and the second one **retires §7**:

1. **Panning is not free.** A quarter-screen nudge costs 436 requests. The ring exists to make that a
   redraw and on a moving session it is not delivering.
2. ⚠ **THE FASTEST STEP MADE ZERO RANGE REQUESTS.** z11 loads `overview` **whole** — 13.5 MB, one fetch,
   **4.6 s** — beating every paged step, including ones that fetched *less data*. **§7 proposed paging
   the overview; on this evidence that would make the fastest step in the journey slower.** The
   generalisation that survives is not "page everything", it is **fewer, larger requests win** — which is
   the same conclusion §0's `1 B == 64 kB == 41 ms` reached from the other end.
3. **Returning to a scale re-fetches everything.** Coming back to z14 costs 778 requests / 52.4 MB —
   *more than the original cold entry*. The working set is discarded on a scale change, so "zoom out for
   bearings, zoom back in" pays full price twice. On a journey this is the dominant cost.

**So the ranking for a walk is not the ranking for a landing:** retention across scale changes first,
then why the ring does not hold, and only then batching round trips.

---

## 9. The chunk graph — an index that pages itself and knows its neighbours

⚠ **FIRST, THE PROPERTY EVERYTHING ELSE RESTS ON: THE DATA DOES NOT MOVE.** The `.store` files on Pages
stay byte-for-byte as they are. The index is a **new, small, separately published file** that holds
nothing but *pointers into the stores we already uploaded* — page offsets and neighbour offsets. It is
~150 kB against an 812 MB block, 0.018%.

Three consequences, and they are the reason to build it this way rather than to re-cut the stores:

* **Nothing is regenerated and nothing is re-uploaded.** Not the 812 MB block, not the 3 GB of base maps
  on their own Pages repos, not the release. The published dataset is untouched, so this cannot break
  what is live — the failure mode of an index is a *missed prefetch*, not a wrong map (§5.2).
* **The index is CHEAP TO ITERATE, and the data is not.** Chunk size, how many pages a chunk names,
  whether `UP`/`DOWN` are worth their bytes — every one of those is a different 150 kB file over the
  *same* store. We can publish half a dozen variants and measure them against the live blocks in an
  afternoon. Re-cutting a store to test the same questions is a day per variant and a full re-upload.
* **It is separately versioned**, so it can be wrong without being dangerous — provided the sha256 check
  of §5.1 sits at the chokepoint. An index that does not match its block must be *ignored*, not trusted.

That is what makes "upload a custom index and test it" a real experiment rather than a rehearsal: the
thing under test is the only thing that changes.


The index must not be one file the client fetches whole; at Western Europe scale that is the same
mistake one level down. It is **chunked spatially**, and *cheap adjacency is simply each chunk recording
where its neighbours are* — no Morton order, no key arithmetic, no dependence on how `tkey` happens to be
encoded. A chunk is self-describing:

```
chunk {
  pages[]            the 64 kB pages the cells in this chunk need
  N, S, E, W         byte offset + length of the four adjacent chunks
  UP, DOWN           byte offset + length of the chunk covering the same ground
                     at the coarser / finer scale
}
```

Six pointers, and each is just an offset into the same index file — so following one is a ranged read of
a few kB, not a lookup that must first be discovered.

**Why this shape answers each measured problem:**

| measured | what the chunk graph does |
|---|---|
| 764 serial round trips on cold entry (§0) | one chunk read yields the whole page list ⇒ one parallel batch |
| a ¼-screen pan costs 436 requests (§8.1) | `N/S/E/W` are already known ⇒ the neighbour's pages prefetch with no discovery step |
| returning to a scale re-fetches everything (§8.3) | `UP`/`DOWN` make the coarser chunk one hop, and its pages are retained rather than rediscovered |
| whole-load beat paged (§8.2) | chunk size is the tuning knob — size a chunk so its page batch is few, large requests |

**The retention rule is the load-bearing half, and it is separate from the index.** An index that makes
pages *findable* does nothing if the pages are *dropped* on every scale change. §8.3 is a cache-lifetime
defect, not an indexing one, and it must be fixed on its own terms — the index makes the refetch cheap,
retention makes it unnecessary.

⚠ **Open, and it decides the chunk size:** what does a scale change actually discard, and why? The app
must not pull a foreign store into a session whose layout store is exposed — that *traps* (`store-app.mjs`,
and the ring's fourth rule). If the discard is that constraint rather than an eviction policy, then
retention across scales needs the session to hold several stores at once, which is a bigger change than
an index. **Probe before designing further: instrument what is released on a scale change.**

---

## 10. What is measured vs. assumed

| claim | status |
|---|---|
| 764 requests on the critical path, 16–20 s to first paint | **measured**, live, n=2, CPU 4× |
| the sequence is byte-identical across cold runs | **measured**, A/B diff, in order |
| every read is 64 kB-aligned | **measured**, 764/764 |
| a 64 kB range costs the same as 1 byte | **measured**, 41 ms vs 41 ms |
| a full-block page index is ~150 kB | **derived** from block size ÷ page size |
| depth collapses to ~1 and first paint reaches ~5 s | **predicted** — the build is the last probe |
| pages are independent of accumulation, key order, block, zoom | **unproven** — §6 |
| a three-scale page map is ~215 kB | **derived** from the three blocks' sizes ÷ page size |
| the floor cannot front a first paint today because it is whole-read | **read from the code** — `store-app.mjs`, `coverage.json` `readMode: "whole"` |
| ~~first pixels reach ~0.3 s with a paged overview~~ | ⚠ **RETIRED by §8.2** — the whole-loaded overview is the FASTEST step measured (4.6 s, 0 range requests); paging it would make it slower |
| a ¼-screen pan costs 436 requests / 16.7 s | **measured**, journey, n=1 |
| returning to a scale re-fetches everything (778 reqs) | **measured**, journey, n=1 |
| six pointers per chunk make adjacency and scale change cheap | **design** — nothing built, nothing measured |
| what a scale change discards, and whether it is policy or the expose constraint | **UNKNOWN — probe first** (§9) |


---

## 11. Where this stands (2026-08-04, late)

**Built, wired to v3, and under two gates.** The browser reads the ONE coverage index now — the reader
spoke v1 while the builder wrote v3, and until that was closed nothing in the browser could read it.

| | |
|---|---|
| hand-fed a capture, one store fully covered | 26.0 s → 5.4 s · 4.79× |
| wired, v1 per-store, one of three stores indexed | 15.5 s → 7.5 s · 2.06× |
| ~~wired, v3, latency-only harness~~ | ~~14.5 → 6.3 s · 2.29×~~ ⚠ **the harness had infinite bandwidth — see §12** |
| **wired, v3, 82 Mbps + 45 ms emulated (this box's measured link)** | **to the view 26.3 → 17.2 s · 1.53×** · **to a settled session 99.5 → 67.4 s · 1.48×** |

Measured `tools/prefetch_gate.sh`, camera `14/49.6116/6.1319` (Luxembourg — both its stores are paged and
indexed), quiet box. **The counts are identical run to run**: 1 751 range reads, 743 answered out of the
buffer, 174 chunk reads for 870 kB of index — and the same map either way, `R=12242 G=1381 T=59` with
per-layer counts equal.

⚠ **The 2.29× above is struck through because the harness was measuring the wrong link.** §12 is what
happened; the short version is that it injected the round trip and not the ceiling, so fetching pages
nobody reads was free in it and is not free anywhere else.

**Building the reader turned up three defects, and every one was silent by construction.**

* ⚠ **The index's own offsets were 4 bytes wrong.** The builder declared `header_len = 40` beside a
  36-byte `struct.pack`, so every sub-directory and chunk offset pointed past its own data. *Nothing
  failed* — §5.2 is the reason: a page number is a fetch hint, so a completely garbled index degrades to
  the read path it replaces. The length derives from the format now, and the builder re-reads its own
  output and walks every leaf before reporting success.
* ⚠ **The covering set is comma-separated and `prefetchFor` split it on a space**, so every multi-block
  viewport prefetched nothing. A border screen is the case the covering set exists for.
* ⚠ **A `whole` store has no pages to plan.** At z8 the country-wide viewport covers nearly every leaf,
  and the app read **3.6 MB of index (575 chunks)** to plan a store it was about to fetch in one request.
  Only paged stores are asked about now — which is §11 note 5's "do not index the overview", enforced at
  the one place that can enforce it rather than in the builder.

**And the ring plans its pages too.** The view read 455 ranges; the ring behind it read **1 296**, none of
them prefetched — so prefetching the view alone left three quarters of a session's round trips serial.
Session hit rate **51.6% → 85.3%**. It stays behind the critical path by construction: the ring is chained,
one cell at a time, and the prefetch happens inside a cell's own job (§5.5).

### The hit rate, attributed

`84.3%` for the **view**, of the reads on stores that were prefetched at all. That is the number §5.3 asks
for and the gate asserts on. A session-wide rate would have measured the ring's policy instead of the
index's accuracy — the first run of the gate reported **51.6%** and the whole of the gap was the ring.
*A number is not a measurement until you know what it is attributed to.*

### The pieces

| | |
|---|---|
| `tools/build_page_index.sh` | cell → pages, from a logging range server (16 workers, byte-identical to sequential) |
| `tools/add_cell_coords.sh` | adds each cell's `ox`/`oy` — **JS works in bboxes and never computes a `tkey`**, so without this the index is unusable from the only place that needs it |
| `tools/build_coverage_index.py` | **v3: ONE index over every store**, quadtree leaves, two-level directory, full cross-origin URLs — and it verifies its own output by re-reading it |
| `tools/finish_page_indexes.sh` | coords + one coverage index + stage, idempotent, safe to re-run while generation continues |
| `browser/page-index.mjs` | **the reader — v3**, one session read, then a sub-directory and a few chunks per screen |
| `browser/store-kernel.mjs` | page-granular prefetch buffer, drained on consume, coalescing adjacent pages |
| `browser/page-index.test.mjs` | **the format gate** — builds a fixture, runs the real builder, reads the bytes back through a Range-honouring `fetch` stub. Hermetic; in `make test` |
| `tools/prefetch_gate.sh` + `browser/cdp_prefetch_wired.mjs` | **the wired gate** — the app plans its own viewport, and the MAP must match across both arms |
| `browser/cdp_latency.mjs`, `cdp_range_capture.mjs`, `cdp_journey.mjs`, `cdp_prefetch_ab.mjs` | the instruments |
| `data/journeys.json` | a session described as data — a walk, not a teleport |

`tools/chunk_page_index.py` (the v1 per-store writer) is **gone**: nothing reads that format now, and an
unread writer beside a live reader is the survivor that looks authoritative.

### v3, and why it is shaped that way

The whole Benelux, every store, complete:

```
15 stores · 275 177 cells · 1 369 leaf chunks · levels L0=8 L1=12 L2=75 L3=138 L4=1136
root tiles 26 · header+stores+rootdir 1 677 B   ← ONE read per SESSION
sub-directory  median 256 B · max 3 760 B       ← ONE read per tile
chunk          median 5 464 B · max 18 480 B
total 8.5 MB — a viewport reads ~870 kB of it, a session 1.7 kB before it plans anything
```

⚠ **The file more than doubled (4.2 → 8.5 MB) when the last two base stores were indexed, and what a
VIEWPORT costs did not move at all** — still 174 chunks and 870 kB on the same camera, because a chunk is
bounded by CELL COUNT and the new cells are somewhere else. That is the property the quadtree was chosen
for, observed rather than argued.

* **A quadtree, not a grid.** Measured density spans **4 to 6 297 cells/deg²**, so a uniform grid is
  either too coarse for the Randstad or absurd over the North Sea. Bounding a chunk by CELL COUNT took
  the worst chunk from **1 006 kB to 19 kB**.
* **A two-level directory.** A flat one projects to **252 kB at Western Europe**, read whole before a
  single page is planned, every session. Split, it is ~8 kB of root plus ~512 B for the tile you are in.
* **Full URLs across origins**, so an entry can point at the app's site, any of the `routing-data-*`
  repos, or a bucket. ~176 stores ≈ 19 kB at WE, read once.

Projected: WE ≈ 2.9 M cells ≈ 97 MB total, **read by range, never whole** — a viewport still costs a
sub-directory and one to four chunks.

### What is NOT done

1. ✅ ~~Generation is unfinished~~ — **all 15 stores are indexed** (2026-08-04): `nl-mideast.base` and
   `nl-east.base` were the last two, 143 304 cells between them.
2. ✅ ~~Nothing is published~~ — **`coverage.pagesx` is live** on `data-v2026-08-03d`, fetched by
   `tools/fetch-site-blocks.sh` and served from the app's own origin with a real 206.
3. **`PREFETCH_PAD` (0.16°) is a guess**, and §12 measured what it costs: at z14 it makes the QUERY box
   ~40× the area of the screen, so the pad and not the viewport decides what is fetched. The sweep is in
   §12 — smaller pads waste less and hit less, and the trade depends on the LINK, which is why it is not
   a constant anyone should tune without re-measuring both.
4. ✅ ~~The overview should probably not be indexed at all~~ — **answered by the app instead of by the
   builder.** It is not that the overview must not be *indexed*; it is that a `whole` store must not be
   *prefetched*, which is one test at the one place that knows the read mode. The overview is still in the
   index and costs nothing there.

---

## 12. ⚠ THE HARNESS HAD INFINITE BANDWIDTH, AND IT SCORED THE WRONG DESIGN

The local A/B injected the round trip (26 ms, then 45) and nothing else. A localhost server has no
throughput ceiling, so **fetching pages nobody reads was free in the harness** — and the number it
produced, 2.29× to the view, was real about that link and wrong about every other one.

**The live site refused to reproduce it**, and that is what exposed the instrument:

```
live, deployed, camera 14/52.3702/4.8952 (Amsterdam)
  A  prefetch off   31.2 s to the view · 88.4 s to settled · 204.1 MB
  B  prefetch on    33.2 s to the view · did NOT settle in 120 s
     …with a 91.6% view hit rate and a byte-identical map
```

The index was working perfectly. The premise was still true — re-measured against the live host the same
hour: **1 B → 45 ms, 64 kB → 48 ms, 512 kB → 97 ms, 2 MB → 238 ms, 82 Mbps sustained**, i.e. still
latency-bound, still ~the numbers §0 recorded eight weeks earlier. So bandwidth was not scarce; it was
being *spent*.

### What it was spent on: 86% of the prefetch was never read

The hit rate could not see this. It asks *"of the READS, how many were served from the buffer"* — a
question about reads. Nobody was asking the inverse, *"of the PAGES FETCHED, how many were used"*:

| pad | pages fetched | ever read | **used** | view hit rate |
|---|---|---|---|---|
| 0.16° | 9 811 | 1 331 | **13.6%** | 84.3% |
| 0.04° | 5 141 | 1 300 | 25.3% | 80.8% |
| 0.01° | 2 417 | 1 223 | 50.6% | 72.4% |
| 0.0025° | 1 867 | 1 111 | 59.5% | 63.1% |

9 811 pages is **643 MB**, to serve a session that reads 113 MB. At 82 Mbps that is 63 s of transfer the
harness never charged anyone for.

**Two independent causes, and one of them was free to fix:**

* ⚠ **THE RING RE-BOUGHT WHAT THE VIEW HAD ALREADY PAID FOR.** The buffer *drains* on consume (§5.4, to
  bound memory), so "is this page in the bag" is not the question "have we fetched this page" — and the
  ring's eight cells, each padded by 0.16°, ask for nearly the same ground nine times. `prefetch()` now
  skips any page this session already fetched: **9 811 → 1 156 pages, 643 → 75.8 MB, used 13.6% → 64.3%**,
  with the view's hit rate unchanged at 84.3% (the view is the first batch; nothing is deduped away from
  it). A page wanted again after being consumed simply misses and is read normally — a round trip, never
  a wrong byte.
* ⚠ **THE PAD WAS MOST OF THE REST, AND ON A DENSE CITY IT WAS STILL A NET LOSS.** With the dedup in and
  0.16° still the default, the deployed app on Amsterdam z14 fetched **6 635 pages / 434.8 MB to serve a
  204 MB session — 34.9% used — and the view went 35.0 s → 50.2 s, i.e. 0.70×**. A 0.16° pad around a
  z14 screen is ~40× its area, and dense ground fills that with real cells. **The default is 0.02° now**,
  measured live by injecting the pad into the deployed page (n=2, counts identical):

  | live, Amsterdam z14 | pad 0.16° | **pad 0.02°** |
  |---|---|---|
  | pages fetched | 6 635 · 434.8 MB | **2 627 · 172.2 MB** |
  | used | 34.9% | **79.0%** |
  | view hit rate | 91.6% | 81.3% |
  | to the view | **0.70× (slower)** | **1.23× / 1.31×** |
  | to a settled session | 1.04× | **1.31× / 1.42×** |

  Ten points of hit rate bought a 2.5× cut in bytes and turned a regression into a win. The pad is not a
  constant anyone should tune without re-running BOTH columns.

### With the link modelled honestly

`cdp_prefetch_wired.mjs` now emulates **throughput as well as latency** (`Network.emulateNetworkConditions`,
defaulting to this box's measured 82 Mbps / 45 ms), and the server-side latency injection is off so the two
do not double-count:

```
82 Mbps · 45 ms, Luxembourg z14, dedup on, pad 0.02°
  A  26.5 s to the view ·  99.7 s to settled · 113.2 MB
  B  14.0 s to the view ·  68.2 s to settled · 113.2 MB + 52.5 MB prefetched (88.6% of it used)
  ⇒ 1.89× to the view, 1.46× to a settled session, identical map
```

**And live, on the deployed app: 1.10–1.31× to the view and 1.20–1.42× to a settled session**, n=3, B
ahead every time. Not the 2.29× this was first shipped with. The smaller number is the one that describes
a user.

⚠ **Only the RATIO is comparable across live runs.** The unprefetched arm measured 11.6, 12.3, 33.0 and
35.0 s for the same camera on the same afternoon — the link and the CDN's state move by 3× — so an
absolute live number means nothing without its pair, and a single arm proves nothing at all. What IS
stable is the counts: **2 627 pages, 172.2 MB, 79.0% used, 81.3% view hit rate**, identical on every run.

**Both halves of §5.3 are gated now.** The hit rate alone cannot fail an over-fetch — a prefetch that
pulls ten screens scores perfectly on it — so `prefetch_gate` asserts the inverse as well: **of the pages
FETCHED, at least 60% must be read.** That is the assertion that would have caught this on the first run.

### §12b. The ring's misses were RETENTION, and the design said so before the code did

With the pad fixed, 722 of a Luxembourg session's reads still missed the buffer. Splitting them by cause —
which needed a counter, because the two causes take **opposite** fixes — settled it in one run:

```
663 were fetched and then DRAINED   ← a retention failure: raise/keep, do not re-buy
 59 were never named                ← an index failure: widen the query
```

**§9 predicted exactly this**: *"an index that makes pages findable does nothing if the pages are DROPPED
on every scale change… the index makes the refetch cheap, retention makes it unnecessary."* It was written
about scale changes; the same defect was one screen away, between a view and the ring behind it.

The buffer drained to bound memory (§5.4). **A cap does that directly**, so pages are RETAINED to
`PFCAP` (64 MB) and the oldest are evicted past it. Two things fall out for free:

* ⚠ **"Do we hold it" and "have we PAID for it" are two questions, and merging them cost a live
  regression.** Retention was first shipped with the `fetchedOnce` record deleted, on the reasoning that
  the bag now answers both. **Eviction makes the bag forget, and the wire does not.** On Amsterdam — whose
  working set is far over the cap — every eviction made a page buyable again and the session thrashed:
  **5 520 pages / 361.8 MB fetched for 2 627 distinct pages / 172.2 MB**, and a *settle* of **0.90×**,
  slower than no prefetch at all. Both records are kept now: a page is bought **at most once per
  session**, and if the cap evicted it the read simply falls through — one round trip, not a second
  purchase. Forced to an 8 MB cap the bytes hold at 801 pages / 52.5 MB (from 2 921 / 191.4 MB) and the
  result degrades to ~neutral rather than to a loss.
* **A retained page answers more than one read**, so the waste ratio is now *reads per page fetched* and
  legitimately exceeds 1.0. It printed **171.4%** before the label was fixed, which is how the change
  announced itself.

| Luxembourg z14, 82 Mbps · 45 ms | drained | **retained (64 MB)** |
|---|---|---|
| misses | 722 | **59** — all of them "never named" |
| session hit rate | 49.6% | **95.9%** |
| view hit rate | 76.5% | **91.1%** |
| reads per page fetched | 0.89 | **1.71** |
| to the view | 1.89× | **2.41×** |
| to a settled session | 1.46× | **3.22×** |
| peak buffer | — | 52.5 MB, 0 evictions |

### The cap, swept — and it follows the DEVICE

`PFCAP` started at a flat 64 MB. Sweeping it (`window.__prefetchCap`, injectable into the deployed page,
so no guess had to be shipped to learn this) says the cap is worth real time *and* real memory:

| live, Amsterdam z14 · working set 172.2 MB | cap 64 MB | **cap 128 MB** |
|---|---|---|
| to the view | 1.19× | **1.71×** |
| to a settled session | 1.48× | **2.41×** |
| misses that were EVICTED | 777 | **168** |
| reads per page fetched | 0.72 | **0.96** |
| JS heap | 239.9 MB | 294.9 MB |
| wasm, either way | 202.6 MB | 202.6 MB |

**+55 MB of heap on a ~440 MB tab bought 1.48× → 2.41×.** Neither free nor negligible — and on a 2 GB
phone that same 55 MB is the difference between running and being killed. So the cap is
**`clamp(navigator.deviceMemory × 16 MB, 32 MB, 128 MB)`**: 32 MB on a 2 GB phone, 64 MB on a 4 GB one,
128 MB at 8 GB and above, with a conservative 4 GB assumed where the browser does not say.

And the local curve is what makes that extrapolation legitimate rather than a hope: returns flatten at
**~0.9× the session's distinct prefetch bytes**, and Amsterdam at 64 MB is 0.37× pressure, which the curve
put at ~1.5× settle before it was measured at 1.48×.

**Live, deployed, Amsterdam z14 — the camera that evicts:**

```
  A  prefetch off   33.4 s to the view · 89.4 s to settled · 204.1 MB
  B  prefetch on    28.4 s to the view · 57.8 s to settled
     2 627 pages / 172.2 MB fetched (bounded: exactly the distinct pages)
     1 603 evicted · 0.74 reads per page · 83.9% view hit rate · identical map
  ⇒ 1.18× to the view, 1.55× to a settled session
```

The settle figure is the one retention moved: **1.40× before it, 0.90× with it and re-buying, 1.55× with
it and not.** ⚠ And the miss split names the next knob without guessing — **650 of the misses were
EVICTED** (the cap is under Amsterdam's working set) against 379 never named (the pad). Raising the cap
would buy those 650, at the price of more JS memory beside wasm on a phone; the buffer already peaks at
68.7 MB. That is a trade to measure on the target device, not to assume here.

⚠ **Eviction is exercised on purpose** (`window.__prefetchCap`), because a camera that fits under the cap
never runs that path and untested eviction is how a buffer starts serving pages it no longer holds. Forced
to 8 MB: 2 793 pages evicted, peak 9.2 MB, **the map byte-identical**, and the gate FAILS its quality
floors while naming the knob — `1015 were EVICTED by the cap (raise it)`. Degradation, not breakage.

⚠ **And the sweep found two defects that only eviction can show**, neither visible at a cap the session
fits inside:

* **Eviction took pages out of the IN-FLIGHT batch.** Oldest-first targets the pages that arrived first,
  which during a large batch is that same batch — so the view paid for pages thrown away before it could
  read them. At a 16 MB cap the view was **0.82×, slower than not prefetching at all**; exempting the
  filling batch made it **1.51×**. When one batch exceeds the cap, the cap is exceeded until it is
  consumed, and the peak reports that rather than hiding it.
* **A retained page pinned its whole fetch.** Pages were `subarray`s, which share the parent ArrayBuffer —
  up to 24 pages per coalesced range — so evicting one page of a run freed *nothing* and the cap bounded a
  number that was not the memory. Copied on store now, one 64 kB copy against the round trip that fetched
  it. This is also why the gate reports the tab's OWN heap: our accounting said 52.5 MB while the heap
  knew better.

### The rule this leaves behind

*An emulator that models one cost and not the other does not measure a trade-off — it picks a winner.*
The harness modelled the cost prefetching REMOVES (round trips) and not the cost it ADDS (bytes), so no
result it produced could have argued against prefetching more. Same family as the ranged-HEAD trap and the
missing `MemorySwapMax=0`: the instrument answered the question next to the one being asked.

---

### And the framing that has not changed

**This is a latency fix, not a bytes fix.** It moves nothing about the ~1 000 sessions/month that GitHub
Pages' 100 GB bandwidth ceiling allows (`docs/hosting-cost-model.md`). That ceiling remains the constraint
that actually caps the product, and the R2 decision is the one that lifts it.
