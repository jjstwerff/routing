<!-- Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later -->
# PLAN-MAP — our own map renderer (drop Leaflet), whole-Enschede base map

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

## 5. Steps (ordered, falsifier-first — each has a Build and a Check)

> M0 is the cheapest falsifier: prove `project`/`unproject` and one `render()` on a *known* point before any
> data or interaction. Everything after is "mutate camera → render" or "draw one more layer."

### M0 — Canvas + camera + projection  *(the invariant probe)*
- **Build.** A full-bleed `<canvas>`; `camera{centerLat,centerLon,zoom}`; Web-Mercator `project`/`unproject`
  (HiDPI-aware); one `render()` that plots a few known lat/lons as dots.
- **Check.** `project` a known place (e.g. Enschede centre) lands at the expected pixel; `unproject(project(p))
  ≈ p` to < 1e-6°; a resize keeps the centre centred.

### M1 — Pan (left-drag) + zoom (wheel), cursor-anchored
- **Build.** `mousedown`+`mousemove`+`mouseup` → pan by keeping the grabbed lat/lon under the cursor;
  `wheel` → change `zoom` while holding `unproject(cursor)` fixed. Each updates `camera`, requests `render`.
- **Check.** Headless (CDP): the lat/lon under the cursor is invariant across a drag and across a wheel tick
  (the two properties from §2); no other state changes.

### M2 — Terrain fills (areas)
- **Build.** Draw area rings as filled canvas paths, coloured by `AreaUse` (`COVER_COLORS`), back-most layer.
- **Check.** The region's terrain renders; polygon count == the emitted area count; visually matches today's
  Leaflet terrain for an overlapping view.

### M3 — Generic primitive renderer + catalog v1 (buildings, streets, labels)
- **Build.** One canvas draw per **primitive** — filled `Area` (by cover), `Building` footprint, stroked
  `Line`, `Poi` symbol, `Label` — dispatched by the §4b **catalog** (`class → style, minZoom`). v1 catalog =
  the classes we already classify (areas / buildings / streets / places). Port S13 generalization + S14
  label collision to canvas.
- **Check.** Every v1 catalog class renders with its style; buildings ≥ z14; small areas drop when zoomed
  out; no two labels overlap; street labels repeat as you zoom in.

### M3b — Enrich the catalog: Lines + POIs (streams, crossings, trees, the full palette)
- **Build.** Extend `fetch.sh` to pull `Line` ways (waterway / railway / barrier) and node **POIs**
  (natural=tree, amenity=bench/parking/drinking_water, tourism=viewpoint/camp_site, man_made=tower,
  leisure=playground, historic=ruins/monument, highway=crossing, …); add `line_kind`/`poi_kind` classifiers
  + emitters (PLAN-BASEMAP S5.5b); add catalog rows + `Poi` glyphs. **Richness = catalog rows, not renderer
  changes.**
- **Check.** Streams/rivers stroke as lines; POIs draw as zoom-gated symbols (towers/viewpoints mid-zoom,
  trees/benches high-zoom); adding one more feature type is a single catalog row (+ one glyph if new), with
  no change to `render()` or the seam.

### M4 — Whole-region working set
- **Build.** Fetch the Enschede bbox (§4), build the `PTile` store, load visible tiles on camera-settle via
  `store_load_keys`; evict off-screen tiles.
- **Check.** Panning across Enschede loads tiles incrementally; the bytes/features held track the viewport,
  not the region; every part of the region is reachable and draws.

### M5 — Full-bleed interface, Leaflet removed, gates
- **Build.** Port the original full-bleed shell (`styles.css`, viewport meta); delete `vendor/leaflet/` and
  every `L.*` reference; a minimal HUD (attribution + "data as of" S12). Rebuild standalone; extend the CDP
  gate to render + pan/zoom the region headlessly.
- **Check.** `grep -r 'leaflet\|L\.' browser/` is empty; the app is a full-viewport canvas; standalone builds
  and the headless gate pans/zooms and draws the region; `basemap_isolation_gate.sh` still PASS.

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
