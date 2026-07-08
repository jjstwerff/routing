<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# PLAN-BASEMAP — the presentation layer (terrain, buildings, names)

A **second, separate** dataset that gives the map terrain types, building footprints, and names — so it
reads like a real map instead of a bare road network — **without touching the routing routines**. It is a
sibling to the routing block: same cell grid, same coordinate encoding, completely separate store.

## The invariant (the hypothesis this design rests on)

> **The presentation set is strictly additive and isolated: the loft routing kernel's output is
> byte-identical and its cost unchanged whether the presentation set is present, absent, or malformed.**
> It lives in its own store the matcher never opens. The routing block and the presentation block share
> **only** two things: the tile grid (`tkey`) and the OSM snapshot date.

Everything below is in service of that one rule. If any step makes the matcher's route or timing change,
the step is wrong, not the gate.

### Failure paths this separation avoids (why not one dataset)
- Presentation geometry in the routing block → `build_graph` bloats, Dijkstra/Viterbi slow. *(Buildings
  alone — NL's near-complete BAG footprints — would dwarf the road data.)*
- Shared geometry references → the two can't be versioned, tiled, or loaded independently.
- Whole-block load of buildings → defeats the working-set model; buildings only make sense per-cell.

### Re-assertion sites (N) — where isolation could break
The *only* place routing could ingest presentation bytes is `client/web_kernel.loft`'s `host_input`
blob (`"sketch|profile\n<routing dataset>"`). **N = 1.** Keep omission loud: an isolation gate asserts the
in-browser route stays byte-identical (90 pts on `real_stretch`) **and** `lib/routing_kernel/**` +
`client/web_kernel.loft` are untouched by any step here. Any leak trips it.

### The over-unification trap (the cleanest claim, probed)
Tempting clean story: *"one store, one grid for the whole world."* False absorption — the routing corridor
load (a tube along the route) and the map viewport load (a rectangle) are **different queries**. Keep them
**two stores that share the grid**, not one store. Same `tkey` cells, different selection. Resist the merge.

## Schema (the presentation store)

Its own keyed store, mirroring `hash<TTile[tkey]>`; a cell holds three feature kinds. Coords reuse the
routing block's fixed-point (1e-7°) deltas from the tile origin.

Five geometry-typed record kinds cover a full base map. Fields are `text` (no enums in loft); `cover`
because `use` is a loft keyword. `name` is `""` when absent.
```
struct Coord    { x: i32, y: i32 }
struct Area     { cover: text, ring: vector<Coord> }           // filled polygon: landcover + parking/camp/ruins-area/playground
struct Building { name: text, ring: vector<Coord> }            // footprint polygon
struct Line     { kind: text, name: text, geom: vector<Coord> }// stroked line: stream/ditch/river, railway (simplified like streets)
struct Label    { name: text, kind: text, rank: integer,       // place + street name labels
                  line: vector<Coord> }                         //   street: simplified centerline (option B); place: 1 point
struct Poi      { kind: text, name: text, at: Coord }          // point icon: tree, bench, viewpoint, tower, ruin-point,
                                                                //   + stream crossings (ford, stepping_stones, footbridge)
struct PTile    { tkey: integer, ox: integer, oy: integer,      // same grid MECHANISM, its OWN cell size
                  areas: vector<Area>, buildings: vector<Building>,
                  lines: vector<Line>, labels: vector<Label>, pois: vector<Poi> }
```
`Line` and `Poi` were added after S5.2 (evaluating afstandmeten's coverage): the OSM detail we lacked —
individual trees, parking, playgrounds, viewpoints/lookout towers, benches, campsites, ruins, **streams
and where to cross them (fords / stepping-stones / footbridges)** — is all "current data", and fits the
SAME store/tiling/encoder. Polygon ones reuse `Area` (extend `area_use`); water/rail lines are `Line`
(a `Label` clone, DP-simplified); point symbols incl. crossings are `Poi` (shallower than what S5.0 already
round-tripped — one re-probe when added). **Density:** individual trees rival buildings → high-zoom only
(S13); streams/rail are moderate; crossings/benches/viewpoints are sparse. All presentation-only — S0 unaffected.

**Same mechanism, its own tile size; separate store.** `PTile` reuses the routing tiling *mechanism* —
grid-index `= coord/CELL`, a packed `tkey`, fixed-point coords as deltas from `ox,oy`, a `bbox → cell
range` resolver, `store_load_keys` — but with its **own `CELL`** (a parameter, likely finer than routing's
2 km for building detail, and per-zoom later at S13). So the two do **not** align cell-for-cell and needn't:
the resolver maps a viewport to *each* store's own grid independently. Two consequences that "it still
works at any size" forces:
- The key packing must **scale with `CELL`** — routing's `tkey = ty*1e6+tx` assumes `tx < 1e6` (true at
  2 km); a finer cell overflows it, so derive the multiplier from `CELL` (or use a non-colliding packing).
  Reimplementing the mechanism — not reusing routing's hardcoded key — is what makes this safe.
- The i32 delta-coord encoding holds as long as `CELL × 1e7 < 2³¹` (cell ≲ 0.2°) — fine for any map cell.

`PTile` lives in its **own store file**, never in `TTile`/the routing `.tiles`: folding 22 k buildings +
7 k areas into the block the matcher loads would bloat it ~100× and couple the two (S0 would fail). The
mechanism is **reimplemented** in the presentation code (parametric in `CELL`), not extracted from
`routing_kernel.loft` — extracting would modify the frozen kernel and trip S0. The two share a documented
grid *contract* (same algorithm, independent parameters), not shared code; unifying the code is a later
refactor, outside the isolation-preserving basemap work.

- **`AreaUse`** — a compact enum, many OSM tags → ~10 fill colours: `water, forest, grass, park, farmland,
  residential, industrial, sand, wetland, bare`. This is what produces the "terrain types" look.
- **`LabelKind`** — `city, town, village, hamlet, suburb` (from `place=*`) and `street` (from `highway`+`name`).
- **Street labels carry a simplified centerline** (Douglas–Peucker), so the renderer places the name
  *along* the road and can **repeat it at intervals when zoomed in** — the label is multiplied along a long
  street at high zoom, single at low zoom.

## Sources (OSM → schema)

| schema | OSM |
|---|---|
| `Area` | `landuse=*`, `natural=water/wood/wetland/…`, `leisure=park/…`, `waterway=riverbank` → `AreaUse` enum |
| `Building` | `building=*` → ring (+ `name` if tagged) |
| `Label` place | `place=city/town/village/hamlet/suburb` nodes → point + rank |
| `Label` street | `highway=* name=*` → simplified centerline + name |

Extracted by a **second osmium pass** — the roads pass (`w/highway`) that feeds routing is unchanged.

## Steps — each is `Do → Check → Probe`

Small, ordered, independently verifiable. `Check` = the concrete pass/fail. `Probe` = the falsification test
for a load-bearing claim (only where one exists). **S0 runs first and re-runs after every phase.**

### Phase 0 — the isolation gate (build the invariant's falsifier first)
- **S0. Isolation gate.** A test asserting the browser matcher's route is byte-identical (90 pts) and
  `git diff` shows `lib/routing_kernel/**` and `client/web_kernel.loft` unchanged.
  *Check:* green now (baseline, nothing built yet). *Probe:* **this is the design's falsifier** — it must
  stay green through S1–S12; the first step that reddens it has violated the invariant.

### Phase 1 — extract the data (routing pipeline untouched)
- **S1. Area use.** Second osmium pass → landuse/natural/leisure polygons for south-Overijssel into a new
  file; tags → `AreaUse`. *Check:* a known lake (`water`) and a known forest (`forest`) present with the
  right `use`. *Probe:* roads-pass output (way count) unchanged; **S0 green**.
- **S2. Place labels.** `place=*` nodes → `Label{point, kind, rank}`. *Check:* Oldenzaal (`town`), Lonneker
  (`village`) present with sensible rank.
- **S3. Street centerlines (option B).** `highway`+`name` → simplified polyline + name. *Check:* a known
  street carries its name and a line with far fewer points than the routing geometry, endpoints within the
  simplification tolerance.
- **S4. Buildings.** `building=*` → ring + optional name. *Check:* building count in a sample cell is sane;
  a named building (e.g. a church) carries its `name`.

### Phase 2 — store format + working-set keying
- **S5. Presentation store.** Encode Phase-1 features into `hash<PTile[tkey]>` reusing the routing tiling
  *mechanism* (grid-index, packed `tkey`, delta coords, resolver) but with the presentation's **own `CELL`**
  (a parameter), as its **own store file**, the mechanism **reimplemented** parametrically (not extracted
  from the frozen kernel), with a key packing that scales with `CELL`. *Check:* `store_verify` sound; decode
  round-trips the features; picking a different `CELL` than routing still round-trips (the mechanism is
  size-agnostic). *Probe (over-unification guard):* it is a separate file — grep proves the routing block
  still contains only roads; the two share the mechanism + snapshot stamp, nothing else.
- **S6. Working-set load.** Viewport bbox → `tkey` range → `store_load_keys` only those cells (loft#522).
  *Check:* features returned == a full-decode of the same bbox. *Probe:* log **bytes fetched ≪ whole store**
  (the countable working-set assertion), via `LOFT_LOADER_STATS`.
  **✓ DONE (`client/basemap/load_working_set.loft`):** the load-bearing uncertainty is resolved —
  `store_load_keys` **works on our full `PTile` schema** (`vector<struct>` entries; loft#522's relocation
  handles it). Correctness holds at both store sizes: a 2-cell viewport partial-loads exactly the same
  tiles/areas as a full-decode of that bbox. Bytes: a 2-cell viewport fetches 131 KB of a 300 KB store
  (44%) but only 327 KB of a 1.6 MB store (20%) — the **fraction shrinks as the store grows**, the
  working-set property. It is not a dramatic `≪` at test scale because (a) 64 KB page granularity and (b)
  a cell's heap children (rings) are scattered across the arena, so gathering a cell touches several pages.
  A store *layout* that clusters a cell's heap near its record would tighten the fetch — a loft store-engine
  concern (loft#522 layout), not ours. At country scale (viewport = tiny fraction of a large store) the `≪`
  is realized; the mechanism is proven.

## S5 in detail — the presentation store (design before code)

S5 is load-bearing (a data format + a mechanism), so it gets a written falsifier first. **The real risk
is not the grid — it is whether loft's store engine round-trips a schema *deeper* than the routing block.**
`TTile` is a hash of a struct with vectors of *flat* structs (`steps: vector<TStep{i32,i32,i32}>`,
`roads: vector<TRoad{u8,u8,u8}>`). The presentation schema wants a hash of a struct with **vectors of
structs that each hold a `text` field and a nested `vector<Coord>`** — one level deeper, with heap text.
Whether `store_persist_bind` + whole-file `store_load` + `store_verify` survive that is a *claim*, and the
arc-G note that per-element `vector<struct>` relocation is deferred (loft#522 phase 3b.4b) is about the
PARTIAL path (S6), not whole-file load. Cheapest way to know: build the smallest store of exactly that
shape and round-trip it — **before** writing any encoder.

### Schema (loft) — nested form (tried first)
```
struct Coord    { x: i32, y: i32 }                       // fixed-point (1e-7°) delta from tile origin
struct Area     { cover: text, ring: vector<Coord> }     // `use` is a loft keyword → field named `cover`
struct Building { name: text, ring: vector<Coord> }      // name "" when absent (defer text? until S5.0 says)
struct Label    { name: text, kind: text, rank: integer, line: vector<Coord> }
struct PTile    { tkey: integer, ox: integer, oy: integer,
                  areas: vector<Area>, buildings: vector<Building>, labels: vector<Label> }
// store: hash<PTile[tkey]>
```

### Parametric grid — reimplemented, size is a parameter
```
cell_ix(fixed, CELL) = fixed / CELL            // floor to the grid
origin(tx, CELL)     = tx * CELL
tkey(tx, ty, CELL)   = (ty + BIAS) * MULT(CELL) + (tx + BIAS)
```
`MULT(CELL)` must exceed the world's `|tx|` span at that `CELL` (lon span 3.6e9 fixed units / `CELL`);
routing's `1e6` is only correct because `CELL = 200000`. `BIAS` offsets negative `tx/ty` (other
hemispheres) so keys stay positive and non-colliding — routing never hit this (all-positive NL); the
mechanism must, to "still work" at any size/place.

### Sub-steps — each `Do → Check → Probe`

- **S5.0 — schema round-trip probe (the falsifier; build FIRST, throwaway).** A tiny loft program builds a
  synthetic `hash<PTile[tkey]>` (2 tiles; each a couple of areas/buildings/labels, 3–4 Coords + a text
  name), `store_persist_bind` → fresh `store_load` → `store_verify` → count every nested feature back.
  *Check:* counts in == out, `store_verify` true. *Probe (load-bearing):* this is the falsifier for "the
  engine handles the nesting + heap text." **If it fails, FLATTEN the schema (below) and re-probe — before
  the encoder,** not after.
  **✓ DONE (`client/basemap/store_probe.loft`):** the falsifier did NOT falsify — the nested schema
  round-trips byte-faithfully (2 tiles / 3 areas / 2 buildings / 2 labels / 19 coords in == out,
  `store_verify` true, incl. an empty-string name). **The nested schema stands; the flatten fallback is
  not needed.** Findings: `use` is a loft keyword → `Area.cover`; `store_persist_bind` also works under
  `--interpret`, not only native.
- **S5.1 — parametric grid (`client/basemap/grid.loft`).** `cell_ix` / `origin` / `tkey(CELL)` with
  `MULT` derived from `CELL` + a hemisphere `BIAS`. *Check:* a known lat/lon → expected cell; origin+delta
  reconstructs the coord within 1 unit. *Probe:* at a fine `CELL` (≈100 m) two adjacent cells get distinct
  keys — routing's `1e6` packing would collide there; ours must not.
- **S5.2 — encoder (areas first).** Read the areas fixture → bin each ring into its cell's `PTile.areas` at
  the presentation `CELL`. *Check:* tiles > 0; areas binned == input count; a known water polygon lands in
  the expected cell.
- **S5.3 — persist + load + verify (real areas).** `store_persist_bind` → `store_load` fresh →
  `store_verify` → area count round-trips. *Check:* counts equal, verify true. *Probe:* its own file path;
  routing block untouched.
- **S5.4 — size-agnostic.** Build + round-trip at `CELL = 200000` **and** a finer `CELL` (≈50000). *Check:*
  both round-trip; finer `CELL` ⇒ strictly more tiles (the mechanism isn't tied to routing's size).
- **S5.5 — all feature types.** Extend the encoder to buildings + labels (place = 1-Coord line; street =
  S3's simplified centerline). *Check:* all four types round-trip, `store_verify` sound, a named building +
  a town label survive.
- **S5.6 — isolation.** *Check:* **S0 gate PASS**; grep the routing block still roads-only; the presentation
  store is a distinct file.
  **✓ DONE:** `tools/basemap_isolation_gate.sh` now checks isolation on both axes — runtime (route
  byte-identical + frozen sources) AND structural (routing never imports `basemap`, `basemap` never imports
  the frozen `routing_kernel` — it reimplements the grid — and routing carries no presentation types). The
  presentation store is its own `out.store`; routing writes `*.tiles`. **Phase 2 complete (S5.0–S5.6).**

### Fallback if S5.0 falsifies the nested schema (decided by the probe, not guessed)
Flatten to mirror `TTile` exactly — one flat coord pool per tile + count-prefixed headers (the shape the
routing block already proves the engine persists):
```
struct PTile { tkey, ox, oy,
  coords: vector<Coord>,                                  // one flat pool for the whole tile
  areas: vector<AreaHdr>,      // AreaHdr{ use: text, n: integer }       → next n coords in the pool
  buildings: vector<BldHdr>,   // BldHdr{ name: text, n: integer }
  labels: vector<LblHdr> }     // LblHdr{ name: text, kind: text, rank: integer, n: integer }
```
One level shallower (vectors of flat structs + a shared pool). If even heap `text` in a persisted struct is
the problem, intern strings into a per-tile `vector<text>` and store indices. **Pick nested / flat / interned
at S5.0 from the probe result.**

### Phase 3 — render (Leaflet canvas, drawn under the route)
- **S7. Areas.** Filled polygons coloured by `AreaUse`. *Check:* screenshot shows terrain fills (forest
  green, water blue) beneath the road network.
  **✓ DONE:** classification stays in loft (`client/basemap/emit_areas.loft` → `browser/areas.txt`, built by
  `build.mjs`); the browser draws 668 filled polygons coloured per cover. It's a **selectable base layer** —
  the map now offers "OpenStreetMap" (rich, online) or "Terrain (our data)" (self-contained, no tiles). The
  headless-Chromium screenshot on the terrain base shows our forest/grass/water fills + road network + route
  with **no OSM tiles**; the gate reports `terrain: 668 area fills drawn`. S0 green. (Coverage is the
  southern sample region; full coverage is a data step.)
- **S8. Buildings.** Filled footprints. *Check:* screenshot shows building blocks in a town.
  **✓ DONE:** `client/basemap/emit_buildings.loft` → `browser/buildings.txt` (built by `build.mjs`); the
  browser draws 647 footprints (tan fill) in a pane above the terrain, below the network. Screenshot on the
  terrain base, zoomed to the town, shows the building cluster (Lonneker) with terrain fills + network +
  route and **no OSM tiles**; gate reports `buildings: 647 footprints drawn`. S0 green.
- **S9. Place labels.** Text sized/shown by `rank`. *Check:* town names appear; hamlets hidden when zoomed
  out.
  **✓ DONE:** `client/basemap/emit_places.loft` → `browser/places.txt` (`rank;name;lat,lon`); the browser
  draws halo'd text labels sized by rank, and gates visibility by zoom (`RANK_MINZOOM`). Verified headless:
  at z12 only `Oldenzaal` (town) + `Lonneker` (village) show; at z15 all 12 (incl. hamlets/localities)
  appear — the exact "hamlets hidden when zoomed out" behaviour, measured (2 → 12 labels). S0 green.
- **S10. Street labels + repetition.** Name drawn along the centerline, **repeated at intervals when zoomed
  in**. *Check/Probe:* a long street shows **1** label at low zoom and **N>1** at high zoom, following the
  road angle (this is the "multiply the name" behaviour, directly measurable).

### Phase 4 — integrate + prove isolation
- **S11. Wire it in.** Presentation layer under the route in `index.html`; OSM raster kept as an optional
  layer; `standalone.html` carries its own presentation data too. *Check:* both browser gates still PASS
  (route byte-identical). *Probe:* **S0 green**; a **side-by-side screenshot vs afstandmeten.nl** for the
  same bbox — does it read as "near their presentation"?
- **S12. Freshness.** Stamp both stores with the same OSM snapshot; footer shows "data as of …" from the
  presentation stamp. *Check:* the date renders.

### Phase 5 — scale (later; the two DIY hard parts — sequenced, not blocking the single-region proof)
- **S13. Per-zoom generalization.** Buildings only ≥ z14; areas simplified at low zoom; label rank
  thresholds. *Check:* feature/byte counts drop at low zoom, visual holds. *(This is where a DIY format
  earns its keep or where PMTiles tooling would take over — decide at S13, not before.)*
- **S14. Label collision.** No overlapping text. *Check:* no overlaps in a dense-town screenshot.

## The probes that gate the whole design (summary)

| claim | probe | step |
|---|---|---|
| **isolation** (load-bearing) | route byte-identical + kernel files untouched | S0, re-run each phase |
| separate stores, not merged | routing block still roads-only | S5 |
| working-set, not whole-file | bytes fetched ≪ store size | S6 |
| street-label repetition | label count grows with zoom (1 → N) | S10 |
| "near their presentation" | side-by-side screenshot vs afstandmeten | S11 |

## Notes
- **Phase 1–2 are buildable/verifiable headless now** (pipeline + store, no browser). Phase 3–4 need the
  browser gate (chromium). Phase 5 is deferred until one region looks right.
- **DIY vs tooling:** we build our own format (in-ethos, reuses the loft#522 range-read spine). The two
  things vector-tile tooling gives for free — per-zoom generalization (S13) and label collision (S14) — are
  explicitly *ours* to handle, sequenced last so they never block the first working region.
