<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->

# What a frame costs, and how it got cheap

**Kind:** reference · **Status:** current · **Last verified:** 2026-08-03 · **Owns:** what the render path does per frame — the render budget, the growing line, the split, the raster cache

`PLAN-PERF` §6, §6b(2), §6c and §6d. The frame itself: the render budget, the route line that grows
as it is matched, where the JS/loft split actually belonged (not where steps 14–15 first put it),
and the block raster cache. ⚠ **The raster cache CANNOT be pixel-identical** — that is inherent,
not a shortcut, and §6d says why.

⚠ **Section numbers are global to `PLAN-PERF.md`** — they were not renumbered when this file was split out, so a citation of `PLAN-PERF` §7g still resolves. Its *Where each section lives* table says which file holds which §. **`PLAN-PERF` §0 is still the step list, and §1 the invariant every step is judged against.**

---

## 6. Phase R — the render budget

> **A Web Worker was here, and it was wrong.** An earlier draft proposed moving the kernel to a worker to
> unfreeze the page. That is loft's *rejected* model wearing a thread: it solves the freeze by routing
> around the yield contract instead of using it. **S's gather loop already unfreezes the page** —
> `frame_yield()` hands the frame back, *"so the engine keeps rendering and taking input while the library
> waits."* Deleted rather than demoted, because keeping it would have had us build a worker to fix a
> problem loft solved. *(It flips only if a wait genuinely cannot yield — e.g. a single un-splittable
> compute longer than a frame. Then the fix is to yield **inside** the compute, not to move it.)*

What is left is real and independent of loft: **`render` is 76 ms/frame on a phone ⇒ ~13 fps panning
with no kernel call at all.** Panning is laggy on its own.

**Invariant:** *a frame redraws only what the camera changed.*

| step | change | verify |
|---|---|---|
| R1 | Pre-project geometry into typed arrays once per view, not per frame. | render drops; pan frame time falls |
| R2 | Cache per-tile rasters; blit on pan, re-raster only newly-exposed tiles. | pan holds <16 ms/frame |

Same invariant as §1 — *work ∝ change* — applied to the frame. R is independent of S/A/C and can land
any time.

---

## 6b(2). The growing line — was EMITTED but not RENDERED; **DELIVERED 2026-07-22**

**The gap this section recorded is closed.** Kept in full because the *shape* of the mistake is the
reusable part: an emit that nothing consumes reads exactly like a delivered feature from the loft side,
and only a gate on the *consumer* tells them apart.

**What was wrong.** The kernel half shipped in step 16 and worked: each `SubPath` is emitted as
`STRETCH i;…` the moment it is matched, with a `frame_yield()` between, and that is what turned a
40-point route's worst frozen gap from **11095 ms into 384 ms**. But `runKernel(blob)` resolved a single
promise on `#EOR`, so JS received the *whole* response at once and `map.loadMatch(text)` drew only the
final `ROUTE`. Nothing in `map.mjs` or `store-kernel.mjs` read a `STRETCH` line — only the profiler
counted them. The yields delivered **responsiveness** (the page kept painting), not **progressive
arrival** (a line that grows). §6b's "it mimics the journey" and DESIGN §5's travel-order requirement are
claims about what the *user sees*, and the user saw nothing until the match completed.

**What delivers it** (two commits, driver then renderer):

1. `runKernel(blob, lineSink)` — an **opt-in** sink drained at each `frame_yield()`, in a **microtask**.
   The microtask is the load-bearing detail: it runs after the asyncify unwind returns to the event loop
   but *before* the browser paints, so a stretch drawn there lands in the very frame the yield handed
   back. Draining inside the import would run the sink mid-unwind; draining in the `setTimeout` wake
   would put it after the paint. Opt-in keeps the `view` path (~400 KB per response) paying nothing, so
   the driver's "never scan per print" rule survives — the scan is per YIELD, not per print.
2. `map.parseStretch` + `beginStretches`/`applyStretch`, with the click handler and `window.__match` both
   routed through one `streamedMatch()`.

**The index in `STRETCH <i>` is not decoration.** A warm edit replays *every* stretch, cached ones
included (`update_state` calls `on_stretch` on the reuse branch too), so a slot — not an append — is what
makes a re-match redraw instead of concatenating onto the previous route.

**Two rendering decisions, both consequences of §1:**
- **Work ∝ the route, not the map.** A full `render()` per stretch redraws every area, building, road and
  label — ~74 ms at `CPU_THROTTLE=4`, 39× on a real sketch — for a line that grew by ~50 points.
  `applyStretch` strokes the polyline onto the existing canvas and leaves `route` authoritative, so any
  later full render (a pan, the final `loadMatch`) still draws it correctly and at the proper z-order.
- **Re-stroke the accumulation, not the new piece.** The route is a white halo *under* a blue core, so
  stroking one stretch alone paints its halo over the previous stretch's core and leaves a **white notch
  at every joint**. Stroking the accumulation has no seam. Two transients are accepted for it: the halo
  composites toward opaque after ~3 stretches (85% when re-rendered), and a streaming stretch sits above
  the labels. Both end at the final render.

### The gate is three assertions, and none of them is a timing

Counts and exact equalities only, so a loaded machine cannot move them either way:

| assertion | what it kills |
|---|---|
| `deliveries >= stretches` | a buffered response delivers **once** however many stretches it carries — this is unreachable unless each stretch crossed into JS mid-match |
| `growSteps >= 2` on the **app's own** `streamedMatch` | a regression that reverts the app to "draw once at `#EOR`" while leaving the driver *able* to stream |
| the final ROUTE is an in-order **subsequence** of the streamed line | the growing line drawing a path the route never took |

**Containment is the load-bearing one, and point counts could not have replaced it.** loft stitches the
same sub-paths with `push_pt` and then `remove_spurs`, and both only ever DROP points — so the finished
route is *shorter than the stream by construction* and "same length" would be the wrong assertion.
Every ROUTE point appearing in the stream, in order, is the exact statement that survives that.

### ⚠ What the gate then surfaced: `remove_spurs` prunes ~60% of the raw stitch

Measured on the gate's own sketches: **537 streamed → 198 final** (10-point) and **431 → 213** (3-point).
So the growing line carries roughly 2–2.7× the points of the route it becomes, and **visibly tightens
when the match completes** — the excursions the user watched being drawn are pruned at the end.

This is **pre-existing matcher behaviour, not introduced by the streaming** — it was simply never visible
before, because nobody ever saw the pre-`remove_spurs` stitch. Two things follow, neither urgent:
- the delivered feature is honest but not seamless, and that is now documented rather than discovered by
  a user;
- a per-stretch assembly that doubles back over half its points is a **match-quality signal** worth a
  look (PLAN-MATCH §7's numbers are computed per stretch during assembly, so they see the pre-pruned
  path). Not a defect proven here — a number that did not have a reader until now.

## 6c. Steps 14–15: the split was in the wrong place (2026-07-22)

Step 14 said *"pre-project geometry into typed arrays once per view, not per frame."* Half of that was
right. The half that was wrong is the half that mattered, and the measurement is what said so.

### What a frame was actually doing

| | measured, app's own viewport |
|---|---|
| vertices projected per frame | **214,455**, to draw ~7,000 features |
| buildings drawn / loaded | **1,895 / 16,646** — ~89% of the projection discarded |
| projection as a share of the frame | **82%** (52 ms of 64 at `CPU_THROTTLE=4`) |
| JS objects retained between frames | **239,135** |
| JS heap retained | **33.3 MB** |
| the same geometry, flat | **1.64 MB** (`Int32Array` at deg×1e7) |

Two independent faults, on **orthogonal axes** — which is why fixing one did not hide the other:
**how many** features are touched (culling), and **what it costs to touch one** (layout).

### 14a — screen before projecting

Every draw loop projected a feature's whole ring and only then asked `_inView`. A per-feature lat/lon
bbox, built once per layer, screens first. Pixel-identical because `_inView` keeps a feature iff some
VERTEX is in the padded viewport, and the screen is that same rectangle unprojected — so it is a
conservative **superset** and can only skip work already discarded.

⚠ **For areas the bbox test is the only CORRECT cull**, not merely the cheaper one. Areas are filled and
deliberately had no cull: a polygon containing the whole viewport has no vertex on screen yet paints
every pixel of it. Culling areas by `_inView` would erase lakes and forests exactly when zoomed inside
one. Containment implies bbox overlap, so bounds keep them.

### 14b — the split: JS was COPYING the store out

`viewFromStore` re-materialised a viewport as JS objects — `readLoftValue` turning every struct into an
object, `degRing` exploding every vertex into a boxed `[lat, lon]`. The `expose` bridge exists so JS can
*read* the store; copying it out gave that back and cost 33 MB and a quarter-million GC-traced objects.

**Converting those objects to typed arrays would have been the wrong fix** — still a copy, just a cheaper
one. The store already holds the ideal layout, and the probe proves it rather than assuming it:

```
Coord: kind=record, size=8, fields x@0 (int), y@4 (int)
a 74-coord ring read as Int32Array(mem.buffer, base, 74*2) vs loft's own reader: 0 mismatches
```

loft-deliver stores struct vector elements **inline** at `storeBase + vRec*8 + 8`, stride `sizeOf(elem)`,
so **a `vector<Coord>` IS an interleaved `Int32Array`**. `browser/store-geom.mjs` therefore builds a
per-view *index* — per feature: ring record, length, tile origin, fixed-point bounds, ~37 bytes — and each
frame derives one `Int32Array` over wasm memory and reads coordinates where loft wrote them.

### The numbers

Quiet box (load 1.03), `CPU_THROTTLE=4`, medians of 6, spreads 1.1–1.5×:

| | before | after | |
|---|---|---|---|
| **view total** | 277 ms | **126 ms** | 2.2× |
| **storeRead** | 129 ms | **29 ms** | 4.4× — *no copy, not a faster copy* |
| **render** (view) | 73 ms | **26 ms** | 2.8× |
| **pan frame** | 64 ms | **20 ms** | 3.2× |
| **projection's share of a frame** | 82% (52 ms) | **4% (1 ms)** | over 3,170 vertices, not 214,455 |
| retained vertices | 214,455 | **3,170** | −98.5% |
| retained objects | 239,135 | **4,609** | −98.1% |
| JS heap | 33.3 MB | **24.6 MB** | −8.7 MB |

The heap did not fall by 30 MB because 33.3 MB was never all geometry — the rest is kernel buffers, the
view text, the descriptor and Chrome's own overhead. The 7.9 MB that went is ~38 bytes per boxed pair,
which is what V8's packed-double representation costs.

### Streets: the one layer that CANNOT come from the store — and got the same treatment anyway

`streets` arrive as roads **text**, and they have to. The matcher **iterates** the roads store
(`corridor_ways_impl2`'s `for t in store`, whose own comment notes keyed lookup is unreliable on a
mmap-reloaded store), and loft cannot iterate a store JS has pinned (§7d(2)). Exposing roads would need a
`release`/`expose` bracket around every match at **~230 ms per expose** (§7f) against a 644 ms warm match.
**That path is dead** until loft can either iterate a pinned store or cache the flattening — both already
filed in `docs/loft-feedback.md`.

But nothing forced the PARSE to box them. `parseStreetsFlat` reads the same text into one growable
`Float64Array` plus an offset column, interned class indices, and per-road bounds. Coordinates stay `+str`
doubles in DEGREES — deliberately never converted to fixed point, because the object path fed exactly
those doubles to `project()` and re-rounding would surface as antialiasing drift under a pixel hash.

`_drawStreetsFlat` also removes garbage the object path created for its own convenience: `drawStreets`
projected into a fresh `px` array of point objects **per visible road per frame** — ~1,077 arrays and
~19k objects — purely so the class-bucket pass could re-read them. One shared scratch with recorded
offsets replaces it, and an off-screen road rewinds the write cursor instead of allocating.

**What is left boxed** is `places` (2) + `streetLabels` (1,439) — 3,170 vertices that feed
`layoutLabels`' collision pass, a separate piece of work.

### Three places where "the same pixels" needed care, not confidence

- **Draw order.** Areas overdraw each other, so the index must push them in the same tile-then-element
  order `viewFromStore` did, or a different polygon lands on top with every count still matching.
- **`areaMinZoom`.** Recomputed from the stored bounds, converted to degrees BEFORE subtracting:
  `(a-b)/1e7` and `a/1e7-b/1e7` are different doubles, and an area on a band threshold would flip bands.
- **The fixed-point screen is scaled, not rounded outward.** Flooring would make it a larger rectangle
  than `_screen`; the paths would then disagree about features within 1e-7° of the padded edge — invisible
  in pixels (>60 px off-screen) but visible in the draw counts the gate compares.

### The gate is the pixels, and it outlived the path it was comparing

`storeRenderParity()` renders the same view twice — index off, index on — and compares an FNV-1a hash of
the raw canvas bytes. Counts cannot settle it: **a ring read at a wrong offset yields plausible integers
and a plausible count**, and only the pixels show it drew somewhere else. When the object path was
deleted from the app, the probe was changed to rebuild it **on demand** for its one call, so the gate
survives the deletion it licensed.

⚠ **`memory.grow` DETACHES the ArrayBuffer** and the kernel grows memory while matching, so the view is
re-derived every frame and the memory is held as a *function*, never a buffer. A cached `Int32Array`
would read length 0 and the map would go blank after the first match.

### And two more instrument bugs, both in `timedView`, both the same class

It happened **twice in one session**, which makes it a pattern rather than an accident: `timedView`
mirrors `ensureView`, and each time the app's layer wiring moved, the probe kept measuring the old one —
first still materialising all `STORE_KINDS`, then still calling `loadView` (boxed streets) after the app
moved to `loadRoadsFlat`. It reported *"5 ms over 22,567 vertices"* for geometry **it had created itself**.

Neither failed. Neither looked wrong on its own. **Both were caught only because two probes contradicted
each other** — `layerFootprint` reporting what the app retains against `projectionCost` reporting what it
walks. *A probe that MIRRORS an app path rots silently when that path moves; the defence is a second probe
that measures the same thing a different way, so a divergence has somewhere to show up.*

The first of the pair:
`timedView` kept materialising all `STORE_KINDS` after the app stopped — so it timed a view the app never
performs and silently re-populated `map.areas/buildings/…` behind the app's back. Caught only because two
probes contradicted each other: `layerFootprint` said 0 retained features while `projectionCost` said
214,455 vertices. **Its own comment warned about exactly this**; the comment stayed true while the code
went stale against the app it mirrors. *A probe that mirrors the app must be re-synced when the app moves
— and the way you find out is by making two probes disagree.*

## 6d. Step 15 — the block raster cache: LANDED and ON (2026-07-22)

⚠ **Its bounded delta was re-baselined 2026-07-30, and the rule did not change.** The gate is three
equalities plus a bound on how far the block-cached render may differ from a direct one — a bound that is
a property of the DATA, because denser geometry puts more pixels on the snapped-origin boundary:

| dataset | roads in view | pixels differing | max delta | bound |
|---|---|---|---|---|
| Enschede block | 3,112 | 1.47% | 15 | 16 |
| **Netherlands block** (PLAN-SCALE C2) | 4,197 | **1.51%** | **25** | **26** |

Measured three times, identical each run — deterministic rounding, not noise, so the margin stays at one
point. **The AREA barely moved while the peak nearly doubled**, which is the signature of §6d's mechanism
(more thin lines on the boundary) and not of a rendering defect, which would have moved the area too.
`BLOCK_DELTA_MAX` in `cdp_verify_store.mjs` carries that reasoning; raise it only with a measurement.

**Status: enabled.** `map.blocked = true`. Every gate green.

| | before | after |
|---|---|---|
| **pan frame** (cache warm) | 20 ms | **0.6 ms** |
| **view total** | 126 ms | **146 ms** (+20 ms: one bake, which starts warming the cache) |
| cache settle after a data change | — | 7 frames, worst 66 ms |

### The prize, and the trap next to it

A warm pan frame is **0.6 ms** against 20 ms. But the first version baked every block a viewport needs in
ONE frame, and that made `view` **26 → 387 ms** (total 126 → 509) — a **4× regression on a user-visible
interaction**, spent to make the frames after it free. Caught only by profiling after enabling; the gates
were all green, because it was a cost regression, not a correctness one. §0's rule 5 in action: *the step
moved a number it was not supposed to move.*

**Bakes are amortised.** A frame bakes at most `BLOCK_BAKES_PER_FRAME` blocks; while the cache cannot yet
cover the viewport the frame is drawn DIRECTLY — from the **same snapped origin** the blocks use, so the
image does not jump by a device pixel when the cache takes over — and asks for another frame. A view pays
one bake (+20 ms) and every pan frame after costs 0.6 ms.

*An amortised cache's number is not its total: it is FRAMES TO SETTLE and the WORST single frame on the
way there, because that is what a user feels.* The gate reports both.

### Why it CANNOT be pixel-identical — inherent, not a shortcut

Canvas rasterisation depends on a path's **sub-pixel phase**. A block fixes that phase when it is baked;
the viewport origin (`cameraWorld - width/2`) is fractional and moves continuously. Blitting at the true
fractional offset resamples the block — a blurred map on every pan. Blitting at a rounded offset shifts by
up to one device pixel. Every tile renderer meets this and all of them snap.

**Measured: the snap alone changes 261,499 of 557,000 pixels.** So the gate cannot be "equals the current
render". It has to compare blocked against a **direct render at the same snapped origin**
(`renderSnappedDirect`), which separates *does the cache change anything* from *does the snap change
anything*. Conflating those is how a raster cache ships with a seam nobody notices.

Deliberately **not** snapped: `project`/`unproject`. They stay exact, so `map.test.mjs`'s pan/zoom
anchoring invariants are untouched — the snap is a RENDERING decision, not a projection one.

### Four couplings found and fixed — none of them about rasterisation

1. **Origin split.** The route and labels drew from the camera origin while the base came from the snapped
   one, putting the map a sub-pixel under the things drawn on top of it.
2. **`_inView` is a VERTEX test, and is invalid as a per-block cull.** A road crossing a block with no
   vertex inside it is drawn by the direct render and dropped by that block's bake. Exactly the class of
   error that made a bbox test mandatory for filled areas (§6c).
3. **Label anchors were screen-space**, so each block's were relative to that block's corner. Now recorded
   in WORLD pixels and claimed by the single block whose interior contains them.
4. **`fits` is greedy first-come**, so label ORDER decides which labels win a contested spot — and blocked
   collects block-by-block where direct collects in index order. Now sorted by feature index.

### The 10.7% — found, and it was three unrelated things

Bisected, not guessed. `59,704 -> 8,191` differing pixels, and the remainder is proven irreducible.

| | px | what it was |
|---|---|---|
| **1. origin key mismatch** | **35,424** | `renderBlocked` returned `{ox, oy}`; `_origin` is read as `.x`/`.y`. Every overlay projection in a blocked frame was **NaN**, so labels and the route silently vanished. All three label passes now diff 0. |
| **2. POI edge cull** | ~1,600 (maxDelta 178 → 68) | A **latent bug in the DIRECT renderer**, not the cache. |
| **3. canvas-size rounding** | **8,191**, every one ±1..15 | A **platform property**. Not fixable. |

**#2 is a real app fix and it is worth stating on its own.** A POI glyph is drawn from its CENTRE, but
the cull tested the bare viewport rect — so a marker just off-screen vanished instead of half-showing.
A block extends past the viewport, so the blocked path drew them and was **more correct than the app**.
`POI_EDGE_PAD` (largest radius 4.5 + halo → 8) fixes it, and it is why the canvas hash moved
`c85280c8 → 917244eb`.

**#3 is why step 15's gate can never be equality**, and it was established by experiment rather than
assumed. `offscreenRoundTrip(pad)` changes ONLY the canvas geometry, with every feature keeping its
sub-pixel phase:

```
pad 0   (canvas identical to the viewport)      → diff 0        ← an offscreen round-trip IS exact
pad 32  (canvas 64 px larger, origin shifted)   → diff 5,026, maxDelta 15
```

Chromium's canvas rasterisation is **not invariant to canvas dimensions**. A bleed margin necessarily
changes them, so **no raster cache of this design can be pixel-identical** — the residual is antialiasing
rounding on feature edges, ±1 in a channel.

### A cache bug the bisect could not see

Building-label anchors are produced only by a **bake**, so a fully-cached frame reset the list and never
refilled it — every building label would have vanished on the second frame of a pan. The bisect cleared
the cache on every run, so it structurally could not observe this. Anchors are now cached with their
block, and `coldVsWarm == 0` asserts it. *A probe that always starts cold cannot test a cache.*

### The gate: two equalities and one bound

```
✓ block cache: cached==baked, labels exact, vs snapped-direct 1.47% of px at
  maxDelta 15 (canvas-size rounding) · pan 0.9ms warm / 91.3ms cold, 6 blocks
```

- **cached == freshly baked** — exact. The cache's own correctness.
- **every label pass** — exact. Structural; this is what caught #1.
- **vs snapped-direct** — *bounded*: a small per-channel delta is what "no structural difference" looks
  like once #3 is understood. A `maxDelta > 16` means something real broke.

### Three things it needed before it could be ON, and two gates that were lying

- **Invalidation.** A block is baked from whatever features were loaded, and the store index is built for
  ONE viewport window — so a block baked before a data load can be missing features that window did not
  include. **A stale raster is a failure that looks like a correct map.** `loadView`/`loadRoadsFlat`/
  `setStoreIndex` now invalidate.
- **A byte budget, not a block count.** A block is `(512+64)² × dpr² × 4` bytes, so a phone at dpr 3
  stores 9× what this desktop does — a fixed cap of 24 would have been a ~250 MB cache there. Capped at
  48 MB, minimum 4 blocks.
- **DOM-free degradation.** `map.test.mjs` drives the renderer against a stub canvas on purpose, so
  `render()` falls back to the direct path when there is no `document` or no `drawImage`.

And two gates that would have passed **vacuously** — both found by trying to make them fail:

- `storeRenderParity` toggles `_sidx` and re-renders. With blocking on, both renders blit the **same
  cached blocks** and agree no matter what: it would have been comparing a cache against itself. It now
  drives the direct path. (Its hash returning to `917244eb` is how the fix was confirmed.)
- The staleness check first reloaded the **same** text, which leaves stale blocks correct — so it passed
  with invalidation deliberately disabled. It now loads an EMPTY road set: **93,080 stale px without
  invalidation, 0 with.**

*A gate that cannot fail is worse than no gate, because it reads as evidence.*

### The method note, which is the reusable part

`renderDiff`'s per-layer and per-label bisect found #1 **in one run**, after four blind fixes had found
nothing — and **two of those four changed literally zero pixels**. *When a comparison fails and you
cannot say WHERE, stop fixing and build the instrument that localises it.* A hash is a smoke alarm: it
tells you there is a fire, and nothing about which room.
