<!--
Copyright (c) 2026 Jurjen Stellingwerff
SPDX-License-Identifier: LGPL-3.0-or-later
-->

# The block pipeline — generating at scale, hosting, publishing, staying current

**Kind:** reference · **Status:** current · **Last verified:** 2026-08-04 · **Owns:** how blocks are generated at scale, hosted, published, stitched and kept up to date

`PLAN-SCALE` §6d, §6e, §7, §8 and D2. Everything between *the data exists* and *a visitor reads it*:
the generator's memory ceiling, how many files stitch themselves, what a host must do, the refresh
procedure, and how often a region has to be rebuilt. **§7 is the part that runs forever**, and the
one most easily under-planned.

⚠ **Section numbers are global to `PLAN-SCALE.md`** — they were not renumbered when this file was split out, so a citation of `PLAN-SCALE` §6e still resolves. Its *Where each section lives* table says which file holds which §.

---

### 6d. The offline Android app — a later track, and it is smaller than it sounds

**Placed after the EU rungs by choice, not by dependency.** Recorded here now because its SIZE is already
measurable, and the number changes how the rest of the plan should be read.

**What it is:** an Android build that preloads a route plus everything within **≥3 km of it**, so a ride
through a valley with no signal still has its map and can still re-route.

**Three of the four pieces already exist**, which is why this is a small track rather than a project:

| piece | state |
|---|---|
| naming the cells within N km of a route | ✅ `corridor_cell_keys(pts, margin, tube)` — margin is **in metres**, so a 3 km pack is `margin = 3000.0`. This is the same call the matcher already makes |
| fetching exactly those cells | ✅ `store_load_keys` over HTTP Range, proven in the browser (C1b/S1) |
| an Android target | ✅ `loft --native-android [out.apk]` — a signed APK; present in the installed binary (needs `ANDROID_NDK_HOME` + `ANDROID_HOME`). **Unverified here** — nothing in this repo has built it |
| writing the pack to local storage and reading it back offline | ❌ the only new part: persist the fetched working set, then `store_load` it from a file instead of a URL |

**And the pack is small.** From §1's measured bytes/km² (roads 12.4 kB, base 73.5 kB) over a corridor of
`2·m·L + π·m²`, at m = 3 km:

| route | corridor | roads | + base | total |
|---|---|---|---|---|
| 25 km | 178 km² | 2.2 MB | 12.8 MB | **15 MB** |
| 50 km | 328 km² | 4.0 MB | 23.6 MB | **28 MB** |
| 100 km | 628 km² | 7.6 MB | 45.1 MB | **53 MB** |
| 200 km | 1228 km² | 14.9 MB | 88.2 MB | **103 MB** |

A day's ride is tens of megabytes. **The offline app is not a scale problem** — it is the working-set
machinery pointed at a file instead of a socket, and the 3 km margin is one argument.

⚠ **The honest consequence of that table:** this track does **not** technically depend on WE coverage, or
on C5, or on the base-map paging question in §6c N4 — a pack is built from whatever blocks exist, and it
only ever touches a corridor. It is scheduled late because that is the wanted order, not because it is
blocked. If the phone-in-a-valley case ever becomes the urgent one, it can be pulled forward to just after
**N3** (NL roads live) and give offline routing over the Netherlands with a base map wherever one exists.

**What it still needs designing, when it comes:** which zoom levels the base pack carries (73.5 kB/km² is
*all* of it — dropping buildings outside urban cells is the obvious lever if 103 MB is too much), pack
expiry against §8's freshness target, and whether a pack is per-route or a pinned region.

### Many files stitch themselves — and the one property that makes that true

**`nl-west` and `nl-east` are not two maps.** A route from Amersfoort to Apeldoorn crosses the 5.40°E seam,
draws **30 cells from west and 60 from east**, and produces byte-identical geometry to the unsplit country:

```
#N whole  ways=10935 route_pts=148 fp=555142227
#N split  west_cells=30 east_cells=60 ways=10935 route_pts=148 fp=555142227
```

There is no stitching STEP. Splits are by cell so nothing is clipped; `store_load_keys` accumulates, so one
working set is filled from each covering block in turn; and the index turns a command's box into that
covering set. The mechanism does not care whether there are two files or forty — a corridor names the two
or three blocks it actually crosses.

**What it does care about is disjointness**, and that is the one thing the index cannot check: it stores
extents, and extents legitimately overlap because a feature is keyed by its FIRST VERTEX and never clipped.
Only the cell sets settle it. A cell held by two blocks an index can name together delivers its roads
twice — not a slower match, a different one — and it survived once only because `build_graph` dedups nodes
by coordinate (7,138 ways became 9,438 for an identical route).

`tools/block_overlap_gate.sh` (in `make test-native`) asserts it, **per resolvable set**: a region is
reachable from exactly one index, so blocks in different indexes may overlap — the Enschede block that
ships with the app sits inside the Netherlands regions and shares 84 cells with `nl-east`, which is correct
and harmless. The first version of the gate compared everything to everything and failed on exactly that;
the ambiguity was in the model, not the data, and the rule is now stated precisely.

⚠ **This is the check to run before Western Europe is generated.** Blocks cut from ONE extract on cell
boundaries are disjoint by construction — that is how the NL halves were made. Blocks taken from
**per-country Geofabrik extracts are not**: those deliberately include cross-border data, so `france` and
`belgium` would both hold ways near Lille. WE must be cut, not collected.

---

### D2 — the CORS host, made testable (2026-07-30)

⚠ **CORRECTED 2026-07-30 — the first version of this section was WRONG, and it was load-bearing.** It
said GitHub Pages cannot serve a byte range, and that is the claim that sent the Netherlands blocks to a
release asset. Pages serves ranges correctly. The bad measurement was taken against
`python3 -m http.server`, standing in for Pages, which ignores `Range` and returns the whole file — and
python's behaviour was written down as GitHub's. Re-measured against the live site:

| surface | `Range` | CORS | verdict |
|---|---|---|---|
| **GitHub Pages** | ✅ **206, 16 bytes asked → 16 transferred, correct bytes at 3 offsets** | same-origin for our app; also sends `ACAO: *` | **usable — and it is the app's own origin, so CORS does not arise** |
| jsDelivr `/gh` | ✅ 206 | ✅ `ACAO: *` **and** `expose: *` | usable; per-file limits apply |
| raw.githubusercontent | ✅ 206 | ✅ `ACAO: *`, but **no** `expose-headers` | usable only with a `HEAD`→`Content-Length` fallback for size |
| release asset | ✅ 206 + `Content-Range` | ❌ no ACAO even with `Origin` | downloads, native, offline — not the browser |

So **D2 is not a wall and no bucket is required**. What limits GitHub hosting is SIZE, not capability:
Pages allows ~1 GB per site, and NL roads are 504 MB (fits) while roads+base is 3.2 GB (does not). The
stores are also ~45–55% preallocated zeros — two different regions weighed a byte-identical
1 437 020 160 — so a store persisted at its true size would put NL near 1.5 GB.

The gate below is still exactly right and still the acceptance test for any *other* host; only the claim
about Pages was wrong. `tools/cors_host_gate.sh` (in `make test-map`) serves the app
on one origin and its blocks on another and drives the real app across it:

```
data origin: HTTP 206, ACAO header present: 1
✓ rendered from a DIFFERENT origin: # view: R=3112
✓ matched across it: SUMMARY ways=7138 route_pts=213 len=13138.0m
✓ read BY RANGE across origins: 58 reads, 3.5 MB = 96.2% of the block
```

**Four requirements, each of which the gate catches**, and two were only found by building it:

1. a real `206` with `Content-Range` — Pages fails this;
2. `Access-Control-Allow-Origin` for the app's origin — release assets fail this;
3. ⚠ **an OPTIONS preflight that allows the `Range` REQUEST header.** `Range` is not CORS-safelisted, so
   the browser asks first, and a host answering only GET is indistinguishable from one with no CORS at
   all. My own test host failed exactly here;
4. ⚠ `Content-Range` in `Access-Control-Expose-Headers`, or the reader cannot learn the file's size.

`data/bucket-cors.json` is that policy and `tools/publish-bucket.sh` applies §7 R6's order to a bucket —
upload, verify every object for all four properties, index last. It needs credentials this machine does
not have; everything else is done.

⚠ **An index must not mix reachable and unreachable hosts.** The gate's first version built an index
naming both the local CORS host and the GitHub-hosted NL regions; a match whose padded box escaped the
small block named both, the release-hosted read failed for want of CORS, and **the whole working set went
down with it** — `ways=0`, an empty route, on a host that was working perfectly. One unreachable block in a
covering set does not degrade a match, it ends it. That is why each index names only what it can serve.

*Two of my own assertions were vacuous before this gate worked:* it first passed while the match returned
`ways=0` (the summary was non-empty, so the check said nothing), and the range counters counted requests
rather than deliveries, so blocked reads still reported "38 reads, 2.3 MB". Both are fixed — the counters
count what arrived, and the gate requires a real route.

---

### 6e. Western Europe needs a streaming GENERATOR, not a smaller store (2026-08-01)

C2's wants column has said **"multi-block, hosting, a generator that streams"** since it was written. This
is what that turned out to mean once the NL numbers existed, and it corrects two things the earlier rungs
assumed.

#### The client already streams, and already scales. Do not rebuild it.

| measured | |
|---|---|
| a route on a country block | **17.7 MB of 222.4 MB (8.0%)**, 271 Range reads (`nl_live_gate`) |
| a base-map tile | **9.1 kB** on disk (1058.3 MB / 116 561 tiles) |
| ⇒ one viewport of base map | ⚠ **RETRACTED — see §6f.** This multiplied the store-wide average tile by an unpadded cell count and read **75–190 kB**; measured, a viewport is **8.1 MB** and a dense metro one **21.8 MB**. The *independence* from store size still holds; the number never did |

That last row is the important one: a viewport costs the same against an 88 GB base map as against a 1 GB
one, because `store_load_keys` fetches cells, not files. **The read path is not what stops WE.**

#### The generator is the wall, and it is arithmetic

`client/basemap/build_store.loft` streams its INPUT (1 MB chunks, so a 4 GB geojsonseq is fine) and then
accumulates the entire store in memory, writing it once with `store_persist_bind`.

    NL base:  17.29 M features  →  ~6 GB RSS   ≈ 350 bytes/feature, linear
    WE base:  390–780 M features (§1's 44–88 GB at ~113 B/feature payload)  →  130–270 GB RSS

> ⚠ **THE 130–270 GB IS A `store_persist_bind`-LAST NUMBER, and that is no longer the only option
> (2026-08-03).** It measures a generator that accumulates an unbound `hash` — anonymous heap, which the
> kernel cannot reclaim. **Binding the store FIRST and inserting into it is 2.8–5.3× cheaper, and its
> pages are file-backed and evictable**: under a cgroup cap with swap disabled, a bind-first build
> completes in half its own uncapped RSS while a bind-last build of the same data is OOM-killed. So
> dataset size sets a *throughput* cost for a bound store, not a memory requirement.
>
> This § predates that. It was written against loft 2026.8.0 md5 `0849e437…`, where
> [loft#746](https://github.com/loft-lang/loft/issues/746) broke the bind-first insert path outright — and
> the plan that reported it ([@51](plans/51-coverage-past-nl/README.md)) had the direction *backwards* as a
> result. The measurement is now `tools/bind_order_gate.sh`, re-runnable against whichever binary is
> installed.
>
> **What this does NOT settle:** WE itself. The gate measured to 1.6 M features; WE is ~390–780 M. The
> floor is real (400 k completes at 48 MB, dies at 32) and capping costs ~2× wall. So the region structure
> below stays — it is still how this gets built — but it is now a *throughput and CI* choice rather than
> the only way the data can exist. `PLAN-SCALE` should not be re-planned around one gate run.

Nothing tunes out of that *for a generator that binds last*. Two ways past it:

* **make the store writable incrementally** — ✅ **it already is** ([loft#747](https://github.com/loft-lang/loft/issues/747);
  bind first, then insert). What remains open upstream is only an eviction *hint* — a way to say "this
  tile is finished" — which turns the cap's throughput cliff into a curve;
* **never build a store that big.**

The second needs nothing from anyone, and it is not a workaround: **C4/C5 already specify 10–16 roads
blocks and 25–45 base blocks.** The generator never has to stream a continent; it has to do one region at a
time. What was genuinely missing is an ACQUIRE step that produces those regions without reading a 30 GB
continent extract once per region — and osmium already has it (`osmium extract --config`, one pass, many
outputs; verified on osmium 1.16).

    europe-latest.osm.pbf (~30 GB)
            |   ONE `osmium extract --config` pass
            +-- region-01.pbf --+
            +-- region-02.pbf   |   per region, independent -> CI matrix, parallel
            +-- ...             |     build-blocks -> roads + networks
            +-- region-NN.pbf --+     gen-names / build-base
            |
            +-- one index naming all of them -> CORS host (D2), read paged

Every step is bounded by ONE region; nothing ever holds a continent. It is also the same change that makes
the base map buildable in CI at all (N6 runs `--no-base` today purely because one region does not fit).

#### Chunk size falls out of DISK, not RAM

NL needed **~11.7 GB of intermediates** for 17.29 M features (1.8 GB areas + 4.1 GB buildings + 1.0 GB
streets geojsonseq, then a 2.0 GB store) — about 680 bytes/feature. Against a ~10 GB working budget that is
**~15 M features per chunk ⇒ 34–68 chunks for WE**, which lands on C5's independently-derived 25–45. Two
estimates from different directions agreeing is mild evidence both are roughly right.

#### Where the base map's bytes actually are

Measured on `nl-east` (746 MB of payload, `tools/census.loft` + the `.dschema` record sizes):

| | count | coords | payload | share |
|---|---|---|---|---|
| **buildings** | 5 599 287 | 44 495 091 | **400.8 MB** | 53.7% |
| **areas** | 1 545 108 | 34 393 421 | **287.5 MB** | 38.5% |
| labels | 619 320 | 1 504 651 | 24.4 MB | 3.3% |
| lines | 249 389 | 1 511 552 | 15.1 MB | 2.0% |
| pois | 555 995 | — | 8.9 MB | 1.2% |
| tile headers | 116 561 | — | 9.8 MB | 1.3% |

Buildings and areas are **92%**. Buildings are already lean at 7.9 coords each — there are simply 5.6 M of
them; areas at 22.2 coords are the softer target for simplification. But the honest conclusion is that
there is no 5× here: dropping buildings ENTIRELY and halving areas still lands at ~700 MB for two halves,
against ~390 MB of remaining Pages budget. **Shrinking does not reach Pages. Splitting does not either** —
the cap is on total site bytes, so 2 GB in eight parts is still 2 GB. Only a different host does.

#### Ceilings to raise before they bind

* ~~⚠ **`tools/block_overlap.loft` caps an index at 62 blocks**~~ — **RAISED, and now gated.** The owner
  mask became an owner LIST (`8fe43a7`), and `block_overlap_gate.sh` runs the checker at **70 blocks**
  (2 415 pairs) *and* re-rejects a manufactured partial overlap at 72, so it cannot pass on volume alone.
  It is also faster: the mask forced an O(blocks²) scan per cell where almost every cell has ONE owner.
  Left here for the record; the ceiling that would have bound at 34–68 chunks is gone. The old note:
  its comment claimed 62 was "far above the per-index counts C2 contemplates" — true when written, and no
  longer true at 34–68 chunks. Cheap to fix (count per pair rather than masking); fix it before it is
  load-bearing, not after.
* `MARK_BLOCK = 10000000000` in `web_basemap_kernel.loft` namespaces cell marks as `block * MARK_BLOCK + k`
  — fine to ~9e8 blocks on i64, so not a concern, but it is the other place block count is encoded.

#### The order I would do it in

1. ✅ **Chunked base build — DONE 2026-08-01.** `tools/build-base-chunked.sh` cuts a region into n
   longitude bands and builds each as a whole region (roads then base, since the base map's street labels
   come from the roads export for the same box). `tools/trim_base.loft` makes them disjoint: `osmium
   extract` keeps whole ways, so a feature straddling an edge lands in both neighbouring extracts and is
   binned by its first vertex to the same tile in both — trimming to a half-open cell band leaves it in
   exactly one. **Measured on Enschede: 600 + 519 = 1119 tiles and 138 219 + 72 054 = 210 273 features,
   identical to n=1, no shared cells.** `tools/base_chunk_gate.sh` asserts it and is verified to fail (a
   trim that keeps everything gives exactly 2×).
   Two mistakes worth keeping, both caught by counting: **the margin belongs on INTERIOR seams only** (on
   the outer edges each end chunk extracted past the region and kept the overshoot — 355 554 against
   209 932, a larger map rather than a partition), and **the control must be n=1 through the same script**
   (comparing against the shipped block showed a 341-feature gap that was OSM drift between two build
   dates, not chunking).
   **NL at n=4 (2026-08-01):** 185 559 tiles / 17 290 483 features against 185 564 / 17 290 495 from
   n=1 on the same inputs — 99.99997%, with the four chunks a disjoint partition (185 559 cells, no
   overlap). The shortfall is 5 tiles / 12 features, and its SHAPE is the point: **12 across 3 interior
   seams is 4 per seam**, a boundary constant rather than a data-proportional loss. The gate bounds loss
   per seam and treats any SURPLUS as a hard failure. Mechanism is a labelled hypothesis (a multipolygon
   straddling a seam by more than MARGIN); `osmium extract --strategy=smart` and a larger margin are the
   untried candidates.
   **Wired into CI (2026-08-01):** `data-refresh.yml` now runs `refresh` (roads + names) →
   `base-chunks` (matrix of 4, `CHUNK_ONLY=k`) → `base-assemble` (`merge_base.loft` back into
   nl-west/nl-east, then publish). ⚠ Chunk edges must be a **superset of the REGION edges** or no
   grouping of chunks is a region — `CHUNK_EDGES` exists for exactly that, and the NL edges include 5.40.
   *Still to do:* actually run the workflow once (it has never fired), and settle the per-seam loss.
2. ~~**Raise the 62-block cap**~~ — ✅ **done and gated** (owner list, proven at 70 blocks; above).
3. **Price D2** — the cost check C5 is already gated on, and the thing that decides whether the WE base map
   is coverage or opt-in. `tools/cors_host_gate.sh` passes today, so the path is tested, not hypothetical.

Leave the streaming-store ask upstream alone unless step 1 proves chunking cannot hold it.

## 7. Phase R — the update procedure (the recurring cost)

Everything above is a one-off. **This is the part that runs forever**, and today it does not exist:
`tools/build-blocks.sh` is unwritten (HANDOFF §11), the elevation cache path is known-broken on re-runs
(PLAN-TILES §3), and the current block was made by hand. Designed so that **a single stale country costs
one block, not a continent.**

```
manifest(regions) → acquire(PBF) → per-region osmium → elevation cache → generate block
                 → verify block → publish under v<date>/ → flip the top index → clients migrate
```

**R0 · The manifest is the source of truth.** `data/coverage.toml`, in the repo, versioned: one row per
region — id, bbox, source PBF, split parent, expected size band. Everything downstream is a function of
it, and a diff to it is the only way coverage changes. *Gate:* the manifest generates the top index; CI
checks the regions tile WE with no gaps and no overlaps beyond the border ring.

**R1 · Acquire, checksummed and cached.** Geofabrik per-country extracts (~30 GB for WE), pinned by their
published `.md5`, into a content-addressed cache. *Gate:* a re-run with no upstream change downloads
nothing.

**R2 · Per-region osmium passes** — `extract --bbox` → `tags-filter w/highway` → `export -f geojsonseq`.
Parallel across regions, **resumable per region**, each step's output cached by (source hash, bbox, step).
*Gate:* killing the run mid-way and restarting reproduces the same intermediates and skips finished work.

**R3 · Elevation.** Terrarium z12 tiles per bbox in a **shared, persistent** cache — the current
per-run re-fetch is the known bug, and at WE scale it is the difference between one fetch and forty. Also
the point where `h: 0` finally gets populated (HANDOFF §11 — gradient routing is wrong nationwide until
it is). *Gate:* second run fetches 0 tiles; a known relief profile matches within tolerance.

**R4 · Generate one block.** Native loft, streaming input (S6), Hilbert-ordered (S3), `.dschema` written,
output named `<region>-v<YYYY-MM-DD>.store`. ✅ **The cell-key packing is fixed (2026-07-30) — it was wrong
west of Greenwich.** `tools/gen-tiles.loft` packs `key = ty * 1000000 + tx` with truncating division, so a negative
`tx` aliases the previous row (`ty=100,tx=-5` collides with `ty=99,tx=999995`) and the two cells either
side of the meridian both fold onto `tx=0`. Invisible for this block (all of it is east of Greenwich) and
**silent data loss for FR / ES / UK / IE / PT**, which is most of the coverage. It was a data-format
change, so it landed **before** any block west of 0° exists rather than after — at one block, which is the
cheapest this migration will ever be.

*The fix was already written, one library over.* `lib/basemap` keys its layout tiles with a parametric
packing — biased axes, a row multiplier that scales with cell size, floored `cell_ix` — and
`client/basemap/grid_test.loft` already **proved the routing packing collides** at a finer cell. Routing
now uses the same scheme (duplicated, not imported: the server links `routing_kernel` without the map).
`tools/rekey_tiles.loft` migrated the shipped block — 88 tiles, all moved, roads/steps untouched, and it
refuses to write if two tiles ever land on one key. Route byte-identical throughout: the border gate's
three golden fingerprints, `match_parity`, and the browser's pixel hash `917244eb`.

**That tool is also the template for R4's every future migration**: read the old image, write a new one,
prove the route is identical, keep the old file until it is. *Gate:* per-block counts within a band of the previous
version — a block that suddenly loses 30% of its ways fails rather than ships.

**R5 · Verify per block, before anything is published.** Four checks, because a bad block is invisible
until someone routes through it:
1. `store_load_key` spot checks with `LOFT_LOADER_STATS=1` — opens, pages, and the entry equals a whole
   load. **`tools/paged_gate.sh` + `tools/paged_probe.loft` already do this** on the shipped block (in
   `make test-native` as of this plan); per-block it runs against the freshly generated store.
2. **Route parity** — a fixed sample of sketches per block matches identically to the previous version,
   or the diff is inspected deliberately (`match_parity.sh` shape).
3. **Border continuity** with each already-published neighbour (S8's gate).
4. **Layout identity** — the `.dschema` matches the client's compiled types. *A store-format change fails
   SILENTLY otherwise* (HANDOFF §3): no output, no error, exit 1.

**R6 · Publish atomically, and PIN each block's hash.** The top index carries every block's `sha256`, and
the client loads with **`store_load_url`** (the verifying loader) rather than `store_load_url_trusted` —
newly available on the browser target as a loft#678 follow-up, which noted the asymmetry precisely: *"the
browser could fetch a whole store but could not PIN its hash: the weaker half of the pair, on the target
most likely to be loading third-party bytes."* At WE scale the blocks live on third-party object storage,
so this is the difference between trusting a CDN and verifying it. Upload blocks under `v<date>/`, verify
each object's size and a Range read of it, **then** flip the top index — the index is the only mutable pointer, so a half-uploaded release is
never visible. Keep the previous version for a grace period. *Gate:* a client pinned to the old index keeps
working throughout the upload.

**R7 · Client migration.** The index carries the version; IndexedDB caches are keyed by it, so a new
version invalidates nothing and costs only what the user actually re-visits. *Gate:* a scripted session
across a version flip does not re-download unchanged blocks.

**R8 · Budget, measured once and written down.** Wall-clock and disk for the WE run, from one
representative block × the region count: osmium hours, generation hours, peak disk (source + intermediates
+ output), upload bytes. Then the cadence follows from the number instead of from optimism. *Gate:* the
figure lands in this section, and a **single-region hotfix** is timed separately — that is the number that
matters on a bad day.

**R9 · Rolling refresh, not a big bang.** The unit of refresh is **one block**, so the steady state is a
queue: regenerate the K oldest blocks each run, publish, flip the index once per run. Whole-WE freshness
then follows from K and the cadence rather than from anyone finding a free weekend. *Observable:* a run
touches only the blocks it claimed and leaves the rest of the index alone. *Gate:* a run that fails
mid-queue leaves a fully consistent index (the previous version for every block it did not finish).

**R10 · Where it runs (D9).** WE needs ~30 GB of source, tens of GB of intermediates and hours of CPU, and
GitHub Actions gives ~14 GB of disk and a 6 h job — so the refresh runs on the **maintainer's machine or a
self-hosted runner**, driven by `tools/build-blocks.sh`, resumable (R2) so one run may span days. CI's job
is the *checks*, not the build: it validates the manifest (R0) and the published index. *Gate:* a run
interrupted by a reboot resumes and produces byte-identical blocks.

⚠ **Sequence R deliberately before S10 — and start it at C1.** Shipping WE-wide data you cannot regenerate
is how a dataset becomes frozen: the first schema change or OSM correction strands it. Running the
procedure when the dataset is one block is nearly free and is the only way the 40-block version is ever
trustworthy.

---

## 8. "Up to date" — the steady state, and how we know

A rung is not done when the data is *published*; it is done when the data is **current and visibly so**.
This is the part that has no natural forcing function, so it gets an explicit target and an alarm.

- **The target.** Every block in coverage is regenerated **at least every 30 days**, aiming at 14. OSM
  moves daily and Geofabrik republishes daily; a month-old cycling network is fine, a year-old one is
  wrong in ways users notice (a new bridge, a closed path).
- **The arithmetic that makes it true.** ~40 blocks at C5 (~16 at C4) ÷ a 14-day cycle = **~3 blocks per
  day at C5, ~1 at C4**. That is the K in R9, and it is what the cadence has to sustain — if R8's measured
  per-block cost makes that impossible, the answer is fewer/bigger blocks or a longer target, decided on
  the number rather than discovered by drift.
- **Freshness is data, not folklore.** Each block carries `generated_at` and its source PBF's date; the
  top index aggregates them. The app **shows the age of the data under the cursor** — partly honesty,
  partly because a visible number is the only staleness monitor that never gets muted.
- **The alarm.** A scheduled check reads the published index and **fails when any block exceeds the
  target**, naming it. That check is the difference between a plan that claims freshness and a dataset
  that has it. *Gate:* it fails today against a hand-made block older than 30 days — which is exactly what
  the current one is, so the alarm is provably wired to reality before it is trusted.
- **Regeneration must be boring.** Anything that makes a refresh scary (a manual step, a broken elevation
  cache, no resumability, a format change without a parity gate) will make refreshes rare, and rare
  refreshes are the failure mode. Every R-step above exists to keep this one property.

**Definition of done for the whole plan:** a cold visitor on a phone routes anywhere in coverage; the
oldest block in the index is inside the target; a single stale region is one block's work to fix; and no
step in doing any of that required a codec of our own.

### 8b. One cadence for every region stops working before the world does (2026-08-03)

Everything above assumes **one** target for every block, and that is right up to Western Europe: ~40
blocks on a 14-day cycle is ~3 blocks a day, which one machine sustains. It is not right for the world,
which is roughly another order of magnitude on top of WE's 44–88 GB of base map.

**Two decisions, and they are different.** The world as *coverage* is a hosting-and-funding question —
Pages is out well before it, and the maintainer's position is recorded: **Western Europe as a recurring
build is fine; the world needs funding and probably a dedicated host, and is not something to absorb
quietly.** Nothing in this plan should be designed as if it were free. The world as a *refresh cadence*
is the engineering half, and it is the cheaper problem: refresh less where less has changed.

#### ⚠ "Sparse" is the wrong key, and this repo already has the measurement that says so

The obvious rule is *refresh sparse regions less often*. It conflates two different axes, and @51 phase A
measured them apart:

| | by road ways | by base-map bytes |
|---|---|---|
| Belgium vs the Netherlands | 53% | **44%** |
| Luxembourg vs the Netherlands | 6% | **2.6%** |

Density predicts a region's **SIZE**. It says nothing about its **CHANGE RATE**. Keying cadence on
density starves a sparse region that is being actively mapped — exactly where a new path is most likely to
be the thing a router gets wrong — while rebuilding a dense but stable one every fortnight for nothing.
The same error in miniature is `PLAN-PERF` §7h: an aggregate that wins on average and loses on the
interaction anyone actually performs.

#### The key is measured change, and it costs no build to read

OSM publishes what moved. Geofabrik ships per-region diffs with change counts, so *"how much of this
region changed since the snapshot we shipped"* is a download of kilobytes and no generation at all — the
same shape as `tools/tiling_probe.py`, which answers a tiling question in **8.4 s against a 25-minute
build** and is trusted precisely because it was validated against real blocks before being believed.

So the design is: **a region's target is derived from its own measured change rate, and the alarm keys on
the region's own target rather than one global number.** The machinery is mostly present —
`refresh-region.sh <id>` has always been per region, so nothing forces a global refresh; what is missing
is a cadence field in the manifest and something that sets it.

Three things to get right when it is built, each of which is a failure this repo has already paid for
somewhere else:

1. **The measurement must be a gate, not a script someone runs.** A cadence chosen by a probe nobody
   re-runs is a cadence frozen at the day it was picked (`tools/bind_order_gate.sh` is the standing
   example of what that costs).
2. **A region that has never been measured must read as URGENT, not as fresh.** Absent evidence is not
   evidence of stability — the same rule that makes `heldGroundFor` gate on what a view actually
   RETURNED rather than on an extent that claims to cover it.
3. **Publish the cadence, not just the age.** §8 already says the app shows the age of the data under the
   cursor; if the target varies per region, the age alone is unreadable — 20 days is fine in the Ardennes
   and late in Amsterdam.

---
