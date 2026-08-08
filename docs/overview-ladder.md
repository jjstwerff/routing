<!--
Copyright (c) 2026 Jurjen Stellingwerff
SPDX-License-Identifier: LGPL-3.0-or-later
-->

# The overview ladder — opening the app on a whole country

**Kind:** reference · **Status:** current · **Last verified:** 2026-08-04 · **Owns:** what it takes to open the app zoomed out on a whole country, and the level ladder that makes it cheap

`PLAN-SCALE` §6i. What has to be true for a bare visit to draw a whole country in under a second —
the unit of cost, the decimation rule, the level ladder, and the four rungs O0–O3 that built it.
⚠ **The unit of cost is the KEY, not the feature**, and that inverts the obvious design.

⚠ **Section numbers are global to `PLAN-SCALE.md`** — they were not renumbered when this file was split out, so a citation of `PLAN-SCALE` §6e still resolves. Its *Where each section lives* table says which file holds which §.

---

### 6i. THE OVERVIEW LADDER — what it takes to open the app on the Netherlands (2026-08-02)

The app opens on Enschede at z16 because that is the only camera it can afford. Everything below is the
design for opening it on the *country*, and the reason it is a design rather than a setting: **the read
path has no zoom.** `viewCmd` sends base/roads/cmd/**bbox**/mode, and `layout_cell_keys` enumerates all
four tiers over that box unconditionally, so a view costs what its GROUND AREA costs and nothing tells it
that a building is invisible at z10. Measured on the deployed site (headless 1000×700, cold, cache off,
`CPU_THROTTLE=4`, medians of 3 at 1.05× spread):

| camera | block | first view | bytes | features drawn |
|---|---|---|---|---|
| Enschede z16 — today's default | `enschede`, whole | **1.64 s** | 10.7 MB | 26 630 |
| Amsterdam z16 | `nl-midwest`, paged, 297 reads | **6.31 s** | 18.4 MB | 22 479 |
| Amsterdam z15 | 761 reads | 11.9 s | 47.4 MB | 78 751 |
| Amsterdam z14 | 1675 reads | 26.9 s | 104.6 MB | 252 373 |

A whole-NL screen (z≈8.6, padded 0.6) enumerates **~1.1 M layout keys + 70 k road keys**. There is no
setting that survives that.

#### ⚠ THE UNIT OF COST IS THE KEY, NOT THE FEATURE — and it inverts the design

This is the measurement everything else follows from, and it is the opposite of the intuition that a
zoomed-out map is expensive because it holds more stuff. Two same-sized windows on `nl-midwest`, both read
the way the app reads (`tools/base_key_probe.loft`):

| window | keys | tiles | features | bytes |
|---|---|---|---|---|
| Amsterdam centre | 69 | 67 | 39 646 | 14.2 MB |
| IJsselmeer (open water) | 69 | 68 | **6 107** | **17.7 MB** |

**6.5× fewer features for MORE bytes.** A key costs pages whether or not it holds anything, and a z16
window pays 14.2 MB for ~4 MB of content. So the bill is **asking**, not receiving.

⚠ **A FIRST READING OF THIS WAS WRONG, AND IT REACHED A PLAN AND A PR BEFORE IT WAS CHECKED.** It said
*"~3 × 64 kB pages per key, and asking for more keys does not amortise it — a directory descent per key"*,
from three reads that differed in more than one variable at once. Reading loft's loader and controlling
the variables says otherwise on all three counts:

* **the descent is already shared** — `load_keys` (`src/database/allocation.rs`) builds ONE `PagedReader`
  for the whole call and loops `load_one`;
* **there is already a page cache** — 64 KiB pages, a 64-page (4 MiB) LRU;
* **it does amortise.** On a dense contiguous single-tier read, pages/key FALLS with batch size:
  **4 → 3.00 · 9 → 3.11 · 20 → 2.45 · 48 → 2.35 · 140 → 2.04.**

What actually drives the cost is LOCALITY and HIT RATE, measured at one tier with the window size held
constant (`tools/zoom_bin_probe.loft`, and `tools/cell_hole_probe.loft` to find the in-extent holes):

| window | loaded / asked | pages per key |
|---|---|---|
| dense city | 4/4 | **3.00** |
| sparse ground (open water) | 20/20 | 4.50 |
| **in-extent hole** — data on all four sides | 0/9 | **4.22 and 6.22** |
| out-of-extent | 0/4 | 7.50 |

So a miss costs **~1.4–2× a hit in extent**, not the ~4× an out-of-extent probe suggests, and the
per-key figure to design against is **~2–3 pages (130–200 kB) for a clustered read**, rising with
scatter. The earlier 3.1–4.8 figures came from reads spanning FOUR TIERS — different regions of the
file — which is scatter, not batch size.

Two consequences, both load-bearing below:
* **Below the zoom where detail is drawn, a whole-file read of a generalised block beats a keyed read of
  the detailed one.** A 25 MB overview downloaded once is cheaper than 128 keys.
* **A pyramid cannot have many levels.** Every level costs ≥4 keys per view even when it holds nothing —
  ~800 kB. A level-per-zoom ladder is a 16 MB floor on every view; ~4 levels is the ceiling.

#### Three designs this killed. Do not re-open them without new evidence

1. **⛔ "Make the reader zoom-aware over the existing tiers"** — no data change, just skip the fine tiers
   when zoomed out. **Falsified**: of the features a z12 Amsterdam viewport should draw, **73% sit in
   tier 0** (1452 of 1997 — every place label, canal and railway). The tier is a SIZE bin; a city name is a
   point and sits at the finest tier. Skipping fine tiers gives polygons with no cities.
   `tools/zoom_bin_probe.loft` is the cross-tab.
2. **⛔ A level-per-zoom pyramid** — killed by the per-key floor above.
3. **⛔ "Selection is the shrink"** — see below; it is the *plateau*, not the lever.

#### Selection is not the lever. DECIMATION is — and that reconciles §6h's 75/94 MB

§6h measured an overview tier (no buildings, no POIs, big areas simplified, place labels) at **75 MB west /
94 MB east** and shelved it as "a different, thinner map". That number is right and it is exactly what
SELECTION ALONE buys, because the features a low zoom keeps are the *huge* ones: on the Amsterdam window
(39 646 features, 532 160 coords), keeping only debut ≤ z12 keeps **4% of the features and 45% of the
coordinates**. One coastline is one feature and forty thousand vertices.

Adding the second rule — drop every vertex nearer than **one pixel at the level's own zoom** to the chord
it sits on (Douglas–Peucker) — is what actually shrinks it. Measured, same window
(`tools/overview_size_probe.loft`):

| level | features kept | coords kept | after 1-px decimation | of ALL coords |
|---|---|---|---|---|
| z ≤ 8 | 319 (0.8%) | 215 880 (40%) | **2 333** | 0.44% |
| z ≤ 10 | 319 (0.8%) | 215 880 (40%) | **6 504** | 1.2% |
| z ≤ 11 | 493 (1.2%) | 224 601 (42%) | **12 387** | 2.3% |
| z ≤ 12 | 1 826 (4.6%) | 239 886 (45%) | **24 069** | 4.5% |
| z ≤ 13 | 7 304 (18%) | 265 183 (49%) | **43 163** | 8.1% |

Read the columns, not the rows: **selection is flat in coordinates (40–49% at every level) and decimation
is ~2× per zoom level.** The handover zoom is therefore the *only* size knob, and it costs a factor of two
per level.

#### ✅ O0 ANSWERED — the country measured in one pass, and the handover is z10 (2026-08-02)

The window numbers above are a dense city and cannot be scaled to a country, so O0 walks
`blocks/netherlands.tiered.base.store` once: **80 s, 4.0 GB RSS, 186 211 tiles**, and it sees
**17 290 495 features / 159 329 825 coords** — the feature count is exactly the published country total,
which is the conservation check that says the walk is complete.

| overview | selected features | selected coords | after 1-px decimation | of which areas | **all-in MB** |
|---|---|---|---|---|---|
| **z ≤ 8** | 117 188 (0.68%) | 10 716 825 (6.7%) | **398 385** | 397 178 | **~8 MB** |
| **z ≤ 10** | 117 463 (0.68%) | 10 717 100 (6.7%) | **735 407** | 733 087 | **~11 MB** |
| z ≤ 11 | 714 921 (4.1%) | 30 486 234 (19%) | 4 073 287 | 4 057 679 | ~63 MB |
| z ≤ 12 | 1 348 741 (7.8%) | 43 864 873 (28%) | 8 188 439 | 8 037 459 | ~120 MB |

*All-in* uses this store's own measured rate rather than a guess: 2043 MB / 159.3 Mcoord = **12.8 B per
coordinate**, which at 9.2 coords per feature decomposes into 8 B of geometry + **44 B per feature** of
record, text and index. (§6g's `12.972·Mcoord + 40` fit is not usable here — its +40 MB intercept was
calibrated on 555–775 MB regions and is meaningless at this size.)

**The cliff is at z11, and it is one threshold in one function.** `areaMinZoom` debuts an area at z0 when
its diagonal exceeds 0.008° and at z11 when it exceeds 0.003° — so z11 admits ~600 000 medium polygons at
once: features **117 463 → 714 921 (6.1×)** and decimated coordinates **735 407 → 4 073 287 (5.5×)**. One
zoom level costs 5.7× the file.

**So the handover is z10** — the top of the "big areas only" band, ~11 MB of base, and the last level
before that cliff. z11 at ~63 MB is possible but is a poor first paint; z12 at ~120 MB is not a whole
download.

⚠ **The overview is AREAS, by 99.7%** — 733 087 of 735 407 decimated coordinates at z≤10, against 2 009
for lines and 311 for labels (36 city labels at z≤8, 311 cities+towns at z≤10). Whatever else the design
does, it is a landcover-and-water file with a road spine bolted on.

**And the road spine has to come from the ROADS store** (`tools/spine_size_probe.loft`, whole country):

| class | ways | vertices | km | DP per way @z10 | merged bound @z8 |
|---|---|---|---|---|---|
| motorway | 27 595 | 153 913 | 6 994 | 56 071 | 18 577 |
| trunk + primary | 63 848 | 352 778 | 9 126 | 128 512 | 24 240 |
| secondary | 75 886 | 454 814 | 8 866 | 152 603 | 23 548 |
| tertiary + unclassified | 316 713 | 2 334 221 | 66 436 | 648 629 | 176 458 |

⚠ **Decimation alone buys NOTHING on roads: `DP per way` is exactly 2 × ways** (56 071 for 27 595
motorway ways), because Douglas–Peucker can never drop a way's two endpoints and OSM fragments a motorway
into ~130 m pieces. **Merging consecutive same-class ways into runs is not an optimisation here, it is the
entire road-spine budget** — at z8 it is bounded 3.0× better on motorway and 6.4× on secondary. The
z≤10 spine (motorway + trunk/primary) is **184 583 vertices unmerged ≈ 3 MB**, less once merged.

**⇒ An NL overview at z≤10 is ~11 MB of base + ~3 MB of spine ≈ 14 MB**, against 385 MB of free site
budget. It ships beside the app.

⚠ **The window projection held where it mattered and failed where it did not.** It predicted z≤10 ≲25 MB
(measured ~11) but z≤12 ≲92 MB (measured ~120). A dense-city window over-states the SELECTED share
(45% of coords against the country's 28%) and under-states the DECIMATED share (4.5% against 5.1%) — two
errors in opposite directions, which is why a window is not a scale model of a country and why O0 was a
rung rather than a footnote.

#### ✅ O1 BUILT — `blocks/nl-overview.base.store`, 19.6 MB, 11 seconds (2026-08-02)

`tools/build_overview.loft` reads the country base store and the country roads store and writes an
**ordinary base store holding less** — the same `PTile`, the same tier keying, the same sealed extents, so
every existing reader already understands it. Measured, on 17 290 495 features in:

| | |
|---|---|
| kept | **116 703 areas · 449 lines · 311 labels · 0 buildings · 0 pois** |
| base coordinates | 10 717 100 selected → **735 500 decimated** (94.1 m = 1 px at z10) |
| spine | 91 443 ways → **14 631 chains** → 38 931 coordinates |
| output | **90 tiles · 132 094 features · 774 431 coords · 20 570 304 bytes (19.6 MB)** |
| checks | `persist true load true verify true`; base coords land within 93 of O0's independent 735 407 |

Verified geographically, not just structurally: a keyed read over the Amsterdam window returns 7 tiles /
17 667 features and one over the country returns all 90 — so re-keying moved features between tiles
without moving them on the ground. (That country read asks **454 867 keys**, which is the same point §6i
opens with: this block is read WHOLE, never paged.)

**Two things cost real bytes, and neither was in the design:**

1. **⚠ An overview must be RE-KEYED, or it inherits a grid built for a hundred times its density.** Keeping
   each feature in its source tile is the obvious implementation and it produced **26 848 tiles holding 4.9
   features each** — against 93 in the full store. A tile's fixed cost (five vector headers, origin, sealed
   extent, store bookkeeping) is then paid 26 848 times: **25.5 MB → 19.6 MB** simply by flooring the
   output at tier 2 (0.32° cells, 90 tiles). Coarser is always safe for the reader's one-cell window, so
   the floor only ever moves a feature UP the ladder.
2. **⚠ The merge had a silent half-failure.** Endpoint slots were *preferred* in order rather than
   *tested*, so when the run we arrived on sat in the second slot the continuation was refused — exactly
   half the time. It chained 1508 city ways into 814 pieces (1.85 each) and looked like it worked.
   Fixed, and the same block chains into **223** (6.8 each). Nationally: 91 443 ways → 14 631 chains,
   **184 583 unmerged coordinates → 38 931 (4.7×)**. Merging really is the spine's whole budget.

⚠ **19.6 MB against a 14 MB projection, and the model was wrong in a knowable way.** §6i predicted 8 B per
coordinate + 44 B per feature. Geometry did land at 5.9 MB (8 B/coord exactly), but the remaining 13.7 MB
is **109 B per feature**, not 44 — because 44 B/feature was derived from a store averaging 9.2 coords per
feature, and an overview averages 5.9, so each feature's own ring is a separate small allocation with its
own header. **Per-feature cost does not scale down with the geometry**, which says the next lever on size
is FEATURE COUNT, not vertices — and 116 703 of the 132 094 are areas, because `areaMinZoom` sends
*everything* over 0.008° of diagonal to z0, putting a 900 m field on the same footing as the IJsselmeer.
A finer ladder above that threshold is the obvious follow-up and it is a renderer rule, not a store one.

#### ✅ O1b WIRED — a bare visit opens on the Netherlands in 0.6 s (2026-08-02)

`DEFAULT_CAM` is `z8 52.15,5.30` and the app resolves it to the overview alone. Measured on a bare URL
against the local site:

| | bare visit (z8) | z16 Amsterdam — the regression check |
|---|---|---|
| requests | **1 · `nl-overview.base.store` · 19.62 MB** | `nl-midwest`, 82 range reads, 4.97 MB |
| drawn | **116 703 areas · 15 080 lines · 311 places** | roads `R=4866`, base paged |
| detailed roads read | **`R=0`** | unchanged from before this work |
| wall | **0.6 s** | 18.6 s (unchanged) |

**Four things had to change, and one of them was the kernel:**

1. **A zoom band per block, in the index** (`zoom_min` / `zoom_max` → `"zoom":[lo,hi)`), filtered in JS by
   `blocksForBox`. A block that declares none serves every zoom, so an older index behaves as it did.
2. **Selection falls back to the BASE extent when a block has no roads store.** The overview is a picture
   and never a routing input, so `selBox` picks roads-when-present and the asked-for store otherwise —
   which also keeps §6f's rule (a tiered base extent is meaningless) intact for the regions that do have
   roads.
3. **⚠ The VIEW's roads are zoom-banded; a MATCH's are not.** `roadsForSketch` deliberately passes no
   zoom, because a route must always be matched against detailed geometry whatever the camera shows.
4. **⚠ The kernel needed a branch: an empty roads URL is a supported state**, symmetric with the empty
   layout URL it already had. Below the handover there is no roads store at all — the spine lives in the
   overview as Lines.

**Two defects this found, both mine, both measured rather than reasoned:**

* **The chooser's fallback re-admitted the block the band had just excluded.** `roadsUrlsFor` was passed
  `coverage.block` as its fallback, and `chooseBlocks` applies the fallback when the candidate set comes
  out empty — which is precisely what a band exclusion produces. At z8 it downloaded a **123 MB roads
  store whole**. The fallback belongs at the call site, where the band can be consulted.
* **Before the kernel branch, a z8 view asked the detailed roads for the whole country: 75 256 range
  requests, 4.7 GB into one block, and the view never returned.** The overview loaded correctly the whole
  time — the base half was right and the roads half was catastrophic, which is exactly the shape §6i
  warned about when it said the zoom band is load-bearing rather than cosmetic.

⚠ **Seven headless drivers navigated to a bare URL and inherited `DEFAULT_CAM`.** Moving the default
silently re-baselines every one of them onto a generalised national map. They each pin `GATE_CAM` now.
Green after the change: `map_render_gate`, `base_paged_gate`, `cross_block_browser_gate`, `cors_host_gate`,
`index_fresh_gate`, `browser/map.test.mjs`.

✅ **PUBLISHED (2026-08-02).** `nl-overview.base.store` + its `.dschema` are on release
**`data-v2026-08-02`**, and the release's own `coverage.json` was regenerated so the release describes
what it serves (5 blocks, the overview among them, with their zoom bands). Verified the way R6 requires —
the asset answers a **206** with `content-range` total **20 570 304**, and a full download hashes to
**`799e77da…`**, byte-identical to what the committed index promises. Then proved end to end by *removing
the local block* and running the deploy's own `tools/fetch-site-blocks.sh`: **`nl-overview.base.store —
fetching 20.6 MB`, 1 fetched, 9 already current**, sha verified on arrival. ⚠ The fetcher tolerates a
block with `roads: null` only because its reader skips a store with no url — worth knowing before any
other roads-less block is added.

⚠ **AND THE GAP IS REAL AND NOW REACHABLE.** The handover is z11: below it the overview answers, above it
the detailed regions do — and §6i's own arithmetic says the detailed path costs ~10 500 keys at z12 and
~40 700 at z11. **A visitor who opens on the country and zooms in walks into that.** It is not a
regression (it is what every zoom below z14 already cost) but the default camera now leads there, which
makes **O3 — the middle levels on their own coarse grids — the next rung rather than a later one.**

#### ✅ O3 — THE GAP IS CLOSED, and the fix is not the one the design proposed (2026-08-02)

O1b left z11–z13 unaffordable and promoted this to the next rung. The handover is **z14** now, and every
zoom below it is answered by the overview alone. Measured, cold, against the local site:

| camera | requests | drawn | wall |
|---|---|---|---|
| z11 | 1 · overview · 19.62 MB | 16 687 areas · 2 441 lines · 53 places | **0.5 s** |
| z12 | *(same file)* | 5 355 areas · 1 135 lines · 21 places | **0.5 s** |
| z13 | *(same file)* | 1 411 areas · 495 lines · 3 places | **0.5 s** |
| z14 | `nl-midwest`, 296 range reads, 18.5 MB | the detailed path, unchanged | 19.5 s |

Against **2 GB at z12 and 8 GB at z11** before. One line of manifest, no new data.

**§6i's own design for this rung was wrong, and the arithmetic says so.** The plan proposed "middle levels
on their own coarse grids", and the natural cheap version of that is to keep reading the DETAILED store
but floor the tier the reader starts at. It costs little — z13 floors to 76 keys (~15 MB), z12 to 216 —
but it buys nothing, because **the tier ladder is a SIZE bin and not a visibility bin.** The coarse tiers
of an Amsterdam window hold 611 of its 39 646 features and not one place label or motorway. That is §6i's
already-falsified R1, re-derived from the other end: the features a low zoom needs are selected by DEBUT,
which is exactly what the overview is and what a tier can never be.

⚠ **And the detailed ROADS cannot be read in the gap at any grid** — one cell size (0.02°), so a padded
z13 viewport names 231 keys and a z12 one 760, which is 46–152 MB before a single area is drawn. The
overview's merged spine is what stands in for them, which is why it had to carry roads at all.

**What is closed and what is not.** The PERFORMANCE gap is gone — the whole range z2–z13 is one 19.6 MB
file, downloaded once and reused. A DETAIL gap remains: at z13 the map is z≤10 content (motorways, big
areas, city labels) decimated at 94 m, which is ~8 px of error at that zoom. It is coarse, and it is
instant, and it degrades in one direction only.

⚠ **Closing the DETAIL gap is bounded by the per-key cost, and no cell size escapes it.** A mid level at
z≤12 read paged is the right shape, and every grid lands in the same band because the per-key cost
dominates whatever the cell size. At **~160 kB per key** (2.5 pages, the clustered-read figure above),
against ~10 MB of content for one z12 viewport: **0.04° → 216 keys ≈ 45 MB · 0.08° → 66 keys ≈ 23 MB ·
0.16° → 28 keys ≈ 22 MB · 0.32° → 16 keys ≈ 36 MB**. The optimum is a shallow bowl around 0.08–0.16° and
nothing makes it cheap — the numbers scale linearly with the per-key figure, so they are worth recomputing
if O5 moves it.

⚠ **But O5 is NOT the blocker it was first written as, and the correction matters because it changes what
loft should do first.** A miss costs ~1.4–2× a hit in extent, and the app's own reads are mostly HITS
where it spends its time: the z16 Amsterdam window loads 67 of 69 keys, so cheap misses buy it nothing.
The 7.5× that cheap misses would win (the country coarse read: 128 misses of 163) is a LOW-ZOOM effect,
and low zoom is exactly what the overview removed from the keyed path. So:

* **for the app as it ships**, the lever is the HIT floor — 2.0–3.0 pages/key — which is page-fetch
  COALESCING (the browser made **217 requests for 13.58 MB**: round-trip-bound, not bandwidth-bound) and
  entry LOCALITY;
* **cheap misses are a prerequisite for O3b**, not a win today.

#### ✅ O2 — SKETCH DENSIFICATION, as a fallback rather than a preprocess (2026-08-02)

The country view makes a 100-pixel drag ~40 km, and a matcher fed two distant points returns the sketch
**echoed** — `match_route` hands back its input trace when it cannot bridge. Bracketed on one Amsterdam
corridor, three points each time, spacing the only variable:

| spacing | 1 km | 2 km | **3 km** | 4 km |
|---|---|---|---|---|
| result | 46 route pts | 104 route pts | **none** | **none** |

`densifySketch` splits any leg longer than **1 km** into collinear pieces — the working end of the range
with margin. Through the app's own path (`rough.commitEdit` → `requestMatch`):

| sketch | before | after |
|---|---|---|
| 3 points at 3 km spacing | **no route** | **134 route pts**, 7 333 m, 5.0 s |
| a country drag: 2 points, ~35 km | **no route** | **791 route pts**, 47 327 m, 45.6 s |

**⚠ IT FIRES ONLY ON THE ECHO, AND THAT IS THE WHOLE DESIGN.** Densifying every sketch would change the
route for every sketch whose points are more than a kilometre apart — including ones that already match
perfectly (the Enschede corpus spans 3.5–4.8 km between points and returns 199 points), and a
route-affecting change is gated on the 26-sketch corpus at 0 worse accepted. Retrying only when the
matcher handed the trace straight back leaves **every working match byte-identical** and costs one retry
on the case that returned nothing at all. `densifySketch` even returns the ORIGINAL array when no leg
needed splitting, so "an ordinary sketch is untouched" is structural rather than promised.

The two pure functions (`densifySketch`, `isSketchEcho`) are exported from `map.mjs` and carry **12
DOM-free checks** in `browser/map.test.mjs` — collinearity, endpoint identity, the untouched-array case,
a zero step, and the echo test at loft's 6 printed decimals.

⚠ **The 45.6 s is honest and it is not the densifier's.** That sketch escalates to the fat-bbox corridor
(162 834 ways) and then pays an anchor search per point on 36 points — PLAN-PERF §7 measures anchoring at
~75% of a cold match on a dense sketch. It is a long walking route on a country-scale drag, and it now
returns one instead of nothing.

⚠ **TOOLCHAIN: the installed loft changed MID-SESSION and the version string moved with it** —
`/usr/local/bin/loft` was reinstalled 2026-08-02 19:59, **2026.7.2 → 2026.8.0**, md5 `13311104…`,
byte-identical to `../loft`'s build. The overview block, the kernel wasm and the first gate runs of §6i
were all made on 7.2. Re-verified on 8.0: the block still loads and reads (7 tiles / 17 667 features at
the Amsterdam window), `index_fresh_gate` still regenerates byte-identically, the wasm was rebuilt (same
sources hash, **1 408 411 → 1 404 720 bytes** — the documented toolchain drift the sidecar deliberately
does not hash), and `map_render_gate`, `cross_block_browser_gate`, `cors_host_gate` and
`browser/map.test.mjs` are green on it.

#### ✅ THE REFRESH KNOWS ABOUT IT, AND THE BEHAVIOUR IS GATED (2026-08-02)

Two gaps between "it works" and "it stays working", both closed:

**`data-refresh.yml` rebuilds the overview with the regions.** It is DERIVED from them, so a refresh that
regenerated the regions and not it would leave the country view describing the previous snapshot while
the routes underneath describe the new one — and nothing would report that, because
`publish-release.sh` uploads whatever `blocks/` holds that the manifest names. A stale file is
re-published looking current. The step deletes first (`store_persist_bind` adopts an existing image) and
builds from the REGION stores, because no job in that workflow holds a country-wide base and country-wide
roads at once. `tools/build_overview.loft` therefore takes a comma-separated SET for both inputs, the way
the app's covering set does. Measured cost of that: **24.8 MB from four regions against 19.6 MB from one
country store (+26%)**, entirely margin duplication — a feature inside a region's 0.10° margin is written
twice. The spine is unaffected (14 633 chains against 14 631) because roads are cut WITHOUT margins. Not
deduped on purpose: any cheap key for "same feature" risks dropping a real one, and this repo's failures
have all been silent drops rather than wasted bytes.

⚠ **That workflow still cannot run, for a reason older than this change**: it merges chunks into the TWO
halves and `refresh-region.sh --split 5.40` splits the roads the same way, while `data/coverage.toml` has
named FOUR regions since §6f F3. `publish-release.sh` would fail building the release index on blocks the
job never produced — after uploading gigabytes. The fix is to reproduce F3's cut there (four bands,
`trim_base … cover` for the base, plain partition for the roads) against a real run with eyes on it; the
note is now in the workflow beside the step.

**`tools/overview_gate.sh` (in `make test-map`)** asserts what §6i shipped, which nothing did before —
and F5 is the reason that matters:

* a **bare url**, the camera a first visitor actually gets, draws **132 094 features from ONE store**, the
  overview, reading **no detailed roads**;
* the handover is **exclusive both ways** — at z13 only the overview is read, at z16 only the detailed
  block and the overview is not touched. Getting that wrong is not a slower map, it is a 2 GB read at z12
  or a blank one at z16;
* the densified retry **does not fire** on a sketch that already matches — the property that keeps every
  working route byte-identical — and its decision is wired to the app's own `isSketchEcho`/`densifySketch`
  at the app's own 1 km step.

⚠ **The retry's FIRING is not gateable against the shipped city block**, and the gate says so rather than
pretending: an echo needs a corridor holding ways but no path through them, and that block routes
everything at the distances where Amsterdam echoes (3 km there, 4.8 km fine here). The functions are
covered by `browser/map.test.mjs`, the firing by the live measurement.

⚠ **`build-site.mjs`'s `SITE_LOCAL_ONLY` filter looked only in `browser/`** while the check beside it
looks in `_site` too — so it dropped every block LINKED in from `blocks/`, the overview included, and the
gate written to prove the country view draws could not see it. Both locations now.

#### ✅ THE areaMinZoom CLIFF, AND WHERE THE DEBUT RULES NOW LIVE (2026-08-02)

O1 found that **116 703 of the overview's 132 094 features are areas**, because `areaMinZoom` sent
*everything* over 0.008° of diagonal to z0 — a 900 m field arriving at the same zoom as the IJsselmeer.
At the country camera that is a screen asked to draw a hundred thousand shapes it cannot resolve.

**The fix is not a new rule, it is the existing one continued.** The small end already encodes "about
eight pixels across": 0.0007° at z14, 0.003° at z12 and 0.008° at z11 all land at 8–12 px. It simply
stopped at 0.008. The series now doubles the diagonal per zoom up the ladder — **>0.016 → z9 · >0.032 →
z8 · >0.064 → z7 · >0.128 → z6** — with a floor above 0.256° so genuinely huge geometry still draws at
ANY zoom, which is what keeps a z2 view from being empty.

Measured country-wide on the overview block, features by debut:

| debut ≤ | z0 | z6 | z7 | **z8** | z9 | z10 |
|---|---|---|---|---|---|---|
| areas | 95 | 221 | 862 | **4 408** | 21 059 | 114 076 |

**At the default camera the map draws 4 408 areas instead of 116 703 — 26× less, and what remains is what
is big enough to see.** The small end is untouched, so the detailed map at z11+ draws exactly as before.

⚠ **The block does not change and did not need republishing.** Selection is `debut ≤ 10`, and everything
over 0.008° still lands at 6–10, so the same set is kept: rebuilt, it comes to the same **116 703 areas ·
449 lines · 311 labels · 14 631 chains · 774 431 coords · 20 570 304 bytes**. ⚠ The byte IMAGE is not
reproducible across the 2026.7.2 → 8.0 toolchain move, so a block is checked by its counts and extents,
never by a diff.

**The rules moved into `lib/basemap` in the same change, and that is the part worth keeping.** §6i's own
design step counted the re-assertion sites and this rule had **five** — the renderer plus four loft files
that each carried a private copy, ported "verbatim". A rule duplicated five ways is one that drifts, and
a drift here is either a feature stored and never drawn or one drawn and never stored. `area_debut`,
`line_debut`, `label_debut` and `poi_debut` are `pub` in `basemap.loft` now, so loft has ONE copy and the
count is two: loft and JS. `browser/map.test.mjs` asserts the JS ladder against the loft thresholds, its
monotonicity, and that the small end is unchanged.

⚠ **Moving them exposed a drift that already existed**: the spine's `motorway`/`primary` kinds have
`LINE_STYLES` rows in the renderer and were absent from every loft `line_debut`, so a probe reported them
as "never drawn". Harmless where it sat (the spine is appended, not filtered) and exactly the kind of
divergence one copy prevents.

⚠ **THE LADDER SHIPPED AS A NO-OP FIRST, AND THE TESTS ALL PASSED.** Areas render from the STORE index
through `_drawAreasFromStore`, which never materialises a ring and so recomputed its own minZoom from a
bbox — **a sixth inline copy of the thresholds**, in the one path that actually paints. Extending
`areaMinZoom` changed the parity path, six new unit tests went green, the browser gate went green, the
live site redeployed, and the map was **identical**. Measured after the fix: **2 838 areas drawn at z8
against 106 464 at z16**; before it, 103 262 against 106 464 — the ladder was not in force at all.

Three things to take from it. **A rule is not in force until the code that DRAWS asks it** — the copy that
mattered was the one no test exercised. **Consolidating five copies while leaving a sixth is worse than
leaving five**, because the remaining one now looks authoritative. And the gate that catches it has to
observe the drawing, not the decision: `overview_gate` calls `_drawAreasFromStore(8)` and `(16)` on the
same loaded index and requires the first to be far smaller — **verified to fail** on the old inline rule.

#### The design: a ladder of LEVELS, not a bigger tier ladder

**Invariant.** *A feature is stored once per level at which it is drawn — selected by the renderer's own
debut zoom, decimated to one pixel at that level, on a grid whose cell scales with the level — so a view
at any zoom reads a constant number of cells holding only what that zoom can show.*

Three rules, each already computable from what exists:
* **Selection** is the renderer's `minZoom` tables — `areaMinZoom` (an area's own diagonal),
  `BUILDINGS_MINZOOM`, `LINE_STYLES`, `RANK_MINZOOM`, `POI_STYLES`. Nothing is invented; the probes above
  port them verbatim. ⚠ Today `areaMinZoom` is recomputed **in JS, per area, per view** — storing the
  debut removes that too.
* **Decimation** is Douglas–Peucker at 1 px of the level's zoom. The road spine must be **MERGED first**:
  the country holds 27 595 motorway *ways* for ~3 500 km of motorway (≈130 m per way, OSM fragmentation),
  and keeping way identity costs ≥2 vertices each before any simplification.
* **The level's own cell size** is what keeps key count constant. Today's tiers ×8 are already levels
  z16/z13/z10/z7; the fix is that a view at zoom z asks the levels ≤ z on THEIR grids, not all four on all
  of theirs.

The top level(s) are small enough to ship **whole** — read once, same-origin, cached — which is where the
key-cost measurement pays off. Only the lower levels stay keyed.

**Contents of the top level** (what a country map is): area colour, borders, rivers, canals/railways/
runways, places by rank, and the road spine — motorway 27 595 · trunk+primary 63 848 · secondary 75 886
ways (`tools/census.loft` over `blocks/netherlands.roads.store`, 2 785 476 ways / 17 298 515 vertices
total). ⚠ **The spine has to be lifted out of the ROADS store**, which the base map's `Line` kinds do not
cover today (waterway/railway/barrier/aeroway/boundary/power only).

#### Is the zoom seamless? By construction yes — but there is a GAP in the middle

**The handover cannot be seen, and that is a property of the decimation rule rather than a blend.** A level
decimated at 1 px of its own zoom differs from the detailed geometry by **less than one pixel at every zoom
it serves**, so switching sources at the top of its band moves nothing the eye can resolve. Seamlessness is
bought at generation time, not by cross-fading.

Three things still have to be arranged, and they are cheap:
* **Always loaded, never swapped.** The overview is the app's base layer, drawn *under* the detailed
  blocks, not exchanged with them. That removes handover flicker, removes pop-in while a keyed read is in
  flight, and gives a background everywhere the detailed blocks do not reach.
* **One source per kind per frame**, or a motorway drawn from both levels smears. The rule is the level
  band, so it is the same decision as selection.
* **Hysteresis at the boundary**, because the camera zooms fractionally (~0.5 per wheel notch). Switch up
  and down at different zooms or the boundary thrashes.

⚠ **AND THE HONEST PROBLEM: the two paths do not meet.** The overview is affordable up to ~z11 (≲47 MB
whole); the detailed regions are affordable from ~z15 (18.4 MB). Between them **neither is** — z13 is
~230 MB keyed, and a z≤13 overview is ≲165 MB. So a single overview file does not make zooming continuous;
it makes the *ends* work. The middle band is what the per-level grid is for: a z12 level on 0.08° cells is
~16 keys ≈ 3 MB, where the same viewport on today's 0.005° grid is 2 777 keys. **The gap is the argument
for the ladder** — one file alone leaves a hole from z12 to z14.

#### Long routes: yes, and the mechanism is already right — but the overview walks it into a trap

Routing does not go through the view path at all. `match` names its own blocks from the sketch
(`roadsForSketch`) and reads a **tube** of corridor cells along the drawn polyline, so its cost is
proportional to route LENGTH, not to viewport area. Measured on the deployed site through the app's own
path:

| sketch | corridor | route | network | time |
|---|---|---|---|---|
| 11 points over ~8 km (≈800 m apart) | 19 808 ways | **217 pts, 10 186 m** | 39 requests, 2.3 MB | 4.9 s |
| 3 points over ~3 km | 28 902 ways | 59 pts, 3 185 m | 18 requests, 1.0 MB | 5.4 s |
| **3 points over ~8 km** (≈4 km apart) | 35 833 ways | **NO ROUTE** | 39 requests, 2.3 MB | 8.6 s |
| **3 points over ~40 km** | 162 834 ways | **NO ROUTE** | 415 requests, 25.9 MB | 41 s, wasm **1.45 GB** |

**The limit is point SPACING, not length.** A drawn line at ~800 m spacing routes fine and pays ~5 keys and
~290 kB per km; the same ground as three far-apart taps fails, because the tube tier is rejected, the fat
bbox is read instead (162 834 ways, 1.45 GB of wasm memory) and no route comes back. This is a MATCHER, not
an A→B router — which is by design (DESIGN §1), but it means:

⚠ **The overview makes the failing case the DEFAULT.** At z8 a 100-pixel drag is ~40 km, so a sketch drawn
on a country map is exactly the sparse sketch that returns nothing. **Densify the sketch before matching** —
interpolate along the drawn polyline to ≤~1 km spacing (collinear points do not change the user's intent),
or make the tube radius adapt to point spacing. Without it, "open on the Netherlands" ships a map you can
draw on and get no route from. `browser/rough.mjs`'s `commitEdit` is the one chokepoint it belongs in.

#### Failure paths to design against

1. **Block selection is by AREA, not by zoom.** `chooseBlocks` takes the smallest block CONTAINING the box
   and drops nested hits — so a mid-width box straddling two regions is contained by the overview and by
   neither region, and would draw the coarse map at z14 where detail exists. Fix: **each block declares its
   zoom band in the index** (`"zoom": [0,12]` / `[12,19]`) and JS — which already chooses blocks — filters
   on it. The kernel does not change.
2. **Conservation gates must not be applied to an overview.** It is lossy on purpose. It needs its own gate
   in BOTH directions: every overview feature exists in the detailed block, *and* every debut ≤ Z_HAND
   feature of the detailed block is in the overview. The second direction is the one that catches a silent
   hole — the same class of miss as F5's blank map.
3. **Freshness.** Build it in the same `data-refresh.yml` run from the same extract, or it drifts from the
   regions and the map disagrees with the route.
4. **Double-draw and label duplication** at the handover — one source per kind per frame (above).

#### The rungs, in the order the evidence favours

| | what | observable |
|---|---|---|
| **O0** ✅ | **Measure the country's overview population in ONE generator pass** — done 2026-08-02, above | **handover z10; ~11 MB base + ~3 MB spine ≈ 14 MB** |
| **O1** ✅ | Build the NL z≤10 level (select + **merge** + decimate) **and wire it in** — both done, above | **a bare visit draws 132 094 features in 1 request / 19.62 MB / 0.6 s** |
| **O2** ✅ | Zoom bands (O1b) + **sketch densification as an echo-triggered fallback** (above) | **a 2-point 35 km country drag returns a 791-point route**; every working match byte-identical |
| **O3** ✅ | Close the z11–z13 gap — **done by extending the overview's band to z14, not by a middle level**: the tier floor buys nothing because a tier is a size bin (above) | **z11/z12/z13 all render in 0.5 s from one file**, against 8 GB / 2 GB / 539 MB of keys before |
| **O3b** | The DETAIL half — a z≤12 mid level, paged on its own grid | blocked on O5: every cell size lands at 24–54 MB/viewport while a key costs 3 pages |
| **O4** | The same generator for WE — the only part of §6h's list needing no bucket, no CORS and no 58 regions | a WE overview ships beside the app |
| **O5** ⬅ **next** | *(upstream)* the per-key page cost, **re-characterised**: coalesce adjacent page fetches (217 HTTP requests for 13.58 MB) and cluster an entry's pages, which attacks the 2.0–3.0 pages/key HIT floor. Cheap misses are third, and gate O3b rather than today | a z16 view drops from 14.2 MB toward its ~4 MB of content |

O5 is worth filing on `loft-lang/loft` with `tools/base_key_probe.loft` as the repro: it is a ~3× on
**every** zoom, needs no data change, and it is what makes the ladder's per-level floor affordable.

#### Instruments added for this (all keyed reads — none walks a whole store)

* **`tools/base_key_probe.loft`** — one viewport through the app's own reader; asked/loaded/bytes. This is
  the probe that separated "the data is missing" from "it was never fetched".
* **`tools/zoom_bin_probe.loft`** — the debut-zoom × tier cross-tab, i.e. what a zoom-aware reader would
  and would not be able to reach.
* **`tools/overview_size_probe.loft`** — selection vs decimation, with Douglas–Peucker at 1 px of a given
  zoom, over a window (keyed) or a whole store (`whole`, for O0's country pass). The size curve above is
  its output.
* **`tools/spine_size_probe.loft`** — the road spine: ways, vertices, km and decimated vertices per class,
  against the merged bound. This is what showed decimation alone buys nothing on roads.
* **`tools/cell_hole_probe.loft`** — finds cells the store does NOT hold that have data on all four sides.
  It exists because the obvious way to measure a miss is a box outside the extent, and that over-states it
  by ~2×: the honest control is a hole with the map around it.

⚠ **A pixel is not a degree in both axes, and the first version of both probes got it wrong.** Mercator's
screen-y follows `ln(tan(…))`, whose slope is `1/cos(lat)` — so at 52°N a degree of latitude is 1.62 screen
pixels for every one a degree of longitude buys, and decimating on raw degrees silently drops vertices up
to 1.6 px off the line. Corrected, the country's decimated coordinates rose 7–17% (z≤10: 626 692 →
735 407). It did not change a verdict, but an instrument that flatters the answer it is measuring is the
one to distrust.

⚠ **One thing found while measuring this that belongs to §6h, not here: the paged base map works only
because the data repos share the app's origin.** Same code, same block, same viewport — base served
same-origin: 217 requests, 13.58 MB, 22 479 features; served from another origin that sends `ACAO: *` but
no `Access-Control-Expose-Headers` (which is what GitHub Pages sends): **2 requests, ~0 bytes, blank map,
`rangeFails: []`, no error anywhere.** `cors_host_gate.sh` is green because `tools/range_server.py` sends
the expose header and answers the preflight — it models a CORRECT CORS host, and nobody asserted that Pages
is one (it answers `OPTIONS` with 405). D2's off-origin plan rests on this working.
