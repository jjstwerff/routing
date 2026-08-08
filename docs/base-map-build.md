<!--
Copyright (c) 2026 Jurjen Stellingwerff
SPDX-License-Identifier: LGPL-3.0-or-later
-->

# Building a country's base map — the design, and cutting it into regions

**Kind:** reference · **Status:** current · **Last verified:** 2026-08-04 · **Owns:** how a country's base map is generated and cut into regions (PLAN-BASEMAP owns how it is DRAWN)

`PLAN-SCALE` §6f and §6g. How the base blocks for a whole country are **produced** — the design that
took the map from blank-outside-Enschede to a full country, and how regions are planned
automatically. ⚠ **`PLAN-BASEMAP.md` owns the presentation layer** — what the base map LOOKS like
and which mark draws at which zoom. This is the generation half.

⚠ **Section numbers are global to `PLAN-SCALE.md`** — they were not renumbered when this file was split out, so a citation of `PLAN-SCALE` §6e still resolves. Its *Where each section lives* table says which file holds which §.

---

### C1b — done, and shipped OFF on purpose (2026-07-30)

The app can read its roads block **by byte range**: `corridor_cell_keys` / `view_cell_keys` name the cells
a command is about to read, `store_load_keys` fetches the ones this session has not asked for yet, and the
working set ACCUMULATES (verified — a second paged load keeps the first entry), so a warm edit inside
loaded area fetches nothing. Route and render are unchanged: `ways=7138 route_pts=213 len=13138.0m`,
pixel hash `917244eb`.

Three things it took that the plan did not predict:

1. **The app's own JS host had to grow the range bridge.** routing drives the wasm from
   `browser/store-kernel.mjs`, not loft's page, so `loft_host_http_range` / `_range_total` are implemented
   there (mirroring `doc/loft-gl-wasm.js`) — an import loft's page provides is not automatically ours.
2. **The gate's server could not serve Range at all.** `python3 -m http.server` ignores it; the gate now
   uses `tools/range_server.py`, or it would have been measuring whole-file responses that the shim
   silently sliced.
3. **Two loft constraints shaped the code.** The working set cannot live in a struct field (the paged
   loaders refuse a field-declared collection, loft#632) and `marks += …` through a `&hash` parameter
   does not compile, so the mark-and-fetch stays inline on the loop's own locals.

**And it ships OFF for this block, which is the honest result.** Measured: a session that pans and matches
across the region fetches **44–80% of the 3.5 MB block anyway, in 25–46 separate requests**, because the
block is only ~56 pages wide. Cheap on localhost; 25–46 round trips over a real RTT. So the read strategy
belongs to the **data**, not the code: `readMode` is a per-block choice that the top index will carry
(§7 R6), `'whole'` today, `'paged'` the moment a viewport is a small fraction of a block — which is C2
onwards. The gate switches it on explicitly so the mechanism cannot rot unexercised.

⚠ **A correction worth keeping.** A first reading blamed paging for a cold-start move (458 → 650 ms).
Re-measured with paging OFF in the same build: still ~650. The cause is the bigger wasm / newer binary,
not round trips — *the number moved, but not for the reason the change made obvious.*

---

### The Netherlands base map, and a published dataset (2026-07-30)

```
osmium layers            areas 3.2 GB · buildings 8.7 GB · pois 303 MB · lines 199 MB · places 2.8 MB
                         streets: the roads export, reused (884 MB)
build_store (streaming)  24m33s, ~5 GB resident → 184,839 tiles · 17,167,067 features · 3.2 GB
                         areas 2,658,318 · buildings 11,560,787 · labels 1,242,645 · lines 520,570 · pois 1,184,747
extent                   lat 50.7182..54.2223  lon 2.6837..7.2957
```

S6's flat-memory claim now has a country behind it: 13.3 GB of input, one chunk resident per layer.

**A GitHub release asset stops at 2 GB, so a 3.2 GB base map cannot ship whole** — which forces the
regions §7 R0 already calls the unit. Both stores are cut at **5.40°E** (`tools/split_base.loft`, the
presentation counterpart of `split_block.loft`), giving `nl-west` and `nl-east`, each roads 264 MB + base
1.44 GB. Cut by CELL, so nothing is clipped and S8's gate covers the seam.

**Published: [`data-v2026-07-30`](https://github.com/jjstwerff/routing/releases/tag/data-v2026-07-30)** —
8 assets, 3.2 GB, each verified to answer a `206` with the exact size uploaded **before** the index that
names them was published (§7 R6's order). And a paged read works against it end to end:

```
store_load_keys: asked=1 loaded=1 bytes_fetched=1179648 file=263942480
RELEASE ok=true entries=1 roads=6488 steps=25883        ← 1.18 MB of a 264 MB asset = 0.45%
```

⚠ **What a GitHub release cannot do, measured rather than assumed:**

| surface | `Range` | CORS with `Origin` | ceiling |
|---|---|---|---|
| release asset | ✅ 206 + `Content-Range` | ❌ **no `Access-Control-Allow-Origin`** | 2 GB/asset |
| `raw.githubusercontent.com` | ✅ | ✅ `*` | git limits (~50–100 MB) |

So the release serves **downloads, the native server and offline use**, and a browser on another origin
cannot read it. That is D2 restated by measurement, not a surprise — the browser path needs a CORS host.
The manifest therefore carries a per-region `url_base`, and **each index names only what it can serve**:
the site index has the block that ships beside the app, the release index has the published regions. A
region in the wrong index would resolve to a URL the consumer cannot fetch, which is a blank map rather
than an error.

---

### 6f. FULL NL BASE MAP — the design (2026-08-01)

**The problem, stated as a user sees it:** outside Enschede the map is BLANK. Roads route and search
works, but there is nothing to look at, so you cannot tell "the router picked a farm track" from "the map
is missing". A route on an empty background is not a product.

**Why it was blank:** the NL base map is 2.06 GB. GitHub Pages caps a SITE at ~1 GB and the app already
uses 560 MB, so the base map was published to the release instead — and release assets send no CORS
header, so a browser cannot read them. §6e concluded the fix was D2, a paid CORS bucket.

**Three things measured on 2026-08-01 make that conclusion obsolete.**

| # | measured | why it matters |
|---|---|---|
| 1 | **GitHub Pages sends `access-control-allow-origin: *`** *and* a real `206` — verified against the live site with a cross-origin ranged GET | Pages IS a CORS host. A SECOND Pages site (a data-only repo) can serve blocks to the app, cross-origin, free. D2's premise — that CORS forces a paid bucket — was assumed, never tested |
| 2 | **A country-scale base store PAGES correctly**: `store_load_key` on `nl-east.base.store` fetched **524 288 bytes of 1 109 719 080** and returned a tile identical to the whole-load one (653 areas / 1034 buildings / 563 lines / 41 labels / 252 pois / 17 379 coords) | N4's open question — "can `expose` work on a partially-filled store" — is answered for the READ half. The base map does not need to fit in memory, only the viewport does |
| 3 | ~~**A base tile is 9.1 kB**, so a viewport of 8–20 cells is 75–190 kB~~ ⚠ **wrong, and refuted 40 lines below by this section's own measurement** — a viewport is **8.1 MB** | The per-screen cost is the same against 88 GB as against 1 GB — that half stands, and it is the half the WE path needs |

#### The design

    main Pages site  (~560 MB, unchanged)      data Pages repos (~690 MB each, 3 of them)
      app shell                                  nl-a.base.store
      roads   nl-*.roads.store                   nl-b.base.store
      names   nl.names.store                     nl-c.base.store
      base    enschede.layout.store            served cross-origin, 206 + ACAO, read PAGED

* **NL becomes three regions**, cut so each base block fits a Pages site with margin. `build-base-chunked.sh`
  already produces roads AND base per chunk, and `CHUNK_EDGES` already forces the cuts to land where the
  coverage manifest wants them.
* **Each base block gets its own data repo**, named by `base_url_base` in `data/coverage.toml` — the
  per-store hosting that already exists. The app resolves it to an absolute cross-origin URL.
* **The base map is read PAGED**, like the roads, by the cells the viewport touches.

#### The work, in order, each with its own observable

| | what | observable |
|---|---|---|
| **F1** ✅ | **Page the layout in the kernel.** `web_basemap_kernel.loft` did `store_load_url_trusted(layout, url)` — a WHOLE load. It now gets the roads' treatment: `store_load_keys(layout, url, layout_cell_keys(bbox, LAYOUT_PAD))`, accumulating a working set | a viewport renders from a store read by RANGE — **done**, and the bytes are 50× what this row assumed; see below |
| **F2** ✅ | **Re-`expose` as the working set grows.** `expose` pins the store read-only and is O(collection) per call, so it cannot run per frame — it must run once per LOAD, and the JS side must re-read the handle after each | **done, and the risk is disproven**: 13 viewports with a growing working set, per-viewport cost 211 ms → 176 ms (0.84×), bracket balanced 13/12 |
| **F3** ✅ | **Cut NL into three regions** and rebuild roads + base per region — **and re-bin the base map while doing it**, which turned out to be the load-bearing half | **done**; each base block under 900 MB and every region paged-EXACT. See "F3, and what it cost" below |
| **F4** | **Publish the base blocks to data repos** and name them by `base_url_base` | `cors_host_gate.sh` against the real data repo, not a local server |
| **F5** | **Extend `nl_live_gate`** to assert the map RENDERS in Amsterdam | non-zero areas/buildings/labels from a cross-origin paged base — the check that would have caught "shows nothing" |

#### What F1 measured, and what it changes (2026-08-01)

F1 is built and works — the app draws a base map it never downloaded whole, over real 206 Range requests
(`tools/base_paged_gate.sh` runs the same camera path twice, whole vs paged, and compares what got
DRAWN). But building it required measuring the two things this section had assumed, and **both
assumptions were wrong**. The instrument is `tools/layout_page_probe.loft`; the numbers are from
`blocks/nl-west.base.store`, the block that would actually ship.

**1 · A viewport is not 75–190 kB. It is 10 MB, and at one zoom out, 68 MB.**

| viewport (the app's own padded box) | keys | features | geometry | **fetched** |
|---|---|---|---|---|
| Amsterdam z16 | 84 | 54 974 | 3.4 MB | **10.3 MB** |
| Amsterdam z14 | 779 | 344 195 | 21.8 MB | **68.4 MB** |
| open water / outside the block, z16 | 84 | 0 | 0 | **9.0 MB** |

The row above got 75–190 kB by multiplying the store-wide average tile (9.1 kB) by an unpadded
viewport (8–20 cells). Both factors are wrong in the same direction: **the average tile is rural and the
viewed tile is urban** (a city cell is 5× the mean), and a real viewport at z16 is 84 cells once padded.
This is `CLAUDE.md`'s own rule — *measure the common case, not the outlier* — with the outlier being the
average. The marginal cost is **~104–139 kB per key against ~31 kB of geometry**, and the third row is
the one that names the mechanism: **84 keys that hold nothing still cost 9 MB**, so most of that is the
per-key probe, not the payload.

**2 · No affordable padding is exact.** A layout feature is keyed by its FIRST VERTEX and never clipped,
so it overhangs its cell (PLAN-PERF §7g). A whole load hides this — the render path screens on each
tile's sealed extent — but a paged load cannot consult the extent of a tile it never fetched. Counting
features actually VISIBLE in an Amsterdam z16 viewport:

| pad | 0 | 1 | 2 | … | exact |
|---|---|---|---|---|---|
| tiles fetched | 50 | 84 | 126 | | 864 (z16) · 13 661 (z14) |
| features missed of 25 260 | 79 | 12 | 7 | | 0 |

`LAYOUT_PAD = 1` is the knee — 85% of the misses for 1.7× the tiles — and it is **a compromise, not a
fix**. What is left is a handful of very wide features: a province border, a power line, a railway, a
big water body keyed kilometres from where it is drawn. In a dense viewport that is invisible; in a
rural one it can be all four of the lines on screen.

**3 · Both problems have the same fix, and it belongs to F3's rebuild.** Bound a feature's reach at
GENERATION instead of widening the window at read time:

* **Bin each feature into a tile whose cell CONTAINS it**, with coarser tiers (×8 each) for the ones that
  do not fit the finest. Then *at its own tier a feature spans at most 2 cells*, so a window padded by 1
  cell **per tier** is EXACT — 4 tiers cover NL (500 m → 4 km → 32 km → 256 km), each feature is stored
  once, and the store does not grow. A low zoom then reads only the coarse tiers, which is also the
  answer to 68 MB: today a zoom-out multiplies the key count by 4 while the useful detail shrinks.
* **And reconsider `LAYOUT_CELL` (500 m) itself.** At ~110 kB of per-key cost against ~31 kB of payload,
  the grid is finer than the read path can pay for. A coarser cell cuts the key count 16× for the same
  area *and* shrinks every feature's span in cells, which improves 2 as well.

The alternative — storing each feature in every cell it touches — is measured at **1.5× the store**
(`layout_page_probe … spans` reports `dup_if_binned_everywhere` per kind: areas 211%, lines 404%), so it
is the expensive way to buy what tiering gives for nothing.

⚠ **None of this makes F1 wrong to have built.** The kernel has to page the layout under every one of
these designs, F2's O(collection) re-expose risk is now measured away rather than feared, and the gate
that holds the residual exists. What changed is F3: it was "cut NL into three regions", and it is now
"cut NL into three regions **and re-bin the base map**", with the numbers above as its acceptance test.

⚠ **The layout working set never shrinks**, exactly like the roads one (C1b): a session that pans across
a country accumulates every cell it has visited. Flat per-viewport cost over 13 viewports says nothing
about 500, and eviction is where §6b's Track 3 already puts it (blocks + stitching + LRU). It is a
session-length question, not a correctness one, and it wants measuring before it wants solving.

#### F3, and what it cost (2026-08-01)

**The exactness fix is two rules in the GENERATOR, and it is free.**

> A feature is keyed at the FINEST TIER whose cells its bbox spans at most 2 of, at the cell holding the
> bbox's MINIMUM CORNER.

Tiers step ×8 (500 m → 4 km → 32 km → 256 km) and share one store, the tier riding in the key above
`TIER_STRIDE`. The first rule bounds a feature's reach to one cell *at its own tier*; the second makes
that reach one-directional — a feature occupies its cell and the next one **up**, never the one below —
so a reader pads the low side only. Padding stops being a guess measured in lost features:

| on the shipped Enschede inputs | before | after |
|---|---|---|
| features missed at z16 / z14 | 7 / 5 | **0 / 0** |
| keys asked for a z16 viewport | 111 | **69** (93% of them hit, was 65%) |
| store bytes | 20 776 816 | **20 776 816** |

Conservation was checked rather than assumed at both scales: the same inputs through the old and new
binning give identical feature counts, and the country rebuild lands on **17 290 495 features — exactly
the published total** — in the same bytes, with ~130 extra coarse tiles.

**Cutting into regions puts a seam through ground people look at**, and that decided both the region
count and the cut rule. Measured at a cut, at the app's own default zoom: a straddling viewport holds
25 862 features and one region answered with **13 946 — 54%, half the screen silently blank.**

**So a region carries its neighbours' edges: every internal side is widened by a 0.10° MARGIN**, which is
wider than a padded z14 viewport (±0.0944° of longitude, measured off the app's own projection). One
region therefore answers any viewport at z14 or tighter whole — checked rather than assumed, on a
viewport centred exactly on a cut:

| z14 viewport centred on the 5.40°E cut | visible | drawn | missed |
|---|---|---|---|
| the single region whose band holds it | 61 631 | 61 631 | **0** |
| the whole-country store, same box | 61 631 | 61 631 | 0 |

**FOUR regions, not three, and the count came out of the arithmetic.** `layout_page_probe … lonprofile`
sums coords per 0.1° band — the weight is nothing like uniform, the Randstad carrying far more geometry
per degree than the north-east — and a size model calibrated on three measured cuts (fits within 1%) says
three regions cannot hold a 0.10° margin under the 900 MB cap; the eastern one lands at 957 MB. Four can,
with room:

| | west | midwest | mideast | east |
|---|---|---|---|---|
| base, cuts 4.7 / 5.4 / 5.9 | 555 MB | **794 MB** | 627 MB | 775 MB |
| roads (disjoint, no margin) | 104 MB | 129 MB | 107 MB | 162 MB |

Roads are split from the country block and conserve exactly — 2 785 476 ways and 234 253 barriers — and
they are cut WITHOUT a margin on purpose: the client stitches road blocks (S8) and a duplicated way is
not a slower match but a different one (`block_overlap_gate` enforces it). The base is the opposite case
and gets the margin. The two stores of one region no longer describe the same ground, and that is
deliberate.

⚠ **A REGION and a CHUNK want opposite cuts, and `trim_base` now has both.** A chunk is re-assembled, so
every feature must survive exactly once (`partition`, by tile origin — what `base_chunk_gate` counts). A
region is HOSTED ALONE, so it has to be a complete map of its own ground: `cover` keeps every tile whose
sealed EXTENT reaches the band. With the margin that costs **+27% features / +35% bytes** (2751 MB across
four against 2043 MB for the country), and that is the price of never showing a seam.

**The client keeps a covering SET as the backstop** — `baseUrlsFor`, `roadsUrlsFor` generalised over the
store kind rather than copied. The margin makes it a no-op at z14 and tighter (one block covers, one URL
is named); it is what answers a z13-or-wider viewport, and it is only possible at all because F1 made
the loads PAGED: `store_load_keys` accumulates, where the whole-file load it replaced adopted an image
and a second would have discarded the first.

#### Two defects this rung found, both silent, both now loud

1. **`store_persist_bind` ADOPTS AN EXISTING IMAGE.** Pointed at a file that already exists it keeps the
   old contents, writes none of the new ones, and returns **true**. The three-region cut was produced
   twice with different bands and the second run changed nothing: the tool printed the new feature counts
   and `persist true`, the file had a fresh mtime, and it still held the previous map — caught only by
   reading the extent back out of it. Every tool here that persists now refuses an existing target by
   name (`#PERSIST FAIL`), which is the difference between a wrong answer and an error.
2. **A tiered store's EXTENT no longer identifies a region.** A tier-3 tile is 256 km across, so a
   region's sealed base extent is whatever its widest tile covers: after the four-way cut all four base
   extents read lon 2.39..7.21 — the whole country, four times. Block selection by "smallest block
   containing the box" then picked an arbitrary region, and **Den Haag and Rotterdam rendered as two
   lines and nothing else** while the gate still passed on aggregate. `baseUrlsFor` selects on the ROADS
   extent (untiered, disjoint, genuinely geographic) and reads the base URL off the region it picks.
   ⚠ Anything else that treats a base extent as a geographic bound — `build_index.sh` writes one into the
   index — needs the same reading.

**What F3 did NOT fix, with the number:** a viewport still costs 12–24 MB paged (six real viewports
across the four regions: 99.7 MB, 1611 range requests), and the reason is not the geometry. A keyed read
costs **~100 kB whether or not the key exists** — 84 keys that hold nothing fetched 9 MB — so the bill is
dominated by asking, not by receiving. The min-corner rule cut the asking by 38% and correct region
selection halved the bytes again; that is the last cheap win on this side. The rest is either a coarser
`LAYOUT_CELL` (which trades probe count against over-fetch and has an optimum worth measuring) or a
cheaper absent-key probe in loft's paged loader, for which `layout_page_probe … pageload` is a
ready-made reproducer.

### 6g. PLANNING REGIONS AUTOMATICALLY — the design, and what it cannot fix (2026-08-02)

NL's four regions were cut BY HAND: a 1-D longitude weight profile, cuts read off the thirds, the 900 MB
cap checked afterwards. That does not survive Western Europe, and the reason is specific rather than
general — **a longitude cut cannot make a dense COLUMN smaller.** London, Paris, the Ruhr, Milan and
Berlin are each denser than anything in the Randstad, and any of them can put a strip over the cap on its
own. So the region plan has to be computed from the data, in both axes, before anything is built.

#### The pipeline: download → analyse → plan → build

The analysis pass reads the **geojsonseq exports**, not a built store. They exist immediately after the
osmium step, so nothing is built twice and no region is ever discovered oversized after the fact:

    acquire(PBF) → osmium per layer → COUNT COORDS PER CELL → plan regions → build only the plan

**Coords are the weight, because bytes are near-linear in them.** Calibrated on three measured regions,
`MB = 12.972/Mcoord + 40` predicts within 1% — the slope is a `Coord` (two i32) and the intercept is the
store's own fixed overhead. A pass that counts coordinates per 0.05° cell is a streaming line-scan of
files the pipeline already produces.

**The planner is a kd-split**: while any region's predicted size (INCLUDING its margin ring) exceeds the
cap, split the worst one along its longer axis at the WEIGHTED median. Prototyped against the real NL
grid it reproduces the hand cut and improves on it — 4 regions, max 727 MB against 794, duplication +33%
against +35% — and it splits the eastern half by LATITUDE, which the longitude-only cut could not do.

**Resolution is not the binding constraint, and that is the reassuring measurement.** At 0.05° NL's
densest cell holds 0.64 Mcoords ≈ **8.4 MB of geometry — 107× under the cap**. A metro would have to be
two orders of magnitude denser per km² than the worst cell in the Randstad before the grid could not
subdivide. Region sizing is therefore safely automatable; report the densest cell so the headroom stays
visible rather than assumed.

#### The two things the planner cannot fix

1. **The margin gets expensive exactly where regions get small.** The 0.10° margin is a RING, so
   duplication is `((S + 2m)/S)² − 1`: **+44% at 1.0° across, +96% at 0.5°, +178% at 0.3°.** Dense metros
   need small regions, which is where the ring costs most. So the margin must be per-region and
   cost-capped, falling back to the client's covering set (`baseUrlsFor`, already built and gated) where
   it is not worth paying. The planner should emit the margin it chose and the duplication it bought.
2. **⚠ PER-VIEWPORT COST IN A DENSE METRO, WHICH NO REGION PLAN TOUCHES.** An Amsterdam z14 viewport is
   already 21.8 MB of geometry; London or Paris will be several times that, and cutting regions
   differently changes it by exactly nothing — it is density per SCREEN, not per region. This is what
   would make those cities "suddenly problematic" for a user, and the only answer is generalisation: a
   zoom pyramid that drops buildings and simplifies areas at low zoom (§6f's back-pocket overview tier
   measured 75/94 MB for NL — **§6i is that design, measured**). **Measure a real Île-de-France or Greater London extract before committing
   to WE** — one download answers whether the viewport cost is 3× NL's or 10×, and that number decides
   whether generalisation is the next rung or the one after.

*Do not build the planner and conclude WE is solved.* It removes one failure mode — a region that cannot
be hosted — and leaves the one a user actually feels.
