<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# The prefetch index — turning 764 round trips into one batch

**Status: design + measured evidence. Nothing is built.** Written before the code, because the failure
paths are where the invariant surfaces (`design-protocol`), and because this is an exact-invariant
domain — byte ranges, caching, round trips — where the construction has to be *recovered from a
capture*, not argued from the desk.

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
