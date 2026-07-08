<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# Browser base-map app (PLAN-MAP)

A **no-server, no-Leaflet, no-wasm** base-map viewer for the Enschede region, rendered on our **own HTML5
canvas**. It presents our own vector data — terrain, buildings, streets, place/street labels, water &
barrier lines, and POIs — styled to the OpenStreetMap standard (Carto) palette. Left-drag to pan, mouse
wheel to zoom. (Route drawing / matching is deferred to **PLAN-EDIT**, which will ride this renderer's seam.)

## Pieces

- **`map.mjs`** — the renderer (no dependencies): spherical Web-Mercator `project`/`unproject`, a `Camera`,
  a full-bleed HiDPI `<canvas>`, `render()` drawing z-order Area → Building → Line → Poi → Label with per-zoom
  generalization (S13) + collision-aware labels (S14), pan/wheel interaction, per-kind Carto styles
  (`COVER_COLORS`/`LINE_STYLES`/`POI_STYLES`), and the seam PLAN-EDIT builds on
  (`project`/`unproject`/`camera`/`onRender`/`hitTest`).
- **`tiles.mjs`** — the working set: on camera-settle, loads only the tiles overlapping the viewport from
  `tiles/`, evicts off-screen ones, and assembles the loaded features into the renderer (deduped). Data held
  tracks the **viewport, not the region**.
- **`index.html`** — the full-bleed app (RouteMap + TileLoader).
- **`bake_tiles.mjs`** — buckets the whole-region layer text (`*.txt`, emitted by `client/basemap/emit_*.loft`)
  into a static tile pyramid `tiles/<ty>_<tx>.json` + `index.json` (0.01° grid; features spanning cells are
  written to each; the client dedups by identical line).
- **`build-site.mjs`** — bakes the tiles and inlines `map.mjs`+`tiles.mjs` into a single `_site/index.html`
  (+ `tiles/`) for GitHub Pages (avoids `.mjs` MIME concerns; fewer requests).
- **`map-demo.html`** — the M0–M3b test harness over the committed crop samples (see the gate).

## Data pipeline

```
tools/basemap/fetch.sh <kind>   (Overpass → client/basemap/fixtures/real_stretch_<kind>.json)
client/basemap/emit_<kind>.loft (classify + DP-simplify → browser/<kind>.txt)   [needs loft]
browser/bake_tiles.mjs          (browser/*.txt → browser/tiles/)                [node only]
```
The layer `*.txt` are committed (the deploy source); the tile pyramid is regenerated (node) at build time.
The loft `PTile` store (PLAN-BASEMAP S6) remains the canonical working-set format for a future
wasm/HTTP-Range reader (see PLAN-MAP §7).

## Run

```sh
node browser/bake_tiles.mjs     # browser/*.txt → browser/tiles/
node browser/serve.mjs          # static server on :8099
# open http://127.0.0.1:8099/browser/index.html
```

## Test (headless)

`tools/map_render_gate.sh` runs the pure projection invariant (`map.test.mjs`, node) then a headless-Chromium
gate: `cdp_verify_map.mjs` proves M0–M3b (projection, pan/zoom, terrain, buildings/streets/labels, lines,
POIs) against `map-demo.html`, and — if `browser/tiles/` is baked — `cdp_verify_tiles.mjs` proves M4 (the
whole-region tiled working set) against `index.html`. Requires `chromium` + `node`.

## Deploy (GitHub Pages)

The `pages` + `deploy` jobs in `.github/workflows/ci.yml` run `node browser/build-site.mjs` → `_site/`
(node-only — no loft, no network) and publish on push to `main`.
