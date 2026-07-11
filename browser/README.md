<!-- SPDX-License-Identifier: LGPL-3.0-or-later -->
# Browser store app (PLAN-BUILD)

The **standalone, no-server** base-map + routing app for the Enschede region. It fetches the two loft
stores, runs the **loft-wasm kernel** for the visible viewport and the matched route, and renders on our
**own HTML5 canvas** — terrain, buildings, roads (by class), water/barrier lines, POIs, place/street
labels, styled to the OpenStreetMap Carto palette, plus the matched route. Left-drag to pan, wheel to zoom;
click to lay a rough sketch — from the second point it re-matches and draws the route (read-only). JS does
pixels, loft does the map/route (DESIGN §2). Supersedes PLAN-MAP's M4/M5 JS-baked text tiles.

## Pieces

- **`map.mjs`** — the renderer (no dependencies): Web-Mercator `project`/`unproject`, a camera, a HiDPI
  `<canvas>`, `render()` drawing Area → Building → road → Line → Poi → route → Label with per-zoom
  generalization + collision-aware labels, pan/wheel interaction, per-kind Carto styles. `parseView`
  demuxes the kernel's tagged `view` stream into the layers; `loadView`/`loadMatch`/`drawRoute` wire it up.
- **`store-app.mjs`** — the app: on load/pan runs `view <bbox>` for the viewport (a generous pad ⇒ small
  pans re-draw cached layers, not re-decode); on click runs `match` and draws the route.
- **`store-kernel.mjs`** — the host driver: loads the kernel wasm and exposes `runKernel(blob) → Promise<text>`,
  reusing the `loft --html` `AsyncifyCtrl` + `loft_io` imports so `store_load_url`'s fetch bridges to JS
  `fetch()`. `loft_start` rebuilds state each call → every view/match is one request.
- **`index.html`** — the full-bleed app (a `<canvas>` + `store-app.mjs`).
- **`store-kernel.wasm`** — the loft-wasm base-map kernel (`client/web_basemap_kernel.loft` → `loft --html`,
  the embedded wasm extracted). Committed as the deploy artifact; regenerate with `build-store-kernel.mjs`.
- **`stores/`** — the two binary loft stores (`enschede.layout.store` = `PTile`; `enschede.roads.store` =
  `TTile`), served static so the app can fetch + read them. Regenerate via `build_store.loft` / `gen-tiles.loft`.
- **`build-site.mjs`** — inlines `map.mjs` + `store-kernel.mjs` + `store-app.mjs` into one `_site/index.html`
  (avoids `.mjs` MIME concerns) and copies the wasm + stores.
- **`map.test.mjs`** — the pure projection / pan-zoom invariant (node, DOM-free).

## Run

```sh
node browser/build-store-kernel.mjs   # regenerate store-kernel.wasm (needs loft)
node browser/serve.mjs                # static server on :8099 (correct .wasm MIME)
# open http://127.0.0.1:8099/browser/   (root → the app)
```

## Test (headless)

`tools/map_render_gate.sh` runs the projection invariant (`map.test.mjs`, node), builds `_site`, then a
headless-Chromium gate (`cdp_verify_store.mjs`): `view <bbox>` renders the region on load and a `match`
draws the route — the app served over HTTP (it fetches its stores by URL). Requires `chromium`, `node`,
`python3`, and `browser/store-kernel.wasm`.

## Deploy (GitHub Pages)

The `pages` + `deploy` jobs in `.github/workflows/ci.yml` run `node browser/build-site.mjs` → `_site/`
(node-only — no loft, no network) and publish on push to `main`.
