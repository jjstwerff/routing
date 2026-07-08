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

```
struct Area     { use: AreaUse, ring: vector<Coord> }          // landcover/landuse polygon (filled)
struct Building { ring: vector<Coord>, name: text? }            // footprint; name optional (POI buildings)
struct Label    { name: text, kind: LabelKind, rank: integer,  // place labels + street labels
                  line: vector<Coord> }                         // street: simplified centerline (option B);
                                                                //   place: a single point (line of length 1)
struct PTile    { tkey: integer, areas: vector<Area>,
                  buildings: vector<Building>, labels: vector<Label> }
```

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
- **S5. Presentation store.** Encode Phase-1 features into `hash<PTile[tkey]>` reusing the **routing cell
  grid**. *Check:* `store_verify` sound; decode round-trips the features. *Probe (over-unification guard):*
  it is a **separate** store file from the routing block — grep proves the routing block still contains only
  roads; the two share the grid + snapshot stamp, nothing else.
- **S6. Working-set load.** Viewport bbox → `tkey` range → `store_load_keys` only those cells (loft#522).
  *Check:* features returned == a full-decode of the same bbox. *Probe:* log **bytes fetched ≪ whole store**
  (the countable working-set assertion), via `LOFT_LOADER_STATS`.

### Phase 3 — render (Leaflet canvas, drawn under the route)
- **S7. Areas.** Filled polygons coloured by `AreaUse`. *Check:* screenshot shows terrain fills (forest
  green, water blue) beneath the road network.
- **S8. Buildings.** Filled footprints. *Check:* screenshot shows building blocks in a town.
- **S9. Place labels.** Text sized/shown by `rank`. *Check:* town names appear; hamlets hidden when zoomed
  out.
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
