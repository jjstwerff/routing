<!-- Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later -->
# PLAN-MAP — our own map renderer (drop Leaflet), whole-Enschede base map

> **Status (2026-07-12): partly superseded by [PLAN-BUILD](PLAN-BUILD.md)** (the plan of record for the app).
> The **canvas renderer** here (`browser/map.mjs`, M0–M3) is **live** — the standalone store app draws with
> it. But **M4/M5's JS-baked text tiles** (`browser/*.txt` → `bake_tiles.mjs` → `tiles.mjs`) are **retired**:
> the browser now reads the loft stores directly via loft-wasm (`view <bbox>` → the same layer text → `map.mjs`).

**Goal.** Replace Leaflet with our **own canvas renderer** and present the **whole Enschede region** base
map (terrain, buildings, streets, place labels) in a **full-bleed** interface like the original app. This is
**presentation only** — no route drawing, no matching, no sketch editing (those return later via
[PLAN-EDIT](PLAN-EDIT.md), built on this renderer's seam).

**Why.** Leaflet is a third-party JS dependency that boxes us into a fixed north-up Mercator viewport and
owns the gesture model — a "rigid window" we want out of, and the last non-loft-native JS dep (cf. "retire
jco"). We already draw our own vectors and default to our own terrain base (`index.html:154`), so Leaflet's
tile engine is unused in the self-contained build. Its remaining value was interaction — and for now the
interaction we need is small (mouse pan + wheel zoom), so the replacement is bounded.

**Interaction scope (deliberately tiny for now).** Left-button **drag → pan**; **mouse-wheel → zoom toward
the cursor**. Nothing else: no pinch/touch, no inertia, no rotation/tilt, no double-click-zoom, no keyboard.
(Phone touch gestures are a later step once the renderer is proven — the design leaves room, see §6.)

---

## 0. What we reuse (don't reinvent)

- **Projection & geodesy:** `geo.js` (git `6ac2f45`) — Vincenty `geodesicMeters` + `formatDistance`. Web
  Mercator lat/lon↔world-pixel is standard math (below); the ellipsoidal distance stays in `geo.js`.
- **The original full-bleed shell:** `styles.css` (`6ac2f45`) — `html,body{height:100dvh;overflow:hidden}`,
  `#map{position:absolute;inset:0}`, phone-first viewport meta (`user-scalable=no, viewport-fit=cover`),
  safe-area insets. Port this; the map is the whole UI.
- **The base-map data pipeline (PLAN-BASEMAP):** `lib/basemap` (classifiers, parametric tile grid, DP
  simplification), `client/basemap/emit_*.loft` (fixture → per-layer text), and the **tiled store +
  working-set** (`store_load_keys`, S6) — the mechanism that makes a *whole region* tractable: load only the
  tiles in view, not the whole region.
- **Per-zoom generalization (S13)** and **label collision layout (S14)** — the algorithms port verbatim from
  `browser/index.html`; only their *host* changes (our canvas instead of Leaflet markers/panes).

---

## 1. The one principle — the screen is a pure function of (camera × base-map data)

One **camera** = `{ centerLat, centerLon, zoom }`. One **`project(lat,lon) → {x,y}`** (Web Mercator, camera
applied) used by *every* layer. One **`render()`** that clears the canvas and paints the layers back-to-front
(terrain → buildings → streets → place/street labels). Pan and wheel mutate **only the camera** and request a
render. The renderer reads **only** the base-map layers — never a route or sketch (there are none here).

*Corollary (the whole-region key):* because a feature is drawn iff `project()` puts it on-screen, the
renderer only ever needs the features **in view** — which is exactly what the working-set store delivers
(§4). Coverage (whole Enschede) is decoupled from what's loaded (one viewport).

*Second principle — richness is DATA, not code.* The renderer draws a **fixed, tiny set of primitives**
(filled `Area`, `Building` footprint, stroked `Line`, `Poi` symbol, `Label`). Every feature *type* is a
**row in a classification catalog** (§4b) mapping OSM tags → `{primitive, class, style, minZoom}`. So "as
many map features as possible" grows a **table**, while the renderer, the invariant, and the PLAN-EDIT seam
stay constant. This is why the five-primitive schema was widened up front in PLAN-BASEMAP — so the palette
can reach afstandmeten-level richness without touching the engine.

---

## 2. The invariant (Design Protocol 1) and its single chokepoint

**Invariant.** After any interaction, the pixels equal `render(camera, visibleData)` — a pure function.
`project` and its exact inverse `unproject` are the *only* coordinate bridge; pan/zoom are defined **in terms
of them** (pan: keep the grabbed lat/lon under the cursor; wheel: keep the cursor's lat/lon fixed while zoom
changes). So an untested case (zoom far out, pan across a tile seam, resize the window) is correct because it
re-runs the same `project`/`render`.

**Re-assertion-site count.** The failure this prevents: each layer inventing its own lat/lon→pixel transform,
so they drift apart on zoom (labels off their features, buildings off the terrain). Collapse to **one**
`project` (N→1): every layer calls it; there is no second transform. Pan/zoom correctness reduces to
"`unproject(mouse)` is invariant across the gesture," a single testable property (M1).

**Over-unification guard.** `project` is Web Mercator (map). `geodesicMeters` is the WGS84 ellipsoid
(true distance). They are **different families** — do not merge them: pixels use the spherical Mercator, any
distance readout uses `geo.js`. (No distance is shown in this presentation-only phase, but keep the seam
clean for PLAN-EDIT.)

**The seam PLAN-EDIT will ride.** Expose exactly: `project(lat,lon)`, `unproject(x,y)`, `camera`,
`onRender(cb)`, `hitTest(x,y)` (nearest drawn feature — unused now, defined for editing). PLAN-EDIT adds the
sketch/route as *another layer* + gestures on this seam; it never reaches into the renderer internals.

---

## 3. Failure paths (enumerated before code)

1. **Layer drift on zoom** — a layer uses its own transform → one `project`, no exceptions (§2).
2. **Pan/zoom slippage** — the map slides out from under the cursor → define both *as* `unproject`
   invariants; test them (M1).
3. **Wheel zoom not cursor-anchored** — zooming recenters on the screen middle, jarring → anchor on the
   cursor's lat/lon (M1 check).
4. **Redraw cost at whole-region scale** — drawing every building each frame janks → draw only the working
   set (in-view tiles) + S13 generalization; canvas, one path per fill class where possible.
5. **Standalone can't hold the whole region** — a city's buildings inlined would bloat the single file →
   *served* build streams tiles from the store; *standalone* inlines a **bounded sub-region** (documented
   limit), or a coarser LOD. Open question, §7.
6. **HiDPI blur** — canvas drawn at CSS pixels on a 2× display → scale the backing store by
   `devicePixelRatio`, draw in CSS px.
7. **Window resize / mobile chrome** — a fixed canvas size cuts off → size to `100dvh`, re-fit on
   `resize`.
8. **Tile seams** — features clipped at tile boundaries show gaps → store keeps whole features per tile
   (PLAN-BASEMAP already stores rings whole); draw with a viewport pad.
9. **Label overlap / thrash on pan** — labels recomputed every frame flicker → reuse the S14 collision pass,
   recompute on camera-settle (debounced), not mid-drag.

---

## 4. Whole-Enschede data path

- **Fetch the region.** `tools/basemap/fetch.sh <kind> <bbox>` already parameterises the bbox. Fetch the
  **Enschede municipality** box (≈ `52.17,6.82,52.28,6.98` — refine to the admin boundary) for all four
  kinds. This is much larger than today's `real_stretch` corridor → many more buildings/streets.
- **Build the tiled store, not one blob.** Run the emit/encode path (PLAN-BASEMAP S5) over the region into
  the `PTile` store keyed by the parametric grid. The store holds the *whole* region; the client never loads
  it whole.
- **Load the working set (S6).** On camera-settle, compute the visible tile keys and
  `store_load_keys(local, path, keys)` → decode → draw. Panning into new tiles loads incrementally; bytes
  scale with the **viewport**, not the region. This is the first real-scale exercise of S6.
- **Served vs. standalone.** Served: fetch tiles from the hosted store over HTTP range/whole-tile reads
  (ties into PLAN-APP working-set). Standalone: inline a bounded core (see §7). Both draw through the same
  renderer.

---

## 4b. Feature catalog — the "as many features as possible" engine

Five primitives (already the `PTile` schema, PLAN-BASEMAP): `Area` (fill), `Building` (footprint), `Line`
(stroke), `Poi` (point symbol), `Label` (text). The **catalog** maps OSM tags → `{primitive, class, style,
minZoom}`. Target palette — **extend freely; each addition is a row + (if new) one glyph**:

| Primitive | Classes (grow this list) | Render | minZoom band |
|---|---|---|---|
| **Area** | water / reservoir / basin · forest / wood · grass / meadow / heath / scrub · farmland / orchard / vineyard / allotments · park / garden / pitch / golf / cemetery · residential · industrial / commercial / retail · wetland / marsh · sand / beach / dune · bare / rock / quarry · **parking** · military | flat fill / class | big (water, forest) low → small (parking, pitch) high |
| **Building** | any `building=*` (later: tint church / school / civic) | footprint fill + stroke | ≥ z14 |
| **Line** | river · stream / ditch / drain · canal · railway / tram · hedge / tree_row · wall / fence · cliff / embankment · power line | stroke width / colour / dash per kind | rivers low → streams, hedges high |
| **Poi** | tree · bench · picnic_table · viewpoint · tower (observation / water) · drinking_water · playground · **parking** · camp_site · ruins · monument / memorial · peak · spring / fountain · shelter · information · gate / barrier · **crossing** (pedestrian / signals) · fire_hydrant | small glyph + white halo | landmarks (tower, viewpoint, peak, camp) mid → street furniture (tree, bench, hydrant) high |

- **Extraction** (`tools/basemap/fetch.sh`): add **node** queries (`out center`) across
  `natural` / `leisure` / `amenity` / `tourism` / `man_made` / `historic` / `barrier` / `highway=crossing`,
  and `waterway` / `railway` / `barrier` **ways** for `Line`s — over the whole-Enschede bbox (§4).
- **Classification** in `lib/basemap`: `area_use` exists; add `line_kind(tags)` and `poi_kind(tags)` +
  their emitters (the deferred PLAN-BASEMAP **S5.5b** `Line`/`Poi` encoders).
- **Per-class `minZoom` (S13)** keeps a zoomed-out view legible (towns, forests, water, rivers) and reveals
  detail (trees, benches, crossings) only when you zoom in — the afstandmeten feel.
- **Palette — follow OpenStreetMap standard (Carto).** Every `style` in the catalog matches the familiar
  **openstreetmap.org standard tile** look (the `openstreetmap-carto` colours) — fine and easy on the eyes,
  no bespoke scheme. The existing `COVER_COLORS` (`browser/index.html`) already track Carto (water
  `#a5c8e8` · forest `#a6d99a` · grass `#cfeca8` · park `#c6e2a6` · farmland `#eff0d6` · residential
  `#e6e1de` · industrial `#e6d5e2` · sand `#f5e7c0` · wetland `#bfd8d8` · bare `#e0dccb`); extend from
  there for new classes (rivers/water `#a5c8e8`, railway grey dashes, wood `#add19e`, building `#d9c7b0`
  on `#c6b8a5`, POIs the Carto icon hues). **Styling is a lookup against Carto**, not a per-feature call —
  so it stays consistent as the catalog grows.

## 4c. Modules & the two pipelines (concrete)

**Render pipeline — one new browser module `browser/map.js`** (replaces `vendor/leaflet/`; `build-standalone.mjs`
inlines it like it inlines Leaflet today):

| Piece | Responsibility |
|---|---|
| `mercator` | `project(lat,lon)→{x,y}` and `unproject(x,y)→{lat,lon}` — spherical Web-Mercator, `camera` + `devicePixelRatio` applied |
| `Camera` | `{centerLat, centerLon, zoom}`; the *only* mutable view state |
| `render(ctx, layers)` | clear → draw z-order **Area → Building → Line → Poi → Label**; viewport-cull; per-feature `minZoom` gate (S13); label collision (S14) |
| `drawArea / drawBuilding / drawLine / drawPoi / drawLabel` | the per-primitive canvas ops (fill / footprint / stroke / glyph / haloed text) |
| `catalog` | `class → {fill, stroke, width, dash, glyph, minZoom}` — values = OSM-Carto (§4b) |
| `glyphs` | a tiny canvas symbol per `Poi.kind` (tree, bench, viewpoint, tower, crossing…) |
| `interact` | left-drag pan + wheel zoom (cursor-anchored) → mutate `Camera` → `requestAnimationFrame(render)` |
| **seam** (for PLAN-EDIT) | exports `project`, `unproject`, `camera`, `onRender`, `hitTest` |

**Data pipeline — per layer, loft side → assets the browser reads:**
1. **Fetch** — `tools/basemap/fetch.sh <kind> <bbox>` (Overpass) → raw JSON, whole-Enschede bbox (§4).
2. **Classify + simplify** — `client/basemap/emit_<kind>.loft` via `lib/basemap` (`area_use`/`line_kind`/
   `poi_kind`/`place_rank`, DP `dp_mask`) → typed records.
3. **Encode → store** — `build_store.loft` packs records into `PTile` (tile-local `Coord` i32) in the
   parametric-grid `PTile` store — one store for the whole region.
4. **Load working set** — from the `Camera` viewport compute visible `tkey`s → `store_load_keys` → decode →
   in-memory `{areas, buildings, lines, pois, labels}` that `render()` draws.

**The renderer is source-agnostic:** M2/M3 feed it the existing per-layer `*.txt`; M4 swaps the source to the
working-set store — `render()` is unchanged. That decoupling is what lets us prove rendering early and scale
data late.

---

## 5. Concrete steps (falsifier-first — each names its layer + its rendering)

### Phase A — Render engine (no data)
**M0 — Canvas + Mercator + `render()`.** *Build:* `browser/map.js` — full-bleed `<canvas>` (backing store ×
`dpr`); `Camera`; `project`/`unproject`; a `render()` that plots given test lat/lons. *Check:*
`project(Enschede centre)` = the expected pixel; `unproject∘project ≈ id` (< 1e-6°); a resize keeps the
centre centred.

**M1 — Pan (left-drag) + wheel zoom.** *Build:* `interact` — `mousedown/move/up` pans by holding the grabbed
lat/lon under the cursor; `wheel` changes `zoom` holding `unproject(cursor)` fixed; each → `Camera` →
`render`. *Check (CDP):* the cursor's lat/lon is invariant across a drag and across a wheel tick (the two §2
properties); no other state changes.

### Phase B — One layer end-to-end (the pipeline falsifier)
**M2 — Areas (terrain).** *Data:* `fetch.sh areas` → `emit_areas.loft` (`area_use` + DP) → `areas.txt`
(existing path). *Render:* `drawArea` filled paths, Carto cover colours, back-most layer. *Check:* the
region's terrain renders on our canvas; polygon count == emitted; a view overlapping today's Leaflet terrain
looks the same. **This proves the whole render pipeline on one real layer before adding any other.**

### Phase C — Grow the layers (on the proven engine + pipeline)
**M3 — Buildings + streets + labels (catalog v1).** *Data:* existing `emit_buildings/streets/places` →
`*.txt`. *Render:* `drawBuilding` (fill+stroke, ≥ z14 S13), `drawLine` (street centrelines), `drawLabel`
(place labels rank-gated S9 + street labels repeated along the line S10) — all dispatched through the
`catalog`; port S13 generalization + S14 collision to canvas. *Check:* every v1 class renders per Carto;
buildings ≥ z14; small areas drop zoomed-out; no label overlap; street labels repeat on zoom.

**M3b — Lines + POIs (enrich the catalog).** *Data:* extend `fetch.sh` (node POIs across natural/leisure/
amenity/tourism/man_made/historic/barrier/`highway=crossing`; `waterway`/`railway`/`barrier` lines); add
`line_kind`/`poi_kind` in `lib/basemap`; new `emit_lines.loft`/`emit_pois.loft` → `lines.txt`/`pois.txt`
(the deferred PLAN-BASEMAP **S5.5b** encoders). *Render:* `drawLine` per kind (river/stream/railway dash…),
`drawPoi` glyph per kind + halo, minZoom-gated; add the catalog rows. *Check:* streams/rivers stroke; POIs
draw as zoom-gated symbols; **a new feature type is one catalog row (+ one glyph if new) — `render()` and the
seam are untouched.**

### Phase D — Whole region + finish
**M4 — Whole-Enschede working set.** *Data:* fetch the Enschede bbox for all kinds → `build_store.loft` →
the `PTile` store (whole region); the client loads only the visible `tkey`s → decode → the renderer's
`{…}`; evict off-screen tiles. **Decide the client-read here:** loft-wasm `store_load_keys` vs. baked static
per-tile files (§7). *Check:* panning across Enschede loads tiles incrementally; held features track the
viewport not the region; every part of the region draws.

**M5 — Full-bleed shell, drop Leaflet, gates.** *Build:* port the original full-bleed shell (`styles.css`,
viewport meta); delete `vendor/leaflet/` and every `L.*`; a minimal HUD (attribution + "data as of" S12);
rebuild standalone (inline `map.js` + assets); extend the CDP gate to render + pan + zoom the region
headlessly. *Check:* `grep -r 'leaflet\|L\.' browser/` is empty; the app is a full-viewport canvas;
standalone builds; the headless gate pans/zooms/draws; `basemap_isolation_gate.sh` still PASS.

---

## 6. Explicitly out of scope (do not build here)

Route drawing / sketch editing (→ [PLAN-EDIT](PLAN-EDIT.md), rides this seam), the matcher wasm + routing
dataset (not needed to present the map), touch/pinch gestures + inertia, rotation/tilt, GPX, elevation,
saved routes, undo. Keeping this phase presentation-only is what makes the renderer small and provable.

## 7. Open questions

- **Standalone coverage.** The whole region likely can't inline into one file at full detail. Options: inline
  a bounded core + a coarse whole-region LOD (the deferred PLAN-BASEMAP rough layer), or accept a smaller
  standalone region than the served app. Decide at M4.
- **Enschede extent.** Municipality admin boundary vs. a simple bbox — start with the bbox, tighten later.
- **Zoom model.** Continuous zoom (free scale) vs. snapped levels. Continuous is easy on canvas and avoids
  Leaflet's discrete-zoom rigidity — default to continuous.

## 8. Definition of done

A full-bleed, Leaflet-free canvas app that presents the whole Enschede base map (terrain/buildings/streets/
labels) with left-drag pan + wheel zoom, loading only the viewport's tiles from the store, routing/base-map
isolation intact — and exposing the `project/unproject/camera/hitTest` seam that PLAN-EDIT will build on.
