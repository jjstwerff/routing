<!-- Copyright (c) 2026 Jurjen Stellingwerff  SPDX-License-Identifier: LGPL-3.0-or-later -->
# PLAN-BUILD — the new build: loft-wasm compute + canvas render, from two stores

The integrating design for the rebuilt app. It ties together **PLAN-STORE** (the two binary stores),
**PLAN-MAP** (the canvas renderer), and **PLAN-EDIT** (the rough-sketch primitives), and adds the piece
that closes the loop: **loft computes the matched route and hands it to JS to draw.** This restores the
original DESIGN.md §2 division — **JS does pixels, loft does routes** — on the store + canvas foundation.

## The division of labour

| | **loft (compiled to wasm)** | **JS (canvas)** |
|---|---|---|
| Owns | decode `layout.store` + `roads.store`; **build the match graph** from `roads.store`; **map-match the rough sketch → the actual route**; emit everything as text | the full-bleed canvas; draw base map + **rough sketch** + **matched route**; the **rough-sketch primitives** (place / drag / insert / remove, PLAN-EDIT); pan/zoom; the wasm bridge |
| Never | draws pixels; owns interaction | invents a data format; computes a route; edits the matched line |

## Pipeline

```
OSM ──build (loft, offline)──▶ layout.store + roads.store ──served static on GitHub Pages──▶ browser
                                                                                                │
   fetch both stores (whole for now) ─────────────────────────────────────────────────────────┘
        │ bytes → host_input
        ▼
   loft-wasm KERNEL  (one loft program, compiled with `loft --html`)
     • store_load(layout) + store_load(roads)          → build the match graph from roads
     • cmd "view"           → emit base-map TEXT        (areas/buildings/roads/lines/pois/labels)
     • cmd "match <sketch>|<profile>" → emit ROUTE TEXT (loft computes the map-match against roads)
        │ text (println)               ▲  sketch + commands (host_input)
        ▼                              │
   JS: parse* → canvas render          │  rough-sketch edits re-issue "match"
     • base map (from view text)       │
     • rough sketch (JS owns it) ──────┘
     • matched route (from route text, READ-ONLY)
```

Text over loft's native `host_input`/`println` bridge for now; a **binary bridge** later (PLAN-STORE).

## Reuse — most routines already exist (don't reinvent)

The roads/routing half is largely built; this plan mostly *wires* it and adds the base-map `view`.

| Capability | Already exists | Reuse for |
|---|---|---|
| **Roads store** (binary) | the **PLAN-TILES `.tiles` store** — `TTile`/`TRoad`/`TStep`, built by the native tile generator; `soverijssel.tiles` | `roads.store` (B0-roads is *regenerate for the region*, not new) |
| **Read roads → ways** | `routing_kernel::tiles_corridor_ways(tstore, sketch, margin)` | B2 (route), map-draw roads |
| **Match** | `routing_kernel::build_graph`, `match_route_closed` / `match_closed_ex`, `match_incremental` / `match_state_*`, `path_length_m` | B2, B6 |
| **Match orchestration** | `server/server.loft` `match_for` — already matches from the `.tiles` store (Overpass fallback) | B3 (kernel logic mirrors this, minus the WS transport) |
| **Browser kernel** (host_input/println) | `client/web_kernel.loft` (currently `parse_ways`(JSON) → switch to the tiles store) + `client/app_kernel.loft` (file+args) | B3/B4 template |
| **Layout store** (binary) | PLAN-BASEMAP **`PTile`** + `client/basemap/build_store.loft` | `layout.store` (B0-layout: extend to lines/POIs + region) |
| **GPX / elevation / DP / clean-track** | `routing_kernel` (`gpx_export`, `elev_at_points`, `douglas_peucker`, `clean_track`) | later PLAN-EDIT tracks |

**Genuinely new:** the base-map **`view`** (read `PTile` `layout.store` → the layer text) and folding
`view` + `match` into **one** kernel loading **both** stores.

## The two stores (PLAN-STORE)

- **`layout.store`** — PLAN-BASEMAP **`PTile`**: terrain `Area`s, `Building`s (+name), water/rail/barrier
  `Line`s, `Poi`s, place `Label`s. Built by `build_store.loft` (extend to lines/POIs; run over the region).
- **`roads.store`** — the existing PLAN-TILES **`.tiles`** (`TTile`) store: routable ways with
  routing-relevant attributes + geometry. It is **both** what the map draws roads from **and** the graph
  loft matches against (`tiles_corridor_ways` → `build_graph`). Sharded per region → country later; partial
  (`store_load_keys`/`range`) later. **The generator already exists** (PLAN-TILES Phase B) — B0 regenerates
  it for the bigger Enschede bbox.

## The kernel protocol (host_input → println)

One loft program (`client/basemap_kernel.loft`, say), instantiated once. Commands in over `host_input`,
typed text out over `println`:

| In (`host_input`) | Out (`println`) |
|---|---|
| `store layout <bytes>` / `store roads <bytes>` | `ok layout` / `ok roads` (+ builds the graph on roads) |
| `view` (whole for now; `view <bbox> <zoom>` later) | base-map lines, layer-tagged: `A …` area · `B …` building · `R …` road · `L …` line · `P …` poi · `N …` place-label |
| `match <lat,lon;…>\|<profile>` | `ROUTE <lat,lon;…>` + `SUMMARY <ways/len/…>` |

The base-map line formats are exactly today's `emit_*.loft` text, so the renderer parses them unchanged;
`match` reuses `lib/routing_kernel` (the same matcher the server/CLI use), now fed from `roads.store`.

## Invariants

1. **One on-disk format (the loft store), one reader/writer (loft).** The browser invents nothing; it
   renders `parse(loft_emit(store))` (PLAN-STORE).
2. **The rough sketch is the only editable geometry.** JS owns it; every committed edit re-issues `match`;
   the **matched route is read-only** (DESIGN.md §1 — correct a wrong match by moving rough points, never
   the line).
3. **Routes are plotted from `roads.store`.** The bytes drawn as roads are the bytes matched against — no
   second road representation.

## Steps (falsifier-first — each verifies before the next)

- **B0 — Two stores over the region.** *roads*: **rerun the existing PLAN-TILES generator** for the
  Enschede bbox → `roads.store` (`.tiles`) — reuse, not new. *layout*: **extend `build_store.loft`** to
  lines/POIs (+ carry building names) and run it → `layout.store` (`PTile`). *Check:* both persist → load →
  every count round-trips; A1 present in roads (by `ref`); a named building present in layout.
- **B1 — Layout store → base-map text (loft, native) — the new bit.** Read `layout.store` (`PTile`) and
  `roads.store` (`TTile`) → emit the layer text. *Check:* byte-identical to the `emit_*.loft` output for the
  same data (renderer unchanged).
- **B2 — Route from `roads.store` (reuse) ✓.** `tiles_corridor_ways(roads, sketch, margin)` →
  `build_graph` → `match_route` — the path `server.loft` `match_for` runs. *Verified:* from a
  `.tiles` built off the routing fixture, the demo trace's corridor has the **same 472 ways** as the raw
  fixture and the route matches the raw-data route **to within 0.4 %** (10 606 vs 10 647 m; 94 vs 90 pts).
  It is *not* byte-identical to `routing_ref.txt` — that is a **raw-Overpass** baseline, whereas the
  `.tiles` format is deliberately lossy (RoadType + flags + geometry; PLAN-TILES B.3), so the small
  difference is the intended encoding cost and the store route is the production-canonical one.
- **B3 — Unified kernel + protocol (loft, native).** One program = `web_kernel.loft`'s host_input/println
  shell + `match_for`'s logic + the B1 `view`; commands `store`/`view`/`match`. *Check:* a native driver
  reproduces B1's base-map text **and** B2's route.
- **B4 — Kernel → wasm (`loft --html`).** `web_kernel.loft` already compiles this way; extend + rebuild.
  *Check (headless):* fed the store bytes it emits the base-map text; fed a sketch it emits the route —
  equals native (B3). **Verifies store-load-from-bytes + routing both work in wasm.**
- **B5 — JS: render the base map.** `fetch` both stores → wasm `view` → text → canvas render. *Check:* the
  region draws; road classes / A1 / building names / curves / sparse labels all correct.
- **B6 — JS: rough sketch + live route.** Port the PLAN-EDIT primitives (place / drag / insert / remove) on
  the rough sketch; each committed edit → wasm `match` → route text → redraw; the matched line is
  read-only. *Check:* headless — place/drag/insert/remove all re-match; the route is byte-identical to
  native for a known sketch.
- **B7 — Serve.** Ship the two `.store` files + the wasm kernel + renderer on GitHub Pages. *Check:* the
  live app draws the region and matches a drawn route, **no server**.

## Folded-in render quality (recent feedback)

Road classes + **A1/ref** + Carto styling; **building names** (labelled at high zoom); **finer curves**
(DP 3 m); **walking paths** (footway/path/cycleway); **sparser street labels** (~420 px). All in the store
schema + kernel text + renderer.

## Deferred (recorded)

Partial/viewport store reads (`store_load_keys`/`range`); country **sharding**; the **binary wasm↔JS
bridge**; coarse **LOD** for zoomed-out views; multi-select/undo + GPX/elevation (later PLAN-EDIT tracks).

## Supersedes / references

This is the build of record. **PLAN-STORE** details the stores; **PLAN-MAP** the renderer + its seam;
**PLAN-EDIT** the rough primitives + the read-only-matched-line invariant; **PLAN-BASEMAP** the extraction/
classifiers. PLAN-MAP's M4/M5 JS-baked text tiles are retired in favour of the loft-wasm store reader here.
